# Deploying Whisper with nginx

nginx serves the built client and reverse-proxies the WebSocket signaling to the
local Node `ws` server — one HTTPS origin, no Vite dev server in production.

```
Browser ──https/wss──▶ nginx :443
                         ├─ /            → static files (client/dist)
                         └─ /signaling   → 127.0.0.1:8787 (Node ws server)
```

The client auto-targets `wss://<this-host>/signaling`, so **no signaling env var
is needed**. Assumes the repo lives at `/srv/whisper` (adjust paths to taste).

## 1. Get the code + dependencies on the server

```bash
sudo mkdir -p /srv/whisper && sudo chown "$USER" /srv/whisper
git clone <your-repo> /srv/whisper && cd /srv/whisper
npm install
```

## 2. Build the client

```bash
# (optional) TURN creds are baked in at build time — see client/.env.example
cp client/.env.example client/.env.local   # then edit, if using TURN
npm run build --workspace=shared
npm run build --workspace=client            # → client/dist
```

Re-run this whenever you change the client. nginx serves the static output.

## 3. Run the signaling server (systemd)

```bash
sudo cp deploy/whisper-signaling.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now whisper-signaling
systemctl status whisper-signaling          # should be active (running)
```

It runs with `tsx` and binds `127.0.0.1:8787` (private; only nginx reaches it).

## 4. Configure nginx

```bash
sudo cp deploy/nginx/whisper.conf /etc/nginx/sites-available/whisper.conf
sudo ln -s /etc/nginx/sites-available/whisper.conf /etc/nginx/sites-enabled/
# edit server_name + root + cert paths in that file first
sudo nginx -t && sudo systemctl reload nginx
```

## 5. TLS

**With a domain (recommended) — free Let's Encrypt cert:**

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d chat.example.com
```

certbot fills in the `ssl_certificate*` paths and sets up auto-renewal.

**IP / LAN only — self-signed** (browsers show a one-time warning):

```bash
sudo mkdir -p /etc/nginx/ssl
sudo openssl req -x509 -nodes -days 825 -newkey rsa:2048 \
  -keyout /etc/nginx/ssl/whisper.key -out /etc/nginx/ssl/whisper.crt \
  -subj "/CN=$(hostname -I | awk '{print $1}')"
# then switch the ssl_certificate lines in whisper.conf to the self-signed pair
sudo nginx -t && sudo systemctl reload nginx
```

## 6. Firewall

```bash
sudo ufw allow 'Nginx Full'     # opens 80 + 443
```

Open `https://chat.example.com` (or your IP), enter a room code, and share it.

## Calls across networks (TURN)

STUN can't traverse strict/mobile NATs, so reliable calls need a TURN relay. Put
your TURN credentials in `client/.env.local` **before** `npm run build` (see
`client/.env.example` for the format and a free testing option). They're embedded
into the client bundle and added to the WebRTC ICE config automatically.

## Updating

```bash
cd /srv/whisper && git pull && npm install
npm run build --workspace=shared && npm run build --workspace=client
sudo systemctl restart whisper-signaling     # only if server/ changed
```
