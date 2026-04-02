# Deployment: Public Server with Token Auth (Solution 2)

For teams without a shared network. Server exposed on the internet, protected by a shared token.

## Architecture

```
Internet
    │
    ▼
Caddy / nginx (TLS termination)
    │
    ▼
Collab server (:1234, token auth)
    │
    ▼
Obsidian clients (anywhere)
```

## Server setup

### 1. Deploy the server

```bash
cd server
npm install
```

### 2. Generate a token

```bash
openssl rand -hex 32
# Example: c0b1cebad5273e30bf999c24e1aedb12220dd15fc10d3f089084f4f980f73561
```

### 3. Create systemd service

```ini
# /etc/systemd/system/collab.service (or ~/.config/systemd/user/collab.service)
[Unit]
Description=Collab CRDT relay server
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=3
WorkingDirectory=/path/to/obsidian-collab/server
Environment=HOST=127.0.0.1
Environment=PORT=1234
Environment=COLLAB_TOKEN=<your-generated-token>

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now collab
```

### 4. Reverse proxy with TLS

#### Caddy (simplest — automatic TLS)

```
# /etc/caddy/Caddyfile
collab.your-domain.at {
    reverse_proxy localhost:1234
}
```

```bash
sudo systemctl reload caddy
```

#### nginx + Let's Encrypt

```nginx
server {
    listen 443 ssl;
    server_name collab.your-domain.at;

    ssl_certificate /etc/letsencrypt/live/collab.your-domain.at/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/collab.your-domain.at/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:1234;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400s;
    }
}
```

### 5. Docker alternative

```bash
docker build -t collab-server .
docker run -d \
  -p 1234:1234 \
  -e HOST=0.0.0.0 \
  -e PORT=1234 \
  -e COLLAB_TOKEN=<your-token> \
  --name collab \
  --restart unless-stopped \
  collab-server
```

## Client setup

1. Install plugin via BRAT: `da-ni/obsidian-collab`
2. Settings:
   - **Server URL:** `wss://collab.your-domain.at`
   - **Your Name:** their name
   - **Token:** the shared token (distributed securely)

## Token management

- Token is a shared secret — everyone uses the same one
- Distribute securely (password manager, encrypted message, NOT email/Slack)
- To rotate: change `COLLAB_TOKEN` env var, restart service, distribute new token
- Token is sent as a WebSocket query parameter on connect, validated once per session
- Without valid token, server immediately closes the connection (code 4001)

## Security considerations

- Always use `wss://` (TLS) — the token is in the query string
- WebSocket query params are NOT visible in browser address bars, but may appear in server access logs
- For higher security, replace the shared token with a server-side auth layer that issues short-lived per-user credentials
- The token only gates WebSocket connections — once connected, all CRDT operations are unauthenticated (by design, since CRDTs are conflict-free)
