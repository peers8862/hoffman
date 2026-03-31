import { ItemView, Menu, Notice, Platform, WorkspaceLeaf, debounce } from "obsidian";
import { TerminalTab } from "./TerminalTab";
import type { KeyboardAction } from "./TerminalTab";
import { TabBar } from "./TabBar";
import type MultiTerminalPlugin from "./main";
import { normalizeGroup, type TabState } from "./types";
import { probeServiceUsage } from "./UsageProbe";
import {
  CommandModal,
  GroupPickerModal,
  RenameModal,
  TabSwitcherModal,
} from "./Modals";

export const VIEW_TYPE_TERMINAL = "multi-terminal";

const MIN_SIDEBAR_WIDTH = 120;
const MAX_SIDEBAR_WIDTH = 420;

/** How often (ms) the hibernation sweeper checks for idle tabs. */
const HIBERNATE_CHECK_INTERVAL_MS = 60_000;

export class TerminalView extends ItemView {
  private plugin: MultiTerminalPlugin;
  private tabs: TerminalTab[] = [];
  private activeTabId: string | null = null;
  private tabBar!: TabBar;
  private paneArea!: HTMLDivElement;
  private resizeHandle!: HTMLDivElement;
  private hibernateTimer: ReturnType<typeof setInterval> | null = null;
  /** Counts how many AI turns have occurred per tab since its last API probe. */
  private turnsSinceLastProbe = new Map<string, number>();

  /**
   * Write current tab state to the in-memory session snapshot immediately.
   * This is always synchronous so reopening the panel within the same
   * Obsidian session always sees the latest state, even if the disk flush
   * hasn't fired yet.
   */
  private syncSession() {
    this.plugin.session = {
      activeTabId: this.activeTabId,
      tabs: this.tabs.map((t) => t.toState()),
    };
  }

  /**
   * Debounced disk write. Separated from the in-memory update so that a
   * cancelled or delayed flush cannot overwrite a valid session with stale
   * (or empty) data.
   */
  private scheduleDiskFlush = debounce(() => {
    void this.plugin.saveSession();
  }, 300, false);

  /** Call after every state change that needs persisting. */
  private persistSession() {
    this.syncSession();
    this.scheduleDiskFlush();
  }

  constructor(leaf: WorkspaceLeaf, plugin: MultiTerminalPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_TERMINAL; }
  getDisplayText(): string { return "Terminal"; }
  getIcon(): string { return "terminal"; }

  async onOpen() {
    if (!Platform.isDesktopApp) {
      this.contentEl.createEl("p", {
        text: "Terminal is only available on the desktop app.",
      });
      return;
    }

    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("multi-terminal");

    this.tabBar = new TabBar({
      onSelect: (id) => this.selectTab(id),
      onClose: (id) => this.closeTab(id),
      onNew: (group) => this.addTab({ group }),
      onNewPreset: (group) => this.openPresetMenu(group),
      onRename: (id, name) => this.renameTab(id, name),
      onRequestRename: (id) => this.openRenameModal(id),
      onRequestChangeGroup: (id) => this.openGroupPickerModal(id),
      onDirectMoveToGroup: (id, group) => this.changeTabGroup(id, group),
      onDuplicate: (id) => this.duplicateTab(id),
      onTogglePin: (id) => this.togglePinned(id),
      onCopyContext: (id) => this.copyContext(id),
      onRenameGroup: (name) => this.openGroupRenameModal(name),
      onNewGroup: () => this.openNewGroupModal(),
      onReorder: (draggedId, targetId, pos) => this.reorderTab(draggedId, targetId, pos),
      aiServices: this.plugin.settings.aiServices,
    });
    contentEl.appendChild(this.tabBar.el);
    this.applySidebarWidth();

    this.resizeHandle = contentEl.createDiv({ cls: "multi-terminal__resize-handle" });
    this.registerDomEvent(this.resizeHandle, "pointerdown", (evt: PointerEvent) =>
      this.beginResize(evt)
    );

    this.paneArea = contentEl.createDiv({ cls: "multi-terminal__pane-area" });

    const debouncedFit = debounce(() => this.fitActiveTab(), 50, true);
    this.registerEvent(this.app.workspace.on("resize", debouncedFit));

    this.startHibernateTimer();
    this.restoreSession();
  }

