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
import { StateEffect, Compartment } from "@codemirror/state";
import * as Y from "yjs";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { WebsocketProvider } from "y-websocket";
import { IndexeddbPersistence } from "y-indexeddb";
import { keymap } from "@codemirror/view";

// ---------------------------------------------------------------------------
// Color palette — 12 maximally-spaced, dark-theme friendly colors
// ---------------------------------------------------------------------------

// Muted, medium-saturation colors that work on both Obsidian default dark and light.
// Not too vivid against dark (#1e1e1e), not too faint against light (#ffffff).
const PALETTE = [
  { color: "#c47fd5", light: "#c47fd518" }, // soft purple
  { color: "#5ba3cf", light: "#5ba3cf18" }, // slate blue
  { color: "#6bba7b", light: "#6bba7b18" }, // sage green
  { color: "#d4915e", light: "#d4915e18" }, // warm clay
  { color: "#c75b7a", light: "#c75b7a18" }, // dusty rose
  { color: "#4bac9e", light: "#4bac9e18" }, // muted teal
  { color: "#c9a645", light: "#c9a64518" }, // soft gold
  { color: "#7a8dd4", light: "#7a8dd418" }, // periwinkle
  { color: "#b86e4f", light: "#b86e4f18" }, // terracotta
  { color: "#58a186", light: "#58a18618" }, // seafoam
  { color: "#a8709a", light: "#a8709a18" }, // mauve
  { color: "#6a9ec0", light: "#6a9ec018" }, // steel blue
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
  token: string;
}

