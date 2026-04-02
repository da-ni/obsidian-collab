# Collab

Real-time collaborative editing for [Obsidian](https://obsidian.md). Self-hosted, open source, no vendor lock-in.

Open the same note on two devices — see each other's cursors, edits merge instantly, no conflicts.

## Install the plugin

### Via BRAT (recommended)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) if you don't have it
2. BRAT → Add Beta Plugin → `da-ni/obsidian-collab`
3. Enable "Collab" in Community Plugins
4. Settings → set **Server URL** and **Your Name**

### Manual

```bash
git clone https://github.com/da-ni/obsidian-collab.git
cd obsidian-collab
npm install && npm run build
mkdir -p /path/to/vault/.obsidian/plugins/obsidian-collab/
cp main.js manifest.json styles.css /path/to/vault/.obsidian/plugins/obsidian-collab/
```

## Run the server

The server is a ~30-line CRDT relay. It passes edits between connected clients via WebSocket — no data processing, no storage required.

### Quick start

```bash
cd server
npm install
npm start
```

Server runs on `ws://localhost:1234` by default. Configure with environment variables:

```bash
HOST=0.0.0.0 PORT=4321 npm start
```

### Docker

```bash
cd server
docker build -t collab-server .
docker run -d -p 1234:1234 --name collab collab-server
```

### Keep it running (systemd)

```ini
# /etc/systemd/system/collab-server.service
[Unit]
Description=Collab CRDT relay server
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/obsidian-collab/server
ExecStart=/usr/bin/npm start
Restart=always
Environment=HOST=0.0.0.0 PORT=1234

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now collab-server
```

### Behind a reverse proxy (TLS)

For `wss://` connections, put the server behind nginx or caddy:

```nginx
# nginx
location / {
    proxy_pass http://localhost:1234;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 86400s;
}
```

```
# Caddyfile
collab.yourdomain.com {
    reverse_proxy localhost:1234
}
```

## Features

- **Real-time editing** — keystroke-level sync via [Yjs](https://yjs.dev/) CRDTs
- **Live cursors** — see collaborators' positions and selections
- **Auto-assigned colors** — unique color per user, no configuration needed
- **Offline support** — edits persist locally, merge cleanly on reconnect
- **User count** — status bar shows `Collab (3)` when collaborating
- **Mobile** — works on iOS and Android

## File sync

This plugin handles **real-time collaborative editing only** (open files). For syncing the vault itself (new files, images, config), use [obsidian-git](https://github.com/denolehov/obsidian-git), [Syncthing](https://syncthing.net/), or any file sync tool you prefer.

## Development

```bash
# Plugin (watch mode)
npm install && npm run dev

# Server
cd server && npm install && npm start
```

## License

MIT
