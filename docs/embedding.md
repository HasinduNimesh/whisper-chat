# Embedding the chat widget

One `<script>` tag adds a floating chat bubble to any website. The bubble
opens an **iframe served from your Whisper origin**, so the widget is fully
isolated from the host page — no style clashes, and the store page can never
read chat content or visitor credentials.

## Quick start (anonymous visitor chat, B2C)

```html
<script src="https://chat.example.com/embed.js"></script>
<script>
  var chat = WhisperChat.init({
    url: 'https://chat.example.com', // your self-hosted Whisper origin
    orgSlug: 'acme-store',           // dashboard → Settings
  });
</script>
```

That's everything. Visitors get a persistent anonymous identity (a secret in
the iframe's own storage — invisible to your page), their conversation lands
in your team's [dashboard inbox](dashboard.md), and history survives reloads.

## Identified customers & C2C marketplaces

Have your backend mint a short-lived signed token
([`integrations.md`](integrations.md)) and pass it at init — or later, when
the user logs in:

```html
<script>
  var chat = WhisperChat.init({
    url: 'https://chat.example.com',
    orgSlug: 'acme-market',
    token: '<jwt minted by your backend for this user + conversation>',
  });

  // e.g. after a login that happens without a page reload:
  // chat.identify('<fresh jwt>');
</script>
```

For **C2C** (buyer ↔ seller about a listing), mint tokens for both users with
the *same* `conv` claim — they land in the same conversation, and the `ctx`
claim (listing title/URL) shows up for both sides and your agents.

## JS API

`WhisperChat.init(config)` returns a handle:

| Member | Purpose |
|---|---|
| `open()` / `close()` / `toggle()` | Control the panel programmatically |
| `identify(token)` | Present or refresh a signed identity token |
| `on(event, cb)` | Events: `ready`, `open`, `close`, `unread` (count). Returns an unsubscribe function |
| `destroy()` | Remove the widget and all listeners from the page |

### Config

| Key | Required | Meaning |
|---|---|---|
| `url` | ✓ | Your Whisper web origin (serves `embed.js`, `widget.html`, `/api`, `/signaling`) |
| `orgSlug` | ✓ | Your organization's slug |
| `token` | — | Signed identity token (omit for anonymous visitor chat) |
| `theme.primaryColor` | — | Launcher/header accent (any CSS color) |
| `theme.position` | — | `'right'` (default) or `'left'` |
| `autoOpen` | — | Open the panel as soon as the widget is ready |

## Try it locally

1. `docker compose up -d --build` and create an org in the dashboard
   (`http://localhost:8080/dashboard.html`).
2. Edit `examples/store-demo.html` with your slug, serve it from anywhere
   (`python3 -m http.server 9000` in `examples/`), and open
   `http://localhost:9000/store-demo.html`.
3. Chat as the visitor; answer from the dashboard inbox.

## Security model

- **Isolation**: chat renders only inside the iframe. The host page interacts
  through a versioned postMessage protocol; message *content* never crosses
  the boundary.
- **Origin pinning, both directions**: the loader accepts messages only from
  your Whisper origin *and* its own iframe; the iframe accepts messages only
  from the embedding page's origin (baked into the URL by the loader) and
  replies only to it. No `postMessage('*')` anywhere.
- **Tokens never ride URLs** — they travel parent→iframe via postMessage, so
  they can't leak through referrers, history, or server logs.
- **Visitor secrets** live in the iframe origin's storage, which browsers
  partition per embedding site — the store page can't read them, and the same
  visitor gets separate identities on different stores.
- **Encryption mode follows your org**: managed conversations are readable by
  your self-hosted server (that's the shared-inbox feature); E2E orgs get a
  per-visitor keypair in the iframe and the server relays ciphertext only.
- `widget.html` is the *only* page your Whisper origin allows in iframes
  (`frame-ancestors *` there, `DENY` everywhere else); it is cookie-free, so
  embedding it carries no clickjacking/credential risk. Widget REST/WS
  endpoints are rate-limited per IP.
