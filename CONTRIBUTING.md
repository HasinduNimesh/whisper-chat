# Contributing to Whisper

Thanks for your interest in contributing! This document explains how the repo is
laid out, how to get a dev environment running, and the conventions we follow.

## Development setup

Requires **Node.js 20+** and npm 10+.

```bash
git clone <your-fork>
cd whisper
npm install          # installs all workspaces (npm workspaces monorepo)

npm run dev:server   # terminal 1 — signaling server on :8787
npm run dev:client   # terminal 2 — Vite dev server on :5173
```

Optional: point the server at Postgres for message-history features:

```bash
export DATABASE_URL=postgres://user:pass@localhost:5432/whisper
npm run dev:server
```

Everything works without a database — persistence-dependent features simply
degrade to in-memory behavior.

## Workspace layout

| Workspace | What it is |
|---|---|
| `shared/` | Protocol types shared by client and server. The **privacy invariant** is documented at the top of `shared/src/index.ts` — read it before touching the wire protocol. |
| `server/` | Node WebSocket signaling/relay server (`ws`), plus optional Postgres persistence (`server/src/db.ts`). No framework — plain `node:http`. |
| `client/` | React 18 + TypeScript + Vite + Tailwind + Zustand. All cryptography runs here (`client/src/crypto/`). |

## Branch & PR workflow

- `main` must always be green and shippable.
- One branch per task, named `feat/<topic>`, `fix/<topic>`, or `chore/<topic>`.
- Before opening a PR, make sure all of these pass locally:

```bash
npm run lint
npm run build
npm test
```

- Keep PRs focused: one logical change per PR, with docs updated in the same PR.
- New features need tests; security-sensitive code (crypto, auth, relay,
  validation) needs *thorough* tests including failure/rejection cases.

## Coding standards

- **TypeScript everywhere**, `strict` mode. No `any` unless unavoidable and
  commented.
- Formatting is enforced by Prettier (`npm run format`) and linting by ESLint
  (`npm run lint`) — CI fails on either.
- Match the style of the file you are editing (comment density, naming, idiom).
- Comments explain *constraints and why*, not what the next line does.

## Security expectations

This is a privacy-focused project. When contributing, keep these invariants:

1. **The server must never see plaintext for E2E rooms.** Any user-content
   field on the wire must be sealed client-side first (see
   `shared/src/index.ts`). If your change would violate this, stop and open an
   issue first.
2. **Validate at the boundary.** All input from sockets/HTTP is untrusted —
   length-check, type-check, and reject early (see `isValidPublicKey` and the
   rate limiters in `server/src/index.ts` for the house style).
3. **Parameterized SQL only** — never interpolate values into query strings.
4. **No secrets in the client bundle.** Anything in `client/`, `widget/`
   (and any `VITE_*` var) ships to every browser.
5. **Tenant isolation lives in SQL.** Every query touching org-scoped tables
   must carry an `org_id` predicate (repos take `orgId` as their first
   parameter) — never filter cross-tenant data in JS. Add a cross-org
   blindness assertion to the integration tests for any new query.
6. Found a vulnerability? Follow [`SECURITY.md`](SECURITY.md) — please don't
   open a public issue for it.

## Tests

```bash
npm test                 # all workspaces with tests
npm test --workspace=client
```

Tests are Vitest. Client tests live next to the code they cover
(`client/src/crypto/crypto.test.ts`, `client/src/rtc/mesh.test.ts`, …).
When adding server features, add server-side tests too.

## Reporting bugs & proposing features

- **Bugs:** open an issue with reproduction steps, expected vs. actual
  behavior, and browser/OS if client-side.
- **Features:** open an issue describing the problem first — especially for
  anything touching the wire protocol or crypto, discussion before code saves
  everyone time. Check the README roadmap; roadmap items are already planned.

## License

By contributing you agree that your contributions are licensed under the
project's [MIT license](LICENSE).
