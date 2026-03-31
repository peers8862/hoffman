import * as nodePath from "path";
import { Plugin, WorkspaceLeaf } from "obsidian";
import { TerminalView, VIEW_TYPE_TERMINAL } from "./TerminalView";
import { SettingsTab } from "./SettingsTab";
import {
  DEFAULT_SESSION,
  DEFAULT_SETTINGS,
  type PluginData,
  type PluginSettings,
  type SessionState,
} from "./types";

export default class MultiTerminalPlugin extends Plugin {
  settings!: PluginSettings;
  session!: SessionState;
  pluginDir!: string;
  private statusBarItem!: HTMLElement;

  async onload() {
    await this.loadPluginData();

    const adapter = this.app.vault.adapter as any;
    this.pluginDir = adapter.basePath
      ? nodePath.join(adapter.basePath, this.manifest.dir)
      : this.manifest.dir;

    this.registerView(
      VIEW_TYPE_TERMINAL,
      (leaf: WorkspaceLeaf) => new TerminalView(leaf, this)
    );

    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.addClass("multi-terminal__statusbar");

    this.addRibbonIcon("terminal", "Open Multi Terminal", () => this.activateView());

    // ─── Commands ─────────────────────────────────────────────────────────────

    this.addCommand({
      id: "open-terminal",
      name: "Open terminal panel",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "new-terminal-tab",
      name: "New terminal tab",
      callback: () => this.getActiveView()?.addTab(),
    });

    this.addCommand({
      id: "close-terminal-tab",
      name: "Close current terminal tab",
      callback: () => this.getActiveView()?.closeActiveTab(),
    });

    this.addCommand({
      id: "duplicate-terminal-tab",
      name: "Duplicate current terminal tab",
      callback: () => this.getActiveView()?.duplicateActiveTab(),
    });

    this.addCommand({
      id: "rename-terminal-tab",
      name: "Rename current terminal tab",
      callback: () => this.getActiveView()?.openRenameModalForActive(),
    });

    this.addCommand({
      id: "move-terminal-tab-to-group",
      name: "Move current terminal tab to group",
      callback: () => this.getActiveView()?.openGroupPickerForActive(),
    });

    this.addCommand({
      id: "switch-terminal-tab",
      name: "Switch terminal tab (search)",
      callback: () => this.getActiveView()?.openTabSwitcher(),
    });

    this.addCommand({
      id: "focus-terminal",
      name: "Focus active terminal",
      callback: () => this.getActiveView()?.focusActiveTerminal(),
    });

    // Switch to tab by index (Alt+1…9 in terminal; also bindable in hotkeys)
    for (let i = 1; i <= 9; i++) {
      this.addCommand({
        id: `switch-to-terminal-${i}`,
        name: `Switch to terminal tab ${i}`,
        callback: () => this.getActiveView()?.switchToTabByIndex(i - 1),
      });
    }

    this.addSettingTab(new SettingsTab(this.app, this));
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_TERMINAL);
  }

  // ─── Status bar ───────────────────────────────────────────────────────────────

  updateStatusBar(name?: string, group?: string) {
    if (name) {
      const groupSuffix = group && group !== "Ungrouped" ? ` · ${group}` : "";
      this.statusBarItem.textContent = `⬛ ${name}${groupSuffix}`;
      this.statusBarItem.title = `Terminal: ${name}${groupSuffix}`;
    } else {
      this.statusBarItem.textContent = "";
      this.statusBarItem.title = "";
    }
  }

  // ─── View helpers ─────────────────────────────────────────────────────────────

  async activateView() {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);
    if (existing.length) {
      workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_TERMINAL, active: true });
    workspace.revealLeaf(leaf);
  }

  getActiveView(): TerminalView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);
    if (leaves.length && leaves[0].view instanceof TerminalView) {
      return leaves[0].view as TerminalView;
    }
    return null;
  }

  // ─── Data persistence ─────────────────────────────────────────────────────────

  async loadPluginData() {
    const raw = await this.loadData();

    if (raw && !raw.settings && !raw.session) {
      this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);
      this.session = structuredClone(DEFAULT_SESSION);
      return;
    }

    const data = raw as Partial<PluginData> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings ?? {});
    this.session = Object.assign({}, DEFAULT_SESSION, data?.session ?? {});
    this.session.tabs = [...(data?.session?.tabs ?? [])];
  }

  async saveSettings() {
    await this.savePluginData();
    this.getActiveView()?.refreshSettings();
  }

  async saveSession() {
    await this.savePluginData();
  }

  private async savePluginData() {
    await this.saveData({
      settings: this.settings,
      session: this.session,
    } satisfies PluginData);
  }
}