  async onClose() {
    this.stopHibernateTimer();
    // Cancel any pending debounced write — it would fire after this.tabs is
    // cleared and overwrite the session with an empty array.
    this.scheduleDiskFlush.cancel();
    // Snapshot current state and flush to disk immediately.
    this.syncSession();
    await this.plugin.saveSession();
    for (const tab of this.tabs) tab.dispose();
    this.tabs = [];
    this.plugin.updateStatusBar();
  }

  // ─── Tab creation ────────────────────────────────────────────────────────────

  addTab(opts?: Partial<TabState> & { select?: boolean }) {
    const group = normalizeGroup(opts?.group);
    const groupTabs = this.tabs.filter((t) => normalizeGroup(t.group) === group);
    const maxPos = groupTabs.reduce((m, t) => Math.max(m, t.position), -1);
    const position = opts?.position ?? maxPos + 1;

    const idx = this.tabs.length + 1;
    const tab = new TerminalTab(
      this.plugin.pluginDir,
      this.plugin.settings,
      {
        id: opts?.id,
        name: opts?.name ?? `Terminal ${idx}`,
        cwd: opts?.cwd,
        group: opts?.group,
        pinned: opts?.pinned,
        position,
      },
      {
        onActivity: () => {
          this.renderTabBar();
          this.persistSession();
        },
        onCwdChange: (tab) => {
          // cwd updated by OSC 7 or /proc poll — persist and refresh display
          this.renderTabBar();
          this.persistSession();
          if (tab.id === this.activeTabId) this.notifyStatusBar();
        },
        onAiTurn: (tab) => {
          // Re-render sidebar to update usage gauge
          this.renderTabBar();
          // Probe the service API every 10 turns to get authoritative counts
          const turns = (this.turnsSinceLastProbe.get(tab.id) ?? 0) + 1;
          this.turnsSinceLastProbe.set(tab.id, turns);
          if (turns >= 10) {
            this.turnsSinceLastProbe.set(tab.id, 0);
            void this.probeTab(tab);
          }
        },
        onKeyboardAction: (action, tab) => this.handleKeyboardAction(action, tab),
        onCliDetected: (tab, _service) => {
          // Update tab bar to show the detection badge and gauge
          this.renderTabBar();
          // Probe immediately to get current rate-limit state
          void this.probeTab(tab);
        },
        onCliExited: () => {
          this.renderTabBar();
        },
      }
    );

    tab.mount(this.paneArea);

    const shouldSelect = opts?.select !== false;
    if (!shouldSelect) {
      tab.hide();
    } else {
      for (const t of this.tabs) t.hide();
      tab.show();
      this.activeTabId = tab.id;
    }

    this.tabs.push(tab);
    this.sortTabs();
    this.renderTabBarNow();
    this.persistSession();
    if (shouldSelect) this.notifyStatusBar();
    return tab;
  }

  // ─── Selection ───────────────────────────────────────────────────────────────

  selectTab(id: string) {
    for (const t of this.tabs) {
      if (t.id === id) t.show(); // show() wakes hibernated tabs automatically
      else t.hide();
    }
    this.activeTabId = id;
    this.renderTabBarNow();
    this.persistSession();
    this.notifyStatusBar();
  }

  fitActiveTab() {
    const active = this.tabs.find((t) => t.id === this.activeTabId);
    active?.fit();
  }

  // ─── Close ───────────────────────────────────────────────────────────────────

  closeTab(id: string) {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;

    const wasActive = this.tabs[idx].id === this.activeTabId;
    this.turnsSinceLastProbe.delete(this.tabs[idx].id);
    this.tabs[idx].dispose();
    this.tabs.splice(idx, 1);

    if (this.tabs.length === 0) { this.addTab(); return; }

    if (wasActive) {
      const nextIdx = Math.min(idx, this.tabs.length - 1);
      this.selectTab(this.tabs[nextIdx].id);
    } else {
      this.renderTabBarNow();
      this.persistSession();
    }
  }

