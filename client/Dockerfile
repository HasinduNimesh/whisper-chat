# Whisper web client — static build served by nginx, proxying signaling/REST
# to the server container so the browser sees a single origin.
#
# Build from the REPO ROOT (the libsodium alias in client/vite.config.ts
# resolves into the hoisted root node_modules, so the whole workspace must be
# installed together):
#   docker build -f client/Dockerfile -t whisper-web .
#
# The backend target is templated: set SIGNALING_UPSTREAM (default
# http://server:8787) at container start.

# ── Stage 1: build the static client ─────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY shared/ shared/
COPY client/ client/
COPY widget/ widget/
RUN npm run build --workspace=shared && npm run build --workspace=client && npm run build --workspace=widget

# ── Stage 2: nginx runtime ────────────────────────────────────────────────────
FROM nginx:1.27-alpine
ENV SIGNALING_UPSTREAM=http://server:8787
COPY deploy/docker/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/client/dist /usr/share/nginx/html
COPY --from=build /app/widget/dist/embed.js /usr/share/nginx/html/embed.js
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO /dev/null http://127.0.0.1/nginx-health || exit 1
