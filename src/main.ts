import {
  Plugin,
  MarkdownView,
  PluginSettingTab,
  Setting,
  App,
  WorkspaceLeaf,
  Platform,
  TFile,
} from "obsidian";
import { EditorView } from "@codemirror/view";
import { StateEffect } from "@codemirror/state";
import * as Y from "yjs";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { WebsocketProvider } from "y-websocket";
import { IndexeddbPersistence } from "y-indexeddb";
import { keymap } from "@codemirror/view";

// ---------------------------------------------------------------------------
// Color palette — 12 maximally-spaced, dark-theme friendly colors
// ---------------------------------------------------------------------------

const PALETTE = [
  { color: "#E11D48", light: "#E11D4820" }, // rose
  { color: "#2563EB", light: "#2563EB20" }, // blue
  { color: "#16A34A", light: "#16A34A20" }, // green
  { color: "#D97706", light: "#D9770620" }, // amber
  { color: "#7C3AED", light: "#7C3AED20" }, // purple
  { color: "#0891B2", light: "#0891B220" }, // cyan
  { color: "#EA580C", light: "#EA580C20" }, // orange
  { color: "#DB2777", light: "#DB277720" }, // pink
  { color: "#4F46E5", light: "#4F46E520" }, // indigo
  { color: "#65A30D", light: "#65A30D20" }, // lime
  { color: "#0D9488", light: "#0D948820" }, // teal
  { color: "#DC2626", light: "#DC262620" }, // red
];

function colorByIndex(index: number): (typeof PALETTE)[0] {
  return PALETTE[index % PALETTE.length];
}

/** Deterministic color preview for settings UI */
function colorForName(name: string): (typeof PALETTE)[0] {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = Math.imul(h ^ name.charCodeAt(i), 0x5bd1e995);
    h ^= h >>> 13;
  }
  return PALETTE[Math.abs(h) % PALETTE.length];
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

interface CollabSettings {
  serverUrl: string;
  username: string;
}

const DEFAULT_SETTINGS: CollabSettings = {
  serverUrl: "",
  username: "",
};

// ---------------------------------------------------------------------------
// Session — one per open markdown file
// ---------------------------------------------------------------------------

interface DocSession {
  ydoc: Y.Doc;
  provider: WebsocketProvider;
  persistence: IndexeddbPersistence;
  undoManager: Y.UndoManager;
  filePath: string;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default class CollabPlugin extends Plugin {
  settings: CollabSettings = DEFAULT_SETTINGS;
  private sessions = new Map<string, DocSession>();
  private connectedSessions = new Set<string>();
  private statusBarEl: HTMLElement | null = null;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new CollabSettingTab(this.app, this));

