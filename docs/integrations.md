# Integrating Whisper with your store or marketplace

Whisper supports two ways for a website to open chat conversations:

| Model | Who talks | How identity works |
|---|---|---|
| **Anonymous B2C** | site visitor ↔ your org's agents | Nothing to integrate: the widget mints a per-visitor secret automatically. |
| **Identified B2C / C2C** | logged-in customer ↔ agents, or buyer ↔ seller | **Your backend signs a short-lived token** telling Whisper who the user is and which conversation they may join. |

## API keys

An org admin creates signing keys in the dashboard (or via
`POST /api/org/api-keys`). Each key has:

- `kid` — public key id, goes in the token header
- `secret` — **shown exactly once**; store it in your backend's secret store.
  It must never reach a browser.

Rotate by creating a second key, switching your backend to it, then revoking
the old one (revoked keys fail verification immediately).

## Token format

A JWT signed with **HS256** using your key's `secret`, with header
`{ "alg": "HS256", "kid": "<your kid>" }` and claims:

| Claim | Required | Meaning |
|---|---|---|
| `sub` | ✓ | Your user id for the person (≤128 chars). Stable per user. |
| `conv` | ✓ | Conversation key (≤256 chars). **Both parties of a C2C thread must receive the exact same string** — it is the upsert key, unique per org. E.g. `listing:99:buyer:42`. |
| `exp` | ✓ | Expiry. **At most 10 minutes ahead** — longer-lived tokens are rejected. Mint a fresh token per page load. |
| `name` | — | Display name shown to the other side (≤64 chars). |
| `kind` | — | `"c2c"` (buyer↔seller) or `"b2c"` (customer↔your agents, default). |
| `ctx` | — | Small JSON object (≤2 KB) shown as conversation context, e.g. `{"listing":"Blue bike","url":"https://…"}`. First writer wins. |

The token is a *capability*: whoever holds it can join that one conversation
as that one user, for its short lifetime. Serve it to the logged-in user's
page over HTTPS only (e.g. an authenticated `GET /chat-token?listing=99`
endpoint on your backend).

### What Whisper enforces server-side

- Signature over your org's secret (`kid` → org lookup), algorithm pinned to
  HS256 (`alg: none` / RS256 confusion rejected).
- `exp` within 10 minutes (+60 s clock tolerance), key not revoked.
- The conversation is scoped to *your org only* — a token can never touch
  another tenant, and a widget configured for a different org rejects it.

## Signing examples

### Node.js (`jose`)

```js
import { SignJWT } from 'jose';

const secret = Buffer.from(process.env.WHISPER_KEY_SECRET, 'utf8');

export function chatToken({ userId, userName, conversationKey, kind, ctx }) {
  return new SignJWT({ sub: userId, name: userName, conv: conversationKey, kind, ctx })
    .setProtectedHeader({ alg: 'HS256', kid: process.env.WHISPER_KEY_ID })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(secret);
}
```

### Node.js (no dependencies)

```js
import { createHmac } from 'node:crypto';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

export function chatToken(claims, kid, secret) {
  const unsigned = `${b64({ alg: 'HS256', typ: 'JWT', kid })}.${b64({
    ...claims,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
  })}`;
  const sig = createHmac('sha256', secret).update(unsigned).digest('base64url');
  return `${unsigned}.${sig}`;
}
```

### PHP

```php
function chat_token(array $claims, string $kid, string $secret): string {
  $b64 = fn($d) => rtrim(strtr(base64_encode(json_encode($d)), '+/', '-_'), '=');
  $claims += ['iat' => time(), 'exp' => time() + 300];
  $unsigned = $b64(['alg' => 'HS256', 'typ' => 'JWT', 'kid' => $kid]) . '.' . $b64($claims);
  $sig = rtrim(strtr(base64_encode(hash_hmac('sha256', $unsigned, $secret, true)), '+/', '-_'), '=');
  return $unsigned . '.' . $sig;
}

// chat_token(['sub' => "buyer-42", 'name' => "Jane", 'conv' => "listing:99:buyer:42", 'kind' => "c2c"], $kid, $secret);
```

### Python

```python
import base64, hashlib, hmac, json, time

def _b64(data: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(data, separators=(",", ":")).encode()).rstrip(b"=").decode()

def chat_token(claims: dict, kid: str, secret: str) -> str:
    claims = {**claims, "iat": int(time.time()), "exp": int(time.time()) + 300}
    unsigned = f"{_b64({'alg': 'HS256', 'typ': 'JWT', 'kid': kid})}.{_b64(claims)}"
    sig = base64.urlsafe_b64encode(
        hmac.new(secret.encode(), unsigned.encode(), hashlib.sha256).digest()
    ).rstrip(b"=").decode()
    return f"{unsigned}.{sig}"
```

## REST endpoints the widget uses

You normally don't call these yourself — the embed script does (see
`docs/embedding.md` once the widget ships) — but they're public API:

### `POST /api/widget/session`
Anonymous visitor bootstrap. `{ "orgSlug": "acme-store" }` →
`201 { visitorId, visitorSecret, orgName, encryptionMode }`. Re-presenting a
`visitorSecret` revalidates it (`200`, no new secret).

### `POST /api/widget/conversations`
- With a token: `{ "token": "<jwt>", "orgSlug": "acme-store" }` — upserts the
  conversation by `conv` key, registers the caller as participant. →
  `200 { conversation, selfParticipantId }`
- Anonymous: `{ "orgSlug": "…", "visitorSecret": "…" }` — finds/creates the
  visitor's open conversation with your org.
- For E2E orgs pass `publicKey` (base64 X25519) so the other side can seal
  messages to you.

### `GET /api/widget/conversations/:id/messages`
Managed-mode history. Auth: `Authorization: Bearer <jwt>` **or**
`X-Visitor-Secret` + `X-Org: <slug>` headers. E2E conversations answer `409` —
their history flows only over the encrypted channel.

All widget routes have open CORS (no cookies involved) and per-IP rate limits.

## Choosing an encryption mode

- **managed** — Whisper's server (that *you* self-host) stores conversation
  plaintext. Enables the shared agent inbox, handoff, and history via REST.
  Right choice for most stores.
- **e2e** — conversations are end-to-end encrypted; the server relays and
  stores ciphertext only. Maximum privacy, but agents each hold their own
  keys and server-side features that need plaintext are unavailable.

The mode is chosen at org creation and locked once conversations exist.
