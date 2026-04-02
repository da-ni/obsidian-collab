# Deployment: Tailscale (Solution 1)

Access controlled by Tailscale network — only devices on your Tailnet can reach the server.

## Prerequisites

- A machine with Tailscale (e.g. `quartz`)
- The collab server running as a systemd service on that machine

## Server setup

### 1. Install dependencies

```bash
cd server
npm install
```

### 2. Create systemd service

```ini
# ~/.config/systemd/user/collab.service
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

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now collab.service
```

### 3. Expose as Tailscale service

```bash
tailscale serve --bg --service=svc:collab 1234
```

Approve the service in the Tailscale admin console when prompted.

Server is now available at `wss://collab.<your-tailnet>.ts.net`.

## Access control

### Grant rule

In Tailscale admin → Access Controls, add:

```json
{
  "grants": [
    {
      "src": ["autogroup:shared"],
      "dst": ["svc:collab"],
      "ip": ["443"]
    }
  ]
}
```

This restricts shared users to only the collab service — they cannot reach any other device or service on your Tailnet.

### Share with coworkers

1. Tailscale admin → Machines → find `collab` service → **Share**
2. Toggle **Reusable link**
3. Send the link to your team

Coworkers click the link, install Tailscale, accept the share. Done.

## Client setup

1. Install plugin via BRAT: `da-ni/obsidian-collab`
2. Settings → Server URL: `wss://collab.<your-tailnet>.ts.net`
3. Settings → Your Name: their name

## Limitations

- Each coworker needs Tailscale installed
- Share links expire after 30 days if unused
- No built-in integration with institutional SSO