const DEFAULT_SETTINGS: CollabSettings = {
  serverUrl: "",
  username: "",
  token: "",
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
  editorView: EditorView;
  collabCompartment: Compartment;
  writeTimer: ReturnType<typeof setTimeout> | null;
  bound: boolean;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default class CollabPlugin extends Plugin {
  settings: CollabSettings = DEFAULT_SETTINGS;
  private sessions = new Map<string, DocSession>();
  private connectedSessions = new Set<string>();
  private statusBarEl: HTMLElement | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

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
      this.app.workspace.on("layout-change", () => this.syncSessionsToWorkspace())
    );

    this.syncSessionsToWorkspace();
  }

  onunload() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
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

    const wsParams: Record<string, string> = {};
    if (this.settings.token) wsParams.token = this.settings.token;

    const provider = new WebsocketProvider(
      this.settings.serverUrl,
      roomName,
      ydoc,
      {
        connect: true,
        params: wsParams,
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
      persistence.destroy();
      ydoc.destroy();
      return;
    }

    // Connection status
    let everConnected = false;
    let offlineReady = false;
    provider.on("status", ({ status }: { status: string }) => {
      if (status === "connected") {
        everConnected = true;
        this.connectedSessions.add(file.path);
      } else {
        this.connectedSessions.delete(file.path);
        if (!everConnected) {
          offlineReady = true;
          bindEditor();
        }
      }
      this.updateStatusBar();
    });

    const collabCompartment = new Compartment();

    // Wait for IndexedDB plus either a confirmed remote sync or an offline fallback.
    let idbSynced = false;
    let wsSynced = false;

    const bindEditor = () => {
      if (session.bound || !idbSynced || (!wsSynced && !offlineReady)) return;
      session.bound = true;

      // Seed from the local file only after remote sync confirms the shared doc is empty,
      // or when we never established a websocket session and must start from disk offline.
      if (ytext.length === 0) {
        const content = editorView.state.doc.toString();
        if (content.length > 0) {
          ydoc.transact(() => ytext.insert(0, content));
        }
      }

      const sharedContent = ytext.toString();
      const editorContent = editorView.state.doc.toString();
      if (sharedContent !== editorContent) {
        editorView.dispatch({
          changes: {
            from: 0,
            to: editorView.state.doc.length,
            insert: sharedContent,
          },
        });
      }

      editorView.dispatch({
        effects: StateEffect.appendConfig.of([
          collabCompartment.of([
            yCollab(ytext, provider.awareness, { undoManager }),
            keymap.of(yUndoManagerKeymap),
          ]),
        ]),
      });
    };

    const session: DocSession = {
      ydoc,
      provider,
      persistence,
      undoManager,
      filePath: file.path,
      editorView,
      collabCompartment,
      writeTimer: null,
      bound: false,
    };

    persistence.once("synced", () => { idbSynced = true; bindEditor(); });
    provider.on("sync", (isSynced: boolean) => {
      if (!isSynced) return;
      wsSynced = true;
      bindEditor();
    });
    setTimeout(() => {
      if (!wsSynced && !everConnected) {
        offlineReady = true;
        bindEditor();
      }
    }, 5000);

    this.sessions.set(file.path, session);

    // Write CRDT content back to .md file (debounced)
    ytext.observe(() => {
      if (session.writeTimer) clearTimeout(session.writeTimer);
      session.writeTimer = setTimeout(async () => {
        const content = ytext.toString();
        try {
          const existing = await this.app.vault.read(file);
          if (existing !== content) await this.app.vault.modify(file, content);
        } catch { /* file deleted/renamed */ }
      }, 3000);
    });
  }

  private destroySession(session: DocSession) {
    if (session.writeTimer) {
      clearTimeout(session.writeTimer);
      session.writeTimer = null;
    }

    if (session.bound) {
      try {
        session.editorView.dispatch({
          effects: session.collabCompartment.reconfigure([]),
        });
      } catch {
        // Editor might already be gone during shutdown/layout teardown.
      }
      session.bound = false;
    }

    // Flush final content to disk
    const file = this.app.vault.getAbstractFileByPath(session.filePath);
    if (file instanceof TFile) {
      const content = session.ydoc.getText("content").toString();
      void this.app.vault.modify(file, content).catch(() => {
        // File may have been deleted/renamed while the session was active.
      });
    }

    this.connectedSessions.delete(session.filePath);
    session.provider.awareness.setLocalState(null);
    session.provider.destroy();
    session.persistence.destroy();
    session.undoManager.destroy();
    session.ydoc.destroy();
  }

  private syncSessionsToWorkspace(forceReconnect = false) {
    const openViews = new Map<string, MarkdownView>();
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView && leaf.view.file) {
        openViews.set(leaf.view.file.path, leaf.view);
      }
    });

    if (forceReconnect) {
      for (const [, session] of this.sessions) this.destroySession(session);
      this.sessions.clear();
      this.connectedSessions.clear();
    }

    for (const [path, session] of this.sessions) {
      if (!openViews.has(path)) {
        this.destroySession(session);
        this.sessions.delete(path);
      }
    }

    if (this.settings.serverUrl) {
      for (const [path, view] of openViews) {
        if (!this.sessions.has(path) && view.file) {
          this.createSession(view.file, view);
        }
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

  private scheduleSessionRefresh() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.syncSessionsToWorkspace(true);
    }, 500);
  }

  async saveSettings(previousSettings?: CollabSettings) {
    await this.saveData(this.settings);

    const connectionChanged = !!previousSettings && (
      previousSettings.serverUrl !== this.settings.serverUrl ||
      previousSettings.token !== this.settings.token
    );

    if (connectionChanged) {
      this.scheduleSessionRefresh();
    }

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

    containerEl.createEl("h2", { text: "Collab" });
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
            const previous = { ...this.plugin.settings };
            this.plugin.settings.serverUrl = v.trim();
            await this.plugin.saveSettings(previous);
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
            const previous = { ...this.plugin.settings };
            this.plugin.settings.username = v.trim();
            await this.plugin.saveSettings(previous);
            const c = colorForName(v.trim() || "Anonymous");
            swatch.style.background = c.color;
            swatch.style.boxShadow = `0 0 4px ${c.color}88`;
          })
      );

    const initColor = colorForName(this.plugin.settings.username || "Anonymous");
    const swatch = nameSetting.controlEl.createEl("span");
    swatch.style.cssText = `display:inline-block;width:16px;height:16px;border-radius:50%;background:${initColor.color};margin-left:8px;vertical-align:middle;box-shadow:0 0 4px ${initColor.color}88`;

    new Setting(containerEl)
      .setName("Token")
      .setDesc("Access token (leave empty if not required by server)")
      .addText((text) =>
        text
          .setPlaceholder("")
          .setValue(this.plugin.settings.token)
          .then((t) => { t.inputEl.type = "password"; })
          .onChange(async (v) => {
            const previous = { ...this.plugin.settings };
            this.plugin.settings.token = v.trim();
            await this.plugin.saveSettings(previous);
          })
      );
  }
}
