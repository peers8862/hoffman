import { App, Modal, SuggestModal, setIcon } from "obsidian";
import { normalizeGroup } from "./types";

// ─── Rename Modal ─────────────────────────────────────────────────────────────
// Generic single-text-input modal used for tab rename and group rename.

export class RenameModal extends Modal {
  private current: string;
  private label: string;
  private onCommit: (value: string) => void;

  constructor(
    app: App,
    opts: { label: string; current: string; onCommit: (value: string) => void }
  ) {
    super(app);
    this.label = opts.label;
    this.current = opts.current;
    this.onCommit = opts.onCommit;
  }

  onOpen() {
    const { titleEl, contentEl } = this;
    titleEl.setText(this.label);

    const input = contentEl.createEl("input", {
      cls: "multi-terminal__modal-input",
    });
    input.type = "text";
    input.value = this.current;

    const submit = () => {
      const val = input.value.trim();
      if (val) this.onCommit(val);
      this.close();
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
      if (e.key === "Escape") this.close();
      e.stopPropagation();
    });

    const btnRow = contentEl.createDiv({ cls: "multi-terminal__modal-buttons" });
    btnRow.createEl("button", { text: "OK", cls: "mod-cta" })
      .addEventListener("click", submit);
    btnRow.createEl("button", { text: "Cancel" })
      .addEventListener("click", () => this.close());

    window.setTimeout(() => { input.focus(); input.select(); }, 30);
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ─── Group Picker Modal ───────────────────────────────────────────────────────
// SuggestModal that shows existing groups + a synthetic "Create: X" entry
// when the query doesn't match any existing group, allowing new group names.

const CREATE_PREFIX = "\x00CREATE:";

export class GroupPickerModal extends SuggestModal<string> {
  private allGroups: string[];
  private onPick: (group: string) => void;

  constructor(app: App, allGroups: string[], onPick: (group: string) => void) {
    super(app);
    this.allGroups = allGroups.length ? allGroups : ["Ungrouped"];
    this.onPick = onPick;
    this.setPlaceholder("Pick a group or type a new name…");
    this.emptyStateText = "Type a name to create a new group";
  }

  getSuggestions(query: string): string[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.allGroups;
    const filtered = this.allGroups.filter((g) => g.toLowerCase().includes(q));
    if (!this.allGroups.some((g) => g.toLowerCase() === q)) {
      filtered.push(`${CREATE_PREFIX}${query.trim()}`);
    }
    return filtered;
  }

  renderSuggestion(item: string, el: HTMLElement) {
    const row = el.createDiv({ cls: "multi-terminal__suggest-row" });
    const icon = row.createSpan({ cls: "multi-terminal__suggest-icon" });
    if (item.startsWith(CREATE_PREFIX)) {
      setIcon(icon, "folder-plus");
      row.createSpan({ text: `Create "${item.slice(CREATE_PREFIX.length)}"`, cls: "multi-terminal__suggest-create" });
    } else {
      setIcon(icon, "folder");
      row.createSpan({ text: item });
    }
  }

  onChooseSuggestion(item: string, _evt: MouseEvent | KeyboardEvent) {
    const name = item.startsWith(CREATE_PREFIX) ? item.slice(CREATE_PREFIX.length) : item;
    this.onPick(normalizeGroup(name));
  }
}

// ─── Command Modal ────────────────────────────────────────────────────────────
// Text-input modal for running a shell command.
// When hasActiveTab is true, shows a "Open in new tab" toggle.

export class CommandModal extends Modal {
  private group?: string;
  private hasActiveTab: boolean;
  private onSubmit: (command: string, newTab: boolean) => void;

  constructor(
    app: App,
    opts: {
      group?: string;
      hasActiveTab: boolean;
      onSubmit: (command: string, newTab: boolean) => void;
    }
  ) {
    super(app);
    this.group = opts.group;
    this.hasActiveTab = opts.hasActiveTab;
    this.onSubmit = opts.onSubmit;
  }

  onOpen() {
    const { titleEl, contentEl } = this;
    titleEl.setText("Run Command");

    if (this.group && this.group !== "Ungrouped") {
      contentEl.createEl("p", {
        text: `Group: ${this.group}`,
        cls: "multi-terminal__modal-context",
      });
    }

    const input = contentEl.createEl("input", {
      cls: "multi-terminal__modal-input",
    });
    input.type = "text";
    input.placeholder = "Command to run…";

    let useNewTab = true;

    if (this.hasActiveTab) {
      const row = contentEl.createDiv({ cls: "multi-terminal__modal-toggle" });
      const label = row.createEl("label");
      const cb = label.createEl("input", { type: "checkbox" });
      cb.checked = true;
      label.createSpan({ text: " Open in new tab" });
      cb.addEventListener("change", () => { useNewTab = cb.checked; });
    }

    const submit = () => {
      const val = input.value.trim();
      if (val) this.onSubmit(val, useNewTab);
      this.close();
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
      if (e.key === "Escape") this.close();
      e.stopPropagation();
    });

    const btnRow = contentEl.createDiv({ cls: "multi-terminal__modal-buttons" });
    btnRow.createEl("button", { text: "Run", cls: "mod-cta" })
      .addEventListener("click", submit);
    btnRow.createEl("button", { text: "Cancel" })
      .addEventListener("click", () => this.close());

    window.setTimeout(() => input.focus(), 30);
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ─── Tab Switcher Modal ───────────────────────────────────────────────────────
// Fuzzy-search across all open terminal tabs by name and group.

export interface TabSwitcherItem {
  id: string;
  name: string;
  group: string;
  pinned: boolean;
  unread: boolean;
}

export class TabSwitcherModal extends SuggestModal<TabSwitcherItem> {
  private tabs: TabSwitcherItem[];
  private onSelect: (id: string) => void;

  constructor(
    app: App,
    tabs: TabSwitcherItem[],
    onSelect: (id: string) => void
  ) {
    super(app);
    this.tabs = tabs;
    this.onSelect = onSelect;
    this.setPlaceholder("Search open terminals…");
    this.emptyStateText = "No terminal tabs open";
    this.setInstructions([
      { command: "↑↓", purpose: "navigate" },
      { command: "↵", purpose: "switch to tab" },
      { command: "esc", purpose: "dismiss" },
    ]);
  }

  getSuggestions(query: string): TabSwitcherItem[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.tabs;
    return this.tabs.filter(
      (t) => t.name.toLowerCase().includes(q) || t.group.toLowerCase().includes(q)
    );
  }

  renderSuggestion(tab: TabSwitcherItem, el: HTMLElement) {
    const row = el.createDiv({ cls: "multi-terminal__suggest-tab" });
    const iconEl = row.createSpan({ cls: "multi-terminal__suggest-tab-icon" });
    setIcon(iconEl, tab.pinned ? "pin" : "terminal");
    const text = row.createDiv({ cls: "multi-terminal__suggest-tab-text" });
    text.createSpan({ text: tab.name, cls: "multi-terminal__suggest-tab-name" });
    text.createSpan({ text: tab.group, cls: "multi-terminal__suggest-tab-group" });
    if (tab.unread) {
      row.createSpan({ text: "new", cls: "multi-terminal__suggest-tab-unread" });
    }
  }

  onChooseSuggestion(tab: TabSwitcherItem, _evt: MouseEvent | KeyboardEvent) {
    this.onSelect(tab.id);
  }
}
