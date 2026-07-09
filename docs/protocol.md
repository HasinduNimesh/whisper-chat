# WebSocket wire protocol

One WS endpoint (`/signaling`, same server as the REST API) carries two
worlds; a socket belongs to at most one:

| World | Join frame | Content frames | Trust model |
|---|---|---|---|
| **Legacy private rooms** | `join` | `relay` (sealed), `signal` (WebRTC) | Server-blind: ciphertext only |
| **Org conversations** | `join-conversation` | `send` (managed) *or* `relay` (E2E), by the conversation's mode | Per-org choice, enforced per frame |

All frames are JSON text. Types live in `shared/src/index.ts` — the
authoritative reference, including the privacy invariant at the top.

## Cross-cutting limits

- 256 KiB max frame; per-socket token bucket (`MSG_BURST`/`MSG_REFILL_PER_SEC`),
  flooders are closed with code 1008.
- Per-IP connection cap (`MAX_CONNS_PER_IP`), browser `Origin` allow-list
  (`ALLOWED_ORIGINS`), 30 s ping/pong heartbeat.
- Errors: `{ "type": "error", "code": …, "message": … }` with codes
  `room-full | invalid-room | not-in-room | bad-request | unauthorized |
  wrong-mode | conversation-closed`.

## Legacy rooms (unchanged)

```
C→S  { type: "join", roomId, publicKey, displayName }
S→C  { type: "joined", selfId, roomId, members[], iceServers[], history[] }
S→C  { type: "peer-joined" | "peer-left", … }        (presence)
C→S  { type: "relay", to: <publicKey>, ciphertext, nonce, persist? }
S→C  { type: "deliver", from: <publicKey>, ciphertext, nonce }
C→S  { type: "signal", to: <peerId>, signal }         (WebRTC SDP/ICE)
C→S  { type: "leave" }
```

Room ids starting with `conv:` are **reserved** and rejected
(`invalid-room`) — that namespace belongs to conversations.

## Org conversations

Conversations are created via REST (`docs/api.md`, `docs/integrations.md`);
the socket then joins one:

```
C→S  { type: "join-conversation", conversationId, auth, publicKey? }
```

`auth` is one of:

| kind | Fields | Who |
|---|---|---|
| `session` | — (session cookie already on the WS upgrade request) | dashboard staff |
| `visitor` | `orgSlug`, `secret` | anonymous B2C widget |
| `org-token` | `token` (store-signed JWT) | C2C / identified B2C |

Authorization rules (all failures answer a **uniform** `unauthorized` — a
prober can't distinguish "wrong secret" from "no such conversation"):

- `session`: any staff member of the conversation's org may join (that's the
  shared-inbox model); an agent participant row is upserted.
- `visitor`: the visitor must **already** be a participant (added by the REST
  create flow) — holding a visitor secret is not a license to wander.
- `org-token`: the token's `conv` claim must equal the conversation's
  external key — one token authorizes exactly one conversation.

`publicKey` (base64 X25519) is for E2E conversations, so peers can seal to
you; it's validated and stored on your participant row.

The answer:

```
S→C  { type: "conversation-joined", conversationId, selfParticipantId,
       conversation: { kind, encryption, status, context },
       participants: [{ participantId, kind, displayName, publicKey, online }],
       history?:    [ ConversationMessageEvent ],   // managed mode
       e2eHistory?: [ HistoryEntry ],               // E2E mode (ciphertext for our key)
       iceServers: [...] }
```

Presence changes stream as:

```
S→C  { type: "conversation-peer", conversationId, peer: { …, online } }
```

### Managed conversations (org chose server-readable)

```
C→S  { type: "send", text }                          (1–8192 chars)
S→C  { type: "message", conversationId, id, from: { participantId, kind,
       displayName }, text, sentAt }
```

- The sender receives the same `message` echo — that's the delivery ack, and
  its server-assigned `id` is stable for dedupe.
- Sends to a **closed** conversation fail with `conversation-closed`
  (status is re-checked per send; an agent can close mid-flight).
- Sealed `relay` frames here fail with `wrong-mode` — a conversation can
  never silently mix trust models.

### E2E conversations (org chose server-blind)

Exactly the legacy relay model, scoped to the conversation's participants:

```
C→S  { type: "relay", to: <participant publicKey>, ciphertext, nonce, persist? }
S→C  { type: "deliver", from: <publicKey>, ciphertext, nonce }
```

- `persist: true` stores the ciphertext per recipient; it replays as
  `e2eHistory` when that recipient rejoins with their key.
- Plaintext `send` frames fail with `wrong-mode`.
- The server never sees message content — same invariant as legacy rooms.

## Dashboard inbox subscription

Staff sockets can subscribe to org-wide activity (session cookie auth):

```
C→S  { type: "join-inbox" }
S→C  { type: "inbox-joined" }
S→C  { type: "inbox-event", event: "new-conversation" | "message", conversationId }
```

`inbox-event` is a hint, not a payload: the dashboard refetches
`GET /api/conversations` / the conversation's messages over REST. Message
content is never pushed to sockets that haven't joined the conversation.

## Not in v1

- WebRTC calls inside org conversations (`signal` remains legacy-room-only).
- Typing indicators in managed mode.
- Multi-node fan-out: live state (rooms, conversations, inbox subscriptions)
  is in-memory per process — run one server instance (documented limit).
