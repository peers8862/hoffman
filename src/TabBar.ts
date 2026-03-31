import { Menu, Notice, setIcon } from "obsidian";
import * as nodePath from "path";
import type { TerminalTab } from "./TerminalTab";
import { normalizeGroup, resolveAiService, type AiServiceConfig } from "./types";

// ─── Callback interface ───────────────────────────────────────────────────────

export interface TabBarOptions {
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: (group?: string) => void;
  onNewPreset: (group?: string) => void;
  /** Called after inline double-click rename commits */
  onRename: (id: string, name: string) => void;
  /** Open the rename modal for a tab (from … menu) */
  onRequestRename: (id: string) => void;
  /** Open the group picker modal for a tab */
  onRequestChangeGroup: (id: string) => void;
  /** Quick direct-move to a known group name (skips modal) */
  onDirectMoveToGroup?: (id: string, group: string) => void;
  onDuplicate: (id: string) => void;
  onTogglePin: (id: string) => void;
  onCopyContext: (id: string) => Promise<void>;
  /** Open the group rename modal */
  onRenameGroup: (groupName: string) => void;
  /** Open the new-group modal then create a tab */
  onNewGroup: () => void;
  /** Drag-and-drop reorder: move draggedId before/after targetId */
  onReorder: (draggedId: string, targetId: string, position: "before" | "after") => void;
  /** AI service configs used to resolve usage display */
  aiServices: AiServiceConfig[];
}

// ─── TabBar ───────────────────────────────────────────────────────────────────

export class TabBar {
  readonly el: HTMLDivElement;

  private opts: TabBarOptions;
  private collapsedGroups = new Set<string>();
  private draggedId: string | null = null;

  constructor(opts: TabBarOptions) {
    this.opts = opts;
    this.el = document.createElement("div");
    this.el.className = "multi-terminal__tabbar";
  }

  render(tabs: TerminalTab[], activeId: string | null) {
    this.el.empty();

    const groupedTabs = new Map<string, TerminalTab[]>();
    for (const tab of tabs) {
      const g = normalizeGroup(tab.group);
      const arr = groupedTabs.get(g) ?? [];
      arr.push(tab);
      groupedTabs.set(g, arr);
    }

    const orderedGroups = [...groupedTabs.keys()].sort((a, b) => {
      if (a === "Ungrouped") return -1;
      if (b === "Ungrouped") return 1;
      return a.localeCompare(b);
    });

    for (const group of orderedGroups) {
      this.renderGroup(group, groupedTabs.get(group) ?? [], activeId, orderedGroups);
    }

    const footerEl = this.el.createDiv({ cls: "multi-terminal__tabbar-footer" });

    const addBtn = footerEl.createEl("button", {
      cls: "multi-terminal__add-tab",
      attr: { "aria-label": "New terminal" },
    });
    setIcon(addBtn, "plus");
    addBtn.addEventListener("click", () => this.opts.onNew());

    const addPresetBtn = footerEl.createEl("button", {
      cls: "multi-terminal__add-tab",
      attr: { "aria-label": "New preset terminal" },
    });
    setIcon(addPresetBtn, "play");
    addPresetBtn.addEventListener("click", () => this.opts.onNewPreset());

    const addGroupBtn = footerEl.createEl("button", {
      cls: "multi-terminal__add-tab",
      attr: { "aria-label": "New group" },
    });
    setIcon(addGroupBtn, "folder-plus");
    addGroupBtn.addEventListener("click", () => this.opts.onNewGroup());
  }

  // ─── Group section ──────────────────────────────────────────────────────────