    this.statusBarEl = this.addStatusBarItem();
    this.updateStatusBar();

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf) this.handleLeafChange(leaf);
      })
    );

    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.cleanupStaleSessions())
    );

    const activeLeaf = this.app.workspace.activeLeaf;
    if (activeLeaf) this.handleLeafChange(activeLeaf);
  }

  onunload() {
    for (const [, session] of this.sessions) this.destroySession(session);
    this.sessions.clear();
    this.connectedSessions.clear();
  }

  // ---- Session lifecycle ---------------------------------------------------

  private handleLeafChange(leaf: WorkspaceLeaf) {
    if (!this.settings.serverUrl) return;
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) return;
    const file = view.file;
    if (!file?.path.endsWith(".md")) return;
    if (this.sessions.has(file.path)) return;
    this.createSession(file, view);
  }

  private createSession(file: TFile, markdownView: MarkdownView) {
    const roomName = file.path.replace(/[^a-zA-Z0-9\-_/.]/g, "_");
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("content");

    const persistence = new IndexeddbPersistence(`collab:${roomName}`, ydoc);

    const provider = new WebsocketProvider(
      this.settings.serverUrl,
      roomName,
      ydoc,
      {
        connect: true,
        ...(Platform.isMobile ? { maxBackoffTime: 5000 } : { maxBackoffTime: 30000 }),
      }
    );

    // Color assigned by position among connected clients — guaranteed unique
    const updateAwareness = () => {
      const states = Array.from(provider.awareness.getStates().keys()).sort((a, b) => a - b);
      const myIndex = states.indexOf(provider.awareness.clientID);
      const c = colorByIndex(myIndex >= 0 ? myIndex : 0);
      provider.awareness.setLocalStateField("user", {
        name: this.settings.username || "Anonymous",
        color: c.color,
        colorLight: c.light,
      });
    };
    updateAwareness();
    provider.awareness.on("change", () => {
      updateAwareness();
      this.updateStatusBar();
    });

    const undoManager = new Y.UndoManager(ytext);

    const editorView = (markdownView.editor as any)?.cm as EditorView | null;
    if (!editorView) {
      provider.destroy();
      ydoc.destroy();
      return;
    }

    // Connection status
    provider.on("status", ({ status }: { status: string }) => {
      if (status === "connected") {
        this.connectedSessions.add(file.path);
      } else {
        this.connectedSessions.delete(file.path);
      }
      this.updateStatusBar();
    });

    // Wait for both IndexedDB and WebSocket sync before binding to editor
    let idbSynced = false;
    let wsSynced = false;
    let bound = false;

    const bindEditor = () => {
      if (bound || !idbSynced || !wsSynced) return;
      bound = true;

      // Seed from local file only if server had no content
      if (ytext.length === 0) {
        const content = editorView.state.doc.toString();
        if (content.length > 0) {
          ydoc.transact(() => ytext.insert(0, content));
        }
      }

      editorView.dispatch({
        effects: StateEffect.appendConfig.of([
          yCollab(ytext, provider.awareness, { undoManager }),
          keymap.of(yUndoManagerKeymap),
        ]),
      });
    };

    persistence.once("synced", () => { idbSynced = true; bindEditor(); });
    provider.once("synced", () => { wsSynced = true; bindEditor(); });
    setTimeout(() => { if (!wsSynced) { wsSynced = true; bindEditor(); } }, 5000);

    const session: DocSession = { ydoc, provider, persistence, undoManager, filePath: file.path };
    this.sessions.set(file.path, session);

    // Write CRDT content back to .md file (debounced)
    let writeTimer: ReturnType<typeof setTimeout> | null = null;
    ytext.observe(() => {
      if (writeTimer) clearTimeout(writeTimer);
      writeTimer = setTimeout(async () => {
        const content = ytext.toString();
        if (!content) return;
        try {
          const existing = await this.app.vault.read(file);
          if (existing !== content) await this.app.vault.modify(file, content);
        } catch { /* file deleted/renamed */ }
      }, 3000);
    });
  }

  private destroySession(session: DocSession) {
    // Flush final content to disk
    const file = this.app.vault.getAbstractFileByPath(session.filePath);
    if (file instanceof TFile) {
      const content = session.ydoc.getText("content").toString();
      if (content) this.app.vault.modify(file, content);
    }

    this.connectedSessions.delete(session.filePath);
    session.provider.awareness.setLocalState(null);
    session.provider.destroy();
    session.persistence.destroy();
    session.undoManager.destroy();
    session.ydoc.destroy();
  }

  private cleanupStaleSessions() {
    const openPaths = new Set<string>();
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView && leaf.view.file) {
        openPaths.add(leaf.view.file.path);
      }
    });

    for (const [path, session] of this.sessions) {
      if (!openPaths.has(path)) {
        this.destroySession(session);
        this.sessions.delete(path);
      }
    }
    this.updateStatusBar();
  }

  // ---- Status bar ----------------------------------------------------------

  private updateStatusBar() {
    if (!this.statusBarEl) return;

    let status: string;
    if (!this.settings.serverUrl || this.sessions.size === 0) {
      status = "disconnected";
    } else if (this.connectedSessions.size > 0) {
      status = "connected";
    } else {
      status = "connecting";
    }

    // User count on the active file
    let userCount = 0;
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView?.file && status === "connected") {
      const session = this.sessions.get(activeView.file.path);
      if (session) userCount = session.provider.awareness.getStates().size;
    }

    const label =
      status === "connected"
        ? userCount > 1 ? `Collab (${userCount})` : "Collab"
        : status === "connecting" ? "Connecting" : "Offline";

    this.statusBarEl.empty();
    this.statusBarEl.className = `collab-status is-${status}`;
    this.statusBarEl.createEl("span", { cls: "sync-dot" });
    this.statusBarEl.createEl("span", { text: label, cls: "sync-label" });
  }

  // ---- Settings ------------------------------------------------------------

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    // Push updated name to all active sessions
    for (const [, session] of this.sessions) {
      const states = Array.from(session.provider.awareness.getStates().keys()).sort((a, b) => a - b);
      const myIndex = states.indexOf(session.provider.awareness.clientID);
      const c = colorByIndex(myIndex >= 0 ? myIndex : 0);
      session.provider.awareness.setLocalStateField("user", {
        name: this.settings.username || "Anonymous",
        color: c.color,
        colorLight: c.light,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

class CollabSettingTab extends PluginSettingTab {
  plugin: CollabPlugin;

  constructor(app: App, plugin: CollabPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Vault Sync" });
    containerEl.createEl("p", {
      text: "Real-time collaborative editing via Yjs CRDTs.",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("WebSocket URL of your CRDT relay server")
      .addText((text) =>
        text
          .setPlaceholder("ws://your-server:1234")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (v) => {
            this.plugin.settings.serverUrl = v.trim();
            await this.plugin.saveSettings();
          })
      );

    const nameSetting = new Setting(containerEl)
      .setName("Your Name")
      .setDesc("Shown next to your cursor. Color auto-assigned per session.")
      .addText((text) =>
        text
          .setPlaceholder("Your name")
          .setValue(this.plugin.settings.username)
          .onChange(async (v) => {
            this.plugin.settings.username = v.trim();
            await this.plugin.saveSettings();
            const c = colorForName(v.trim() || "Anonymous");
            swatch.style.background = c.color;
            swatch.style.boxShadow = `0 0 4px ${c.color}88`;
          })
      );

    const initColor = colorForName(this.plugin.settings.username || "Anonymous");
    const swatch = nameSetting.controlEl.createEl("span");
    swatch.style.cssText = `display:inline-block;width:16px;height:16px;border-radius:50%;background:${initColor.color};margin-left:8px;vertical-align:middle;box-shadow:0 0 4px ${initColor.color}88`;
  }
}