  // ─── Public helpers (for commands / keyboard shortcuts) ───────────────────────

  closeActiveTab() { if (this.activeTabId) this.closeTab(this.activeTabId); }
  duplicateActiveTab() { if (this.activeTabId) this.duplicateTab(this.activeTabId); }
  focusActiveTerminal() { this.tabs.find((t) => t.id === this.activeTabId)?.focus(); }
  openRenameModalForActive() { if (this.activeTabId) this.openRenameModal(this.activeTabId); }
  openGroupPickerForActive() { if (this.activeTabId) this.openGroupPickerModal(this.activeTabId); }

  switchToTabByIndex(index: number) {
    if (index >= 0 && index < this.tabs.length) this.selectTab(this.tabs[index].id);
  }

  openTabSwitcher() {
    const items = this.tabs.map((t) => ({
      id: t.id, name: t.name, group: t.group, pinned: t.pinned, unread: t.unread,
    }));
    new TabSwitcherModal(this.app, items, (id) => this.selectTab(id)).open();
  }

  // ─── Rename ──────────────────────────────────────────────────────────────────

  private renameTab(id: string, name: string) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    tab.name = name;
    this.renderTabBarNow();
    this.persistSession();
    this.notifyStatusBar();
  }

  private openRenameModal(id: string) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    new RenameModal(this.app, {
      label: `Rename "${tab.name}"`,
      current: tab.name,
      onCommit: (name) => this.renameTab(id, name),
    }).open();
  }

  // ─── Group change ─────────────────────────────────────────────────────────────

  private changeTabGroup(id: string, group: string) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    tab.group = normalizeGroup(group);
    const peers = this.tabs.filter((t) => t.id !== id && normalizeGroup(t.group) === tab.group);
    tab.position = peers.reduce((m, t) => Math.max(m, t.position), -1) + 1;
    this.sortTabs();
    this.renderTabBarNow();
    this.persistSession();
  }

  private openGroupPickerModal(id: string) {
    const groups = this.getUniqueGroups();
    new GroupPickerModal(this.app, groups, (group) => {
      this.changeTabGroup(id, group);
    }).open();
  }

  private openGroupRenameModal(oldName: string) {
    new RenameModal(this.app, {
      label: `Rename group "${oldName}"`,
      current: oldName,
      onCommit: (newName) => this.renameGroup(oldName, normalizeGroup(newName)),
    }).open();
  }

  private renameGroup(oldName: string, newName: string) {
    if (oldName === newName) return;
    for (const tab of this.tabs) {
      if (normalizeGroup(tab.group) === oldName) tab.group = newName;
    }
    this.sortTabs();
    this.renderTabBarNow();
    this.persistSession();
  }

  private openNewGroupModal() {
    const groups = this.getUniqueGroups();
    new GroupPickerModal(this.app, groups, (group) => {
      this.addTab({ group });
    }).open();
  }

  // ─── Duplicate ───────────────────────────────────────────────────────────────

  private duplicateTab(id: string) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    this.addTab({ ...tab.duplicateState(), name: `${tab.name} Copy`, select: true });
  }

  // ─── Pin ─────────────────────────────────────────────────────────────────────

  private togglePinned(id: string) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    tab.pinned = !tab.pinned;
    this.sortTabs();
    this.renderTabBarNow();
    this.persistSession();
  }

  // ─── Copy context ────────────────────────────────────────────────────────────

  private async copyContext(id: string) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    await navigator.clipboard.writeText(tab.getContextText());
  }

  // ─── Reorder (drag and drop) ──────────────────────────────────────────────────

  private reorderTab(draggedId: string, targetId: string, pos: "before" | "after") {
    if (draggedId === targetId) return;
    const draggedIdx = this.tabs.findIndex((t) => t.id === draggedId);
    const targetIdx = this.tabs.findIndex((t) => t.id === targetId);
    if (draggedIdx === -1 || targetIdx === -1) return;

    const dragged = this.tabs[draggedIdx];
    dragged.group = this.tabs[targetIdx].group;

    this.tabs.splice(draggedIdx, 1);
    const newTargetIdx = this.tabs.findIndex((t) => t.id === targetId);
    this.tabs.splice(pos === "before" ? newTargetIdx : newTargetIdx + 1, 0, dragged);

    this.reassignPositions();
    this.renderTabBarNow();
    this.persistSession();
  }

  private reassignPositions() {
    const byGroup = new Map<string, TerminalTab[]>();
    for (const tab of this.tabs) {
      const g = normalizeGroup(tab.group);
      const arr = byGroup.get(g) ?? [];
      arr.push(tab);
      byGroup.set(g, arr);
    }
    for (const groupTabs of byGroup.values()) {
      groupTabs.forEach((t, i) => { t.position = i; });
    }
  }

  // ─── Preset menu ─────────────────────────────────────────────────────────────

  private openPresetMenu(group?: string) {
    const menu = new Menu();
    for (const preset of this.plugin.settings.commandPresets) {
      menu.addItem((item) =>
        item.setTitle(preset).setIcon("play").onClick(() => {
          const tab = this.addTab({ group, select: true });
          tab.sendText(preset, true);
          new Notice(`Started preset: ${preset}`);
        })
      );
    }
    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle("Custom Command…").setIcon("terminal-square").onClick(() => {
        new CommandModal(this.app, {
          group: normalizeGroup(group),
          hasActiveTab: !!this.activeTabId,
          onSubmit: (command, newTab) => {
            if (newTab) {
              const tab = this.addTab({ group, select: true });
              tab.sendText(command, true);
            } else {
              const active = this.tabs.find((t) => t.id === this.activeTabId);
              active?.sendText(command, true);
            }
          },
        }).open();
      })
    );
    menu.showAtPosition({
      x: Math.round(this.contentEl.getBoundingClientRect().left + 24),
      y: Math.round(this.contentEl.getBoundingClientRect().top + 24),
    });
  }

  // ─── Keyboard action dispatch ────────────────────────────────────────────────

  private handleKeyboardAction(action: KeyboardAction, tab: TerminalTab) {
    switch (action.type) {
      case "new-tab":        this.addTab({ group: tab.group }); break;
      case "close-tab":      this.closeTab(tab.id); break;
      case "duplicate-tab":  this.duplicateTab(tab.id); break;
      case "rename-tab":     this.openRenameModal(tab.id); break;
      case "move-to-group":  this.openGroupPickerModal(tab.id); break;
      case "switch-tab":     this.switchToTabByIndex(action.index); break;
      case "open-switcher":  this.openTabSwitcher(); break;
      case "run-preset":     this.openPresetMenu(tab.group); break;
    }
  }

  // ─── Hibernation ─────────────────────────────────────────────────────────────

  /**
   * Start the periodic sweeper that hibernates tabs idle longer than the
   * configured threshold. Does nothing when hibernateAfterMinutes is 0.
   */
  private startHibernateTimer() {
    if (this.plugin.settings.hibernateAfterMinutes <= 0) return;
    this.hibernateTimer = setInterval(
      () => this.runHibernateSweep(),
      HIBERNATE_CHECK_INTERVAL_MS
    );
  }

  private stopHibernateTimer() {
    if (this.hibernateTimer !== null) {
      clearInterval(this.hibernateTimer);
      this.hibernateTimer = null;
    }
  }

  private runHibernateSweep() {
    const thresholdMs = this.plugin.settings.hibernateAfterMinutes * 60_000;
    if (thresholdMs <= 0) return;
    const now = Date.now();

    for (const tab of this.tabs) {
      if (tab.id === this.activeTabId) continue; // never hibernate the visible tab
      if (tab.isHibernated || tab.hasExited()) continue;

      const lastActivity = tab.lastActivityAt;
      const idleMs = lastActivity > 0 ? now - lastActivity : Infinity;

      if (idleMs > thresholdMs) {
        tab.hibernate();
        this.renderTabBarNow(); // update icon to moon
      }
    }
  }

  // ─── API probing ─────────────────────────────────────────────────────────────

  /**
   * Fetch live rate-limit data from the service API and store it on the tab.
   * Only fires when the detected (or group-matched) service has an apiKey
   * configured. Silently skips on failure.
   */
  private async probeTab(tab: TerminalTab) {
    const service = tab.detectedCliService;
    if (!service?.apiKey?.trim()) return;
    const result = await probeServiceUsage(service);
    if (result) {
      tab.lastProbeResult = result;
      this.renderTabBar();
    }
  }

  // ─── Live settings ───────────────────────────────────────────────────────────

  /** Propagate updated display settings to all open terminal tabs. */
  refreshSettings() {
    for (const tab of this.tabs) {
      tab.applySettings(this.plugin.settings);
    }
  }

  // ─── Session ─────────────────────────────────────────────────────────────────

  private restoreSession() {
    const sessionTabs = this.plugin.session.tabs;
    if (!sessionTabs.length) { this.addTab(); return; }

    for (const tabState of sessionTabs) {
      const isActive = tabState.id === this.plugin.session.activeTabId;
      this.addTab({ ...tabState, select: isActive });
    }
    if (!this.activeTabId && this.tabs.length) {
      this.selectTab(this.tabs[0].id);
    } else {
      this.renderTabBarNow();
      this.notifyStatusBar();
    }
  }


  // ─── Render ──────────────────────────────────────────────────────────────────

  /**
   * Debounced render — collapses rapid bursts (onActivity, onAiTurn, onCwdChange)
   * into a single DOM pass. Structural changes (add/close/reorder) call
   * renderTabBarNow() directly to avoid visible lag.
   */
  private renderTabBar = debounce(() => this.renderTabBarNow(), 80, false);

  private renderTabBarNow() {
    this.sortTabs();
    this.tabBar.render(this.tabs, this.activeTabId);
  }

  private sortTabs() {
    this.tabs.sort((a, b) => {
      const ga = normalizeGroup(a.group);
      const gb = normalizeGroup(b.group);
      if (ga === "Ungrouped" && gb !== "Ungrouped") return -1;
      if (gb === "Ungrouped" && ga !== "Ungrouped") return 1;
      const groupCmp = ga.localeCompare(gb);
      if (groupCmp !== 0) return groupCmp;
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return a.position - b.position;
    });
  }

  // ─── Status bar ──────────────────────────────────────────────────────────────

  private notifyStatusBar() {
    const tab = this.tabs.find((t) => t.id === this.activeTabId);
    this.plugin.updateStatusBar(tab?.name, tab?.group);
  }

  // ─── Sidebar resize ──────────────────────────────────────────────────────────

  private applySidebarWidth() {
    const width = clampSidebarWidth(this.plugin.settings.sidebarWidth);
    this.plugin.settings.sidebarWidth = width;
    this.tabBar.el.style.width = `${width}px`;
    this.tabBar.el.style.minWidth = `${width}px`;
    this.tabBar.el.style.maxWidth = `${width}px`;
  }

  private beginResize(evt: PointerEvent) {
    evt.preventDefault();
    const onMove = (moveEvt: PointerEvent) => {
      const bounds = this.contentEl.getBoundingClientRect();
      const width = clampSidebarWidth(moveEvt.clientX - bounds.left);
      this.plugin.settings.sidebarWidth = width;
      this.applySidebarWidth();
      this.fitActiveTab();
    };
    const onUp = async () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      await this.plugin.saveSettings();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  // ─── Utilities ───────────────────────────────────────────────────────────────

  private getUniqueGroups(): string[] {
    return [...new Set(this.tabs.map((t) => normalizeGroup(t.group)))];
  }
}

function clampSidebarWidth(width: number) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}
