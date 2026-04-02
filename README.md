# Collab

Real-time collaborative editing for [Obsidian](https://obsidian.md). Self-hosted, open source, no vendor lock-in.

Open the same note on two devices — see each other's cursors, edits merge instantly, no conflicts.

## Install via BRAT

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) if you don't have it
2. BRAT → Add Beta Plugin → `da-ni/obsidian-collab`
3. Enable "Collab" in Community Plugins
4. Settings → set **Server URL** and **Your Name**

## Features

- **Real-time editing** — keystroke-level sync via [Yjs](https://yjs.dev/) CRDTs
- **Live cursors** — see collaborators' positions and selections
- **Auto-assigned colors** — unique color per user, no configuration needed
- **Offline support** — edits persist locally, merge on reconnect
- **User count** — status bar shows `Collab (3)` when collaborating
- **Mobile** — works on iOS and Android

## Server

This plugin requires a CRDT relay server — a 57-line Node.js process. See [server setup instructions](docs/server.md).

## File sync

This plugin handles **real-time editing only** (open files). For vault-level file sync (new files, images, config), use [obsidian-git](https://github.com/denolehov/obsidian-git), [Syncthing](https://syncthing.net/), or any file sync tool.

## Development

```bash
npm install
npm run dev     # watch mode
npm run build   # production build
```

## License

MIT
