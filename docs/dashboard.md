# Agent dashboard

The staff UI for organizations lives at **`/dashboard.html`** on your deployed
client origin (dev: `http://localhost:5173/dashboard.html`). It is a separate
Vite entry — the private chat app at `/` is untouched.

## Getting started

1. **Create your organization** — open `/dashboard.html#/register`, pick a
   name, a slug (used by the widget), and the **conversation privacy mode**:
   - **Managed** (recommended for stores): conversations are stored on your
     server; the whole team shares the inbox and full history.
   - **End-to-end encrypted**: the server relays and stores ciphertext only;
     each agent holds their own keys in their browser.
   The mode locks once the org has conversations.
2. **Invite your team** — Settings → Team → *Invite an agent*. Copy the
   single-use link (valid 7 days) and send it over any channel; no email
   server needed. Admins manage staff/keys/settings; agents work the inbox.
3. **Connect your store** — Settings → API keys → *Create key*, then follow
   [`integrations.md`](integrations.md) to sign chat tokens in your store's
   backend, or just embed the widget for anonymous visitor chat (see
   [`embedding.md`](embedding.md) once the widget ships).

## Working the inbox

- **Filters**: *Unassigned* (the new-conversation queue), *Mine*, *All open*,
  *Closed*. The list live-updates via an org-wide event socket.
- Open a conversation to chat. The header shows the customer's presence and
  any listing context the store attached (C2C conversations show what the
  buyer/seller are talking about, with a link).
- **Assign to me** claims a conversation; **Close/Reopen** manages its
  lifecycle (customers can't post into a closed conversation).

## E2E-mode notes

- On first sign-in in a browser, the dashboard generates an agent keypair,
  stores it in that browser's localStorage, and publishes the public key so
  customers can seal messages to you.
- History is per-key: messages sealed before your key existed (or to a
  different browser's key) cannot be decrypted — that's the point of E2E.
  Undecryptable frames are dropped silently (fail closed).
- The localStorage keystore carries the same caveat as the private chat app
  (see SECURITY.md): device compromise/XSS exposes the key. A hardened
  keystore is on the roadmap.

## Architecture (for contributors)

| Piece | Where |
|---|---|
| Entry | `client/dashboard.html` → `client/src/dashboard/main.tsx` (HashRouter — no server rewrites needed) |
| State | `client/src/dashboard/useInboxStore.ts` (Zustand; REST + one conversation WS + one inbox WS) |
| API wrapper | `client/src/dashboard/api.ts` (credentials + `X-Requested-With` CSRF header) |
| Pages | `client/src/dashboard/pages/` — Login, Register, InviteAccept, Inbox, Conversation, Settings |
| Shared chat UI | `client/src/components/ChatLog.tsx` + `ChatInputBar.tsx` (presentational; also used by the private chat via `MessageList`/`Composer`) |
| E2E keys | `client/src/dashboard/agentIdentity.ts` (reuses `client/src/crypto/`) |

Message text renders through React text nodes only — no `innerHTML` anywhere
(covered by an XSS-inertness test in `dashboard.test.tsx`).
