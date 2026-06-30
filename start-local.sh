#!/usr/bin/env bash
#
# start-local.sh — boot the whole Whisper stack locally and expose it publicly.
#
# Starts the signaling server, the web client (HTTP), and a Cloudflare quick
# tunnel, waits for each to be ready, then prints the public HTTPS link.
# Press Ctrl+C to tear everything down.
#
#   ./start-local.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

CLIENT_PORT=5173
SERVER_PORT=8787

RUN_DIR="$ROOT/.run"
mkdir -p "$RUN_DIR"
SERVER_LOG="$RUN_DIR/server.log"
CLIENT_LOG="$RUN_DIR/client.log"
TUNNEL_LOG="$RUN_DIR/tunnel.log"

# ---- pretty output ---------------------------------------------------------
if [ -t 1 ]; then
  BOLD=$'\e[1m'; DIM=$'\e[2m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'
  CYAN=$'\e[36m'; RED=$'\e[31m'; RESET=$'\e[0m'
else
  BOLD=; DIM=; GREEN=; YELLOW=; CYAN=; RED=; RESET=
fi
say()  { printf '%s\n' "$*"; }
info() { printf '%s▸%s %s\n' "$CYAN" "$RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
err()  { printf '%s✗%s %s\n' "$RED" "$RESET" "$*" >&2; }

PIDS=()

# ---- teardown --------------------------------------------------------------
cleanup() {
  say ""
  info "Shutting down…"
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] || continue
    pkill -P "$pid" 2>/dev/null || true   # children (e.g. node under npm)
    kill "$pid" 2>/dev/null || true
  done
  # Belt and braces: free the ports and any tunnel we launched.
  free_port "$SERVER_PORT" quiet
  free_port "$CLIENT_PORT" quiet
  pkill -f "cloudflared tunnel --url http://localhost:$CLIENT_PORT" 2>/dev/null || true
  wait 2>/dev/null || true
  info "Stopped. Logs kept in ${DIM}.run/${RESET}"
}
trap cleanup EXIT INT TERM

# ---- helpers ---------------------------------------------------------------
pids_on_port() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltnpH 2>/dev/null | grep ":$port " | grep -oP 'pid=\K[0-9]+' | sort -u
  elif command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u
  fi
}

free_port() {
  local port="$1" quiet="${2:-}" pids
  pids="$(pids_on_port "$port" || true)"
  if [ -n "$pids" ]; then
    [ "$quiet" = quiet ] || warn "Port $port is in use (pid: $(echo "$pids" | tr '\n' ' '))— stopping it."
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    sleep 1
  fi
}

port_open() { (echo >"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1; }

wait_for_port() {
  local port="$1" name="$2"
  for _ in $(seq 1 60); do
    port_open "$port" && return 0
    sleep 0.5
  done
  err "$name did not come up on :$port"
  return 1
}

# Start a long-running process in the *main* shell (so `wait` tracks it) and
# record its PID. Must NOT be called inside $(...) or the job lands in a subshell.
launch() { # $1=logfile, rest=command
  local log="$1"; shift
  "$@" >"$log" 2>&1 &
  PIDS+=("$!")
}

# ---- prerequisites ---------------------------------------------------------
command -v node >/dev/null 2>&1 || { err "node is required (https://nodejs.org)"; exit 1; }
command -v npm  >/dev/null 2>&1 || { err "npm is required"; exit 1; }

if [ ! -d node_modules ]; then
  info "Installing dependencies (first run, this may take a minute)…"
  npm install
fi

# ---- cloudflared (use system one, else download a local static binary) -----
CF="$(command -v cloudflared || true)"
if [ -z "$CF" ]; then
  CF="$RUN_DIR/cloudflared"
  if [ ! -x "$CF" ]; then
    case "$(uname -m)" in
      x86_64|amd64)  ARCH=amd64 ;;
      aarch64|arm64) ARCH=arm64 ;;
      *) err "No cloudflared and can't auto-download for $(uname -m). Install it manually."; exit 1 ;;
    esac
    info "Downloading cloudflared ($ARCH)…"
    curl -fsSL -o "$CF" \
      "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$ARCH"
    chmod +x "$CF"
  fi
fi

# ---- make sure the ports are free (idempotent re-runs) ---------------------
pkill -f "cloudflared tunnel --url http://localhost:$CLIENT_PORT" 2>/dev/null || true
free_port "$SERVER_PORT"
free_port "$CLIENT_PORT"

# ---- start the signaling server -------------------------------------------
info "Starting signaling server on :$SERVER_PORT…"
launch "$SERVER_LOG" npm run dev:server
wait_for_port "$SERVER_PORT" "signaling server" || { tail -n 25 "$SERVER_LOG"; exit 1; }

# ---- start the web client (plain HTTP; the tunnel adds HTTPS) --------------
info "Starting web client on :$CLIENT_PORT…"
launch "$CLIENT_LOG" npm run dev:client
wait_for_port "$CLIENT_PORT" "web client" || { tail -n 25 "$CLIENT_LOG"; exit 1; }

# ---- open the Cloudflare tunnel -------------------------------------------
info "Opening Cloudflare tunnel…"
launch "$TUNNEL_LOG" "$CF" tunnel --url "http://localhost:$CLIENT_PORT"

PUBLIC_URL=""
for _ in $(seq 1 50); do
  PUBLIC_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1 || true)"
  [ -n "$PUBLIC_URL" ] && break
  sleep 0.5
done
[ -n "$PUBLIC_URL" ] || { err "Tunnel did not return a URL. Recent log:"; tail -n 25 "$TUNNEL_LOG"; exit 1; }

# ---- banner ----------------------------------------------------------------
say ""
say "  ${GREEN}${BOLD}✔ Whisper is live${RESET}"
say "  ${DIM}────────────────────────────────────────────────────────${RESET}"
say "  ${BOLD}Public link${RESET}   ${CYAN}${BOLD}${PUBLIC_URL}${RESET}"
say "  ${BOLD}Local${RESET}         http://localhost:${CLIENT_PORT}"
say "  ${DIM}────────────────────────────────────────────────────────${RESET}"
say "  Share the public link — others open it, enter the ${BOLD}same room code${RESET},"
say "  and start chatting or calling."
say ""
say "  ${DIM}For reliable calls across mobile/strict networks, set TURN creds in${RESET}"
say "  ${DIM}client/.env.local (see client/.env.example) and re-run.${RESET}"
say ""
say "  ${YELLOW}Press Ctrl+C to stop everything.${RESET}"
say ""

# Stay alive until interrupted (or a child dies).
wait