  private renderGroup(
    group: string,
    tabs: TerminalTab[],
    activeId: string | null,
    allGroups: string[]
  ) {
    const collapsed = this.collapsedGroups.has(group);
    const sectionEl = this.el.createDiv({ cls: "multi-terminal__group" });
    if (collapsed) sectionEl.addClass("is-collapsed");
    sectionEl.style.setProperty("--multi-terminal-group-accent", groupAccentColor(group));

    const headerEl = sectionEl.createDiv({ cls: "multi-terminal__group-header" });

    const chevronBtn = headerEl.createEl("button", {
      cls: "multi-terminal__group-collapse",
      attr: { "aria-label": collapsed ? `Expand ${group}` : `Collapse ${group}` },
    });
    setIcon(chevronBtn, collapsed ? "chevron-right" : "chevron-down");
    chevronBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.collapsedGroups.has(group)) {
        this.collapsedGroups.delete(group);
      } else {
        this.collapsedGroups.add(group);
      }
      sectionEl.toggleClass("is-collapsed", this.collapsedGroups.has(group));
      setIcon(chevronBtn, this.collapsedGroups.has(group) ? "chevron-right" : "chevron-down");
    });

    headerEl.createEl("span", { cls: "multi-terminal__group-label", text: group });
    headerEl.createEl("span", {
      cls: "multi-terminal__group-count",
      text: String(tabs.length),
    });

    if (group !== "Ungrouped") {
      const renameGroupBtn = headerEl.createEl("button", {
        cls: "multi-terminal__group-action",
        attr: { "aria-label": `Rename group ${group}` },
      });
      setIcon(renameGroupBtn, "pencil");
      renameGroupBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.opts.onRenameGroup(group);
      });
    }

    const presetBtn = headerEl.createEl("button", {
      cls: "multi-terminal__group-action",
      attr: { "aria-label": `New preset terminal in ${group}` },
    });
    setIcon(presetBtn, "play");
    presetBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.opts.onNewPreset(group);
    });

    const groupAddBtn = headerEl.createEl("button", {
      cls: "multi-terminal__group-action",
      attr: { "aria-label": `New terminal in ${group}` },
    });
    setIcon(groupAddBtn, "plus");
    groupAddBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.opts.onNew(group);
    });

    const listEl = sectionEl.createDiv({ cls: "multi-terminal__group-list" });
    for (const tab of tabs) {
      this.renderTab(listEl, tab, activeId, allGroups);
    }
  }

  // ─── Individual tab row ─────────────────────────────────────────────────────

  private renderTab(
    parentEl: HTMLElement,
    tab: TerminalTab,
    activeId: string | null,
    groups: string[]
  ) {
    const tabEl = parentEl.createDiv({ cls: "multi-terminal__tab" });
    tabEl.style.setProperty("--multi-terminal-group-accent", groupAccentColor(tab.group));
    if (tab.id === activeId) tabEl.addClass("is-active");
    if (tab.unread) tabEl.addClass("has-unread");
    if (tab.pinned) tabEl.addClass("is-pinned");
    if (tab.hasExited()) tabEl.addClass("is-exited");
    if (tab.isHibernated) tabEl.addClass("is-hibernated");
    tabEl.dataset.tabId = tab.id;
    tabEl.title = `${tab.name}\n${tab.cwd}`;
    tabEl.setAttribute("draggable", "true");

    const icon = tabEl.createDiv({ cls: "multi-terminal__tab-icon" });
    setIcon(icon, tab.isHibernated ? "moon" : tab.pinned ? "pin" : "terminal");

    const textEl = tabEl.createDiv({ cls: "multi-terminal__tab-text" });
    const label = textEl.createEl("span", {
      cls: "multi-terminal__tab-label",
      text: tab.name,
    });
    textEl.createEl("span", {
      cls: "multi-terminal__tab-meta",
      text: formatCwd(tab.cwd),
    });
    const unreadEl = textEl.createEl("span", { cls: "multi-terminal__tab-unread" });
    unreadEl.textContent = tab.unread ? "new" : "";

    // AI usage gauge — prefer process-detected service, fall back to group match
    const detectedService = tab.detectedCliService;
    const service = detectedService ?? resolveAiService(tab.group, this.opts.aiServices);
    if (service) {
      this.renderAiUsage(textEl, tab, service, !!detectedService);
    }

    // Actions: pin + … + close
    const actionsEl = tabEl.createDiv({ cls: "multi-terminal__tab-actions" });

    const pinBtn = actionsEl.createEl("button", {
      cls: "multi-terminal__tab-action",
      attr: { "aria-label": `${tab.pinned ? "Unpin" : "Pin"} ${tab.name}` },
    });
    setIcon(pinBtn, tab.pinned ? "pin-off" : "pin");
    pinBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.opts.onTogglePin(tab.id);
    });

    const moreBtn = actionsEl.createEl("button", {
      cls: "multi-terminal__tab-action",
      attr: { "aria-label": `More actions for ${tab.name}` },
    });
    setIcon(moreBtn, "ellipsis");
    moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.openTabMenu(e, tab, label, groups);
    });

    const closeBtn = actionsEl.createEl("button", {
      cls: "multi-terminal__tab-close",
      attr: { "aria-label": "Close terminal" },
    });
    setIcon(closeBtn, "x");
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.opts.onClose(tab.id);
    });

    label.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      this.startInlineRename(tab, label);
    });

    tabEl.addEventListener("click", () => this.opts.onSelect(tab.id));

    tabEl.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.openTabMenu(e, tab, label, groups);
    });

    // Drag & drop
    tabEl.addEventListener("dragstart", (e) => {
      this.draggedId = tab.id;
      tabEl.addClass("is-dragging");
      e.dataTransfer!.effectAllowed = "move";
      e.dataTransfer!.setData("text/plain", tab.id);
    });
    tabEl.addEventListener("dragend", () => {
      this.draggedId = null;
      tabEl.removeClass("is-dragging");
      this.clearDragIndicators();
    });
    tabEl.addEventListener("dragover", (e) => {
      if (!this.draggedId || this.draggedId === tab.id) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "move";
      const pos = this.getDropPosition(e, tabEl);
      this.clearDragIndicators();
      tabEl.addClass(pos === "before" ? "drag-over-top" : "drag-over-bottom");
    });
    tabEl.addEventListener("dragleave", () => {
      tabEl.removeClass("drag-over-top");
      tabEl.removeClass("drag-over-bottom");
    });
    tabEl.addEventListener("drop", (e) => {
      e.preventDefault();
      if (!this.draggedId || this.draggedId === tab.id) return;
      const pos = this.getDropPosition(e, tabEl);
      const draggedId = this.draggedId;
      this.draggedId = null;
      this.clearDragIndicators();
      this.opts.onReorder(draggedId, tab.id, pos);
    });
  }

  // ─── AI usage gauge ─────────────────────────────────────────────────────────

  private renderAiUsage(
    parentEl: HTMLElement,
    tab: TerminalTab,
    service: AiServiceConfig,
    detected: boolean
  ) {
    const usageEl = parentEl.createDiv({ cls: "multi-terminal__tab-usage" });

    // Live probe result (from API headers) takes precedence over local count.
    const probe = tab.lastProbeResult;
    let pct: number;
    let labelText: string;
    let isLive = false;

    if (probe?.liveFromApi && service.quotaPerWindow > 0) {
      // API probe: show used = limit − remaining
      const used = probe.limit - probe.remaining;
      pct = Math.min(100, Math.round((used / probe.limit) * 100));
      const resetLabel = probe.resetAt
        ? ` · resets ${new Date(probe.resetAt).toLocaleTimeString()}`
        : "";
      usageEl.title =
        `${service.label}: ${probe.remaining} remaining / ${probe.limit}${resetLabel}`;
      labelText = `${probe.remaining}/${probe.limit}`;
      isLive = true;
    } else if (service.quotaPerWindow > 0) {
      const windowMs = service.windowHours * 3_600_000;
      const count = tab.getAiTurnCount(windowMs);
      pct = Math.min(100, Math.round((count / service.quotaPerWindow) * 100));
      usageEl.title =
        `${service.label}: ${count} / ${service.quotaPerWindow} turns in ${service.windowHours}h window`;
      labelText =
        count > 0 ? `${count}/${service.quotaPerWindow}` : `0/${service.quotaPerWindow} · ${service.label}`;
    } else {
      // Unlimited / no quota (e.g. Ollama) — just show detection badge
      pct = 0;
      usageEl.title = `${service.label} detected`;
      labelText = service.label;
    }

    if (service.quotaPerWindow > 0) {
      const barEl = usageEl.createDiv({ cls: "multi-terminal__tab-usage-bar" });
      const fillEl = barEl.createDiv({ cls: "multi-terminal__tab-usage-fill" });
      fillEl.style.width = `${pct}%`;
      if (pct >= 80) fillEl.addClass("is-high");
      else if (pct >= 50) fillEl.addClass("is-mid");
    }

    const labelEl = usageEl.createEl("span", {
      cls: "multi-terminal__tab-usage-label",
      text: labelText,
    });
    if (isLive) labelEl.addClass("is-live");

    // Small green dot when detected by process scan (not just group name match)
    if (detected) {
      usageEl.createEl("span", {
        cls: "multi-terminal__tab-detected",
        attr: { title: `${service.label} process detected` },
      });
    }
  }

  // ─── Tab context menu ────────────────────────────────────────────────────────

  private openTabMenu(
    evt: MouseEvent,
    tab: TerminalTab,
    label: HTMLElement,
    groups: string[]
  ) {
    const menu = new Menu();

    menu.addItem((item) =>
      item
        .setTitle(tab.pinned ? "Unpin" : "Pin")
        .setIcon(tab.pinned ? "pin-off" : "pin")
        .onClick(() => this.opts.onTogglePin(tab.id))
    );
    menu.addItem((item) =>
      item.setTitle("Duplicate").setIcon("copy-plus").onClick(() => {
        this.opts.onDuplicate(tab.id);
      })
    );
    menu.addItem((item) =>
      item.setTitle("Rename…").setIcon("pencil").onClick(() => {
        this.opts.onRequestRename(tab.id);
      })
    );
    menu.addItem((item) =>
      item.setTitle("Copy Context").setIcon("copy").onClick(async () => {
        await this.opts.onCopyContext(tab.id);
        new Notice(`Copied context for ${tab.name}`);
      })
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle("Move to Group…").setIcon("folder").onClick(() => {
        this.opts.onRequestChangeGroup(tab.id);
      })
    );
    for (const group of groups) {
      if (group === normalizeGroup(tab.group)) continue;
      menu.addItem((item) =>
        item.setTitle(`  → ${group}`).setIcon("folder").onClick(() => {
          this.opts.onDirectMoveToGroup?.(tab.id, group);
        })
      );
    }

    menu.showAtMouseEvent(evt);
  }

  // ─── Inline rename ───────────────────────────────────────────────────────────

  private startInlineRename(tab: TerminalTab, label: HTMLElement) {
    const input = document.createElement("input");
    input.className = "multi-terminal__tab-rename";
    input.type = "text";
    input.value = tab.name;
    label.replaceWith(input);
    input.focus();
    input.select();

    const commit = () => {
      const trimmed = input.value.trim();
      input.replaceWith(label);
      if (trimmed && trimmed !== tab.name) {
        label.textContent = trimmed;
        this.opts.onRename(tab.id, trimmed);
        return;
      }
      label.textContent = tab.name;
    };

    input.addEventListener("blur", commit, { once: true });
    input.addEventListener("keydown", (ke) => {
      if (ke.key === "Enter") input.blur();
      if (ke.key === "Escape") { input.value = tab.name; input.blur(); }
      ke.stopPropagation();
    });
  }

  // ─── Drag helpers ────────────────────────────────────────────────────────────

  private getDropPosition(e: DragEvent, el: HTMLElement): "before" | "after" {
    const rect = el.getBoundingClientRect();
    return e.clientY < rect.top + rect.height / 2 ? "before" : "after";
  }

  private clearDragIndicators() {
    this.el.querySelectorAll(".drag-over-top, .drag-over-bottom").forEach((el) => {
      (el as HTMLElement).classList.remove("drag-over-top", "drag-over-bottom");
    });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Strip the user's home directory from the path so the sidebar shows only
 * the meaningful sub-path. E.g. /home/mp/projects/foo → /projects/foo.
 * Paths outside HOME are shown as-is.
 */
export function formatCwd(cwd: string): string {
  if (!cwd) return "";
  const home = (typeof process !== "undefined" ? process.env.HOME : undefined) ?? "";
  if (home && cwd === home) return "/";
  if (home && cwd.startsWith(home + nodePath.sep)) {
    return cwd.slice(home.length); // keeps the leading "/"
  }
  return cwd;
}

export function groupAccentColor(group: string) {
  let hash = 0;
  for (const char of group) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return `hsl(${hash} 65% 55%)`;
}
