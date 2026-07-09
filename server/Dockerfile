# Whisper signaling server.
#
# Build from the REPO ROOT (the npm-workspaces monorepo is needed so the
# @private-chat/shared workspace resolves):
#   docker build -f server/Dockerfile -t whisper-server .
#
# The runtime executes the TypeScript sources with tsx (a production
# dependency, same as the systemd deploy in deploy/whisper-signaling.service):
# the @private-chat/shared workspace package intentionally exports TypeScript
# source, so tsx keeps one canonical module-resolution path everywhere.
# The build stage still runs `tsc` on both workspaces so type errors fail the
# image build.

# ── Stage 1: install everything & type-check ─────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY shared/ shared/
COPY server/ server/
RUN npm run build --workspace=shared && npm run build --workspace=server

# ── Stage 2: production dependencies only ────────────────────────────────────
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev --workspace=server

# ── Stage 3: runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules node_modules
COPY package.json ./
COPY shared/ shared/
COPY server/ server/
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "server/src/index.ts"]
