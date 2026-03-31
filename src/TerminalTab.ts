import * as fs from "fs";
import * as nodePath from "path";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { PtyBridge } from "./PtyBridge";
import { probeServiceUsage, type UsageProbeResult } from "./UsageProbe";
import {
  isAiGroup,
  isManualGroup,
  normalizeGroup,
  parseEnvLines,
  type AiServiceConfig,
  type PluginSettings,
  type TabState,
} from "./types";

let tabCounter = 0;
function nextId() {
  return `tab-${Date.now()}-${++tabCounter}`;
}

// ─── Keyboard action types ────────────────────────────────────────────────────

export type KeyboardAction =
  | { type: "new-tab" }
  | { type: "close-tab" }
  | { type: "duplicate-tab" }
  | { type: "rename-tab" }
  | { type: "move-to-group" }
  | { type: "open-switcher" }
  | { type: "run-preset" }
  | { type: "switch-tab"; index: number };

// ─── Callbacks ────────────────────────────────────────────────────────────────

interface TerminalTabCallbacks {
  onActivity?: (tab: TerminalTab) => void;
  onCwdChange?: (tab: TerminalTab) => void;
  onAiTurn?: (tab: TerminalTab) => void;
  onKeyboardAction?: (action: KeyboardAction, tab: TerminalTab) => void;
  /** Fired when a new AI CLI process is detected in this tab's PTY tree. */
  onCliDetected?: (tab: TerminalTab, service: AiServiceConfig) => void;
  /** Fired when a previously detected AI CLI is no longer running. */
  onCliExited?: (tab: TerminalTab) => void;
}

// ─── TerminalTab ──────────────────────────────────────────────────────────────

export class TerminalTab {
  readonly id: string;
  name: string;
  group: string;
  cwd: string;
  pinned: boolean;
  position: number;
  unread = false;
  readonly containerEl: HTMLDivElement;

  /** True while the PTY process has been killed to save resources. */
  isHibernated = false;

  /**
   * Timestamps (ms) of AI turns recorded within the current session.
   * Reset on construction; not persisted.
   */
  readonly aiTurnTimestamps: number[] = [];

  /**
   * The AI service currently detected running in this tab's PTY tree
   * (via /proc child-process scanning). Null when no AI CLI is active.
   */
  detectedCliService: AiServiceConfig | null = null;

  /**
   * Most recent live probe result from the service API.
   * Null until the first successful probe.
   */
  lastProbeResult: UsageProbeResult | null = null;

  private terminal: Terminal;
  private fitAddon: FitAddon;
  private webglAddon: WebglAddon | null = null;
  private pty: PtyBridge;
  private resizeObserver: ResizeObserver;
  private mounted = false;
  private visible = false;
  private exited = false;
  private shellLabel: string;
  private readonly settings: PluginSettings;
  private readonly callbacks: TerminalTabCallbacks;
  private readonly focusTerminal = () => this.terminal.focus();

  /** Timestamp of the last PTY data burst — used for both AI-turn detection
   *  and debounced cwd polling. */
  private lastPtyDataAt = 0;
  private cwdPollTimer: ReturnType<typeof setTimeout> | null = null;
  private cliDetectionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    pluginDir: string,
    settings: PluginSettings,
    state?: Partial<TabState>,
    callbacks: TerminalTabCallbacks = {}
  ) {
    this.id = state?.id ?? nextId();
    this.name = state?.name ?? "Terminal";
    this.group = normalizeGroup(state?.group);
    this.cwd = state?.cwd ?? process.env.HOME ?? "/";
    this.pinned = Boolean(state?.pinned);
    this.position = state?.position ?? 0;
    this.callbacks = callbacks;
    this.settings = settings;

    this.containerEl = document.createElement("div");
    this.containerEl.className = "multi-terminal__pane";

    const theme = resolveTheme(settings.theme);
    this.terminal = new Terminal({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      scrollback: settings.scrollback,
      cursorBlink: settings.cursorBlink,
      theme,
      allowProposedApi: true,
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(new Unicode11Addon());
    this.terminal.unicode.activeVersion = "11";

    // ── OSC 7 handler: shell emits \e]7;file://host/path\a when cwd changes ──
    // Many modern shells support this natively (fish, zsh with plugin, bash with
    // PROMPT_COMMAND). It gives instant, zero-polling cwd updates.
    try {
      (this.terminal.parser as any).registerOscHandler(7, (data: string) => {
        // data = "file://hostname/path"
        const m = data.match(/^file:\/\/[^/]*(.+)$/);
        if (m) {
          const decoded = decodeURIComponent(m[1]);
          if (decoded && decoded !== this.cwd) {
            this.cwd = decoded;
            this.callbacks.onCwdChange?.(this);
          }
        }
        return false; // let xterm also handle it
      });
    } catch {
      // parser API may not be available in all builds
    }

    const shell = resolveShell(settings, this.group);
    const env = resolveEnv(settings, this.group);
    this.shellLabel = nodePath.basename(shell);
    this.pty = new PtyBridge(pluginDir, shell, this.cwd, 80, 24, env);

    this.pty.on("data", (data: string) => {
      this.terminal.write(data);

      const now = Date.now();
      const quietMs = now - this.lastPtyDataAt;

      // AI turn heuristic: count a new "turn" if there was ≥2 s of silence before
      // this burst AND an AI CLI is currently detected running. Gating on
      // detectedCliService avoids counting regular shell output (file listings,
      // builds, etc.) as AI interactions.
      if (quietMs >= 2000 && this.lastPtyDataAt > 0 && this.detectedCliService) {
        this.aiTurnTimestamps.push(now);
        this.callbacks.onAiTurn?.(this);
      }
      this.lastPtyDataAt = now;

      if (!this.visible) {
        this.unread = true;
        this.callbacks.onActivity?.(this);
      }

      // Debounced cwd poll via /proc/pid/cwd (Linux fallback for shells that
      // don't emit OSC 7). Fires 500 ms after the last data burst settles.
      this.scheduleCwdPoll();
    });

    this.pty.on("exit", () => {
      this.exited = true;
      this.terminal.write("\r\n\x1b[2m[Process exited.]\x1b[0m\r\n");
    });
    this.pty.on("error", (err: Error) =>
      this.terminal.write(`\r\n\x1b[31m[Error: ${err.message}]\x1b[0m\r\n`)
    );

    this.terminal.onData((data: string) => this.pty.write(data));
    this.terminal.onResize(({ cols, rows }) => this.pty.resize(cols, rows));

    // Keyboard shortcuts intercepted inside xterm so they work even when the
    // terminal has focus.
    this.terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== "keydown") return true;

      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const m = e.key.match(/^([1-9])$/);
        if (m) {
          this.callbacks.onKeyboardAction?.(
            { type: "switch-tab", index: parseInt(m[1]) - 1 },
            this
          );
          return false;
        }
      }

      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
        switch (e.code) {
          case "KeyT": this.callbacks.onKeyboardAction?.({ type: "new-tab" }, this); return false;
          case "KeyW": this.callbacks.onKeyboardAction?.({ type: "close-tab" }, this); return false;
          case "KeyD": this.callbacks.onKeyboardAction?.({ type: "duplicate-tab" }, this); return false;
          case "KeyR": this.callbacks.onKeyboardAction?.({ type: "rename-tab" }, this); return false;
          case "KeyG": this.callbacks.onKeyboardAction?.({ type: "move-to-group" }, this); return false;
          case "KeyF": this.callbacks.onKeyboardAction?.({ type: "open-switcher" }, this); return false;
          case "KeyP": this.callbacks.onKeyboardAction?.({ type: "run-preset" }, this); return false;
        }
      }

      return true;
    });

    this.resizeObserver = new ResizeObserver(() => {
      if (this.mounted && this.containerEl.style.display !== "none") {
        this.fitAddon.fit();
      }
    });
  }

  mount(parentEl: HTMLElement) {
    parentEl.appendChild(this.containerEl);
    this.terminal.open(this.containerEl);
    this.containerEl.addEventListener("pointerdown", this.focusTerminal);

    this.attachWebgl();
    this.resizeObserver.observe(this.containerEl);
    this.mounted = true;
    this.pty.start();
    this.startCliDetection();
    this.fitWhenReady();
  }

  fit() {
    if (this.mounted && this.containerEl.style.display !== "none") {
      this.fitAddon.fit();
    }
  }

  show() {
    this.visible = true;
    this.unread = false;
    this.containerEl.style.display = "";

    // If the tab was hibernated, wake it when the user switches to it.
    if (this.isHibernated) {
      this.wake();
    }

    // Restore WebGL context when tab becomes visible (reclaimed on hide to
    // stay under the browser's ~16 active WebGL context limit).
    if (!this.webglAddon) {
      this.attachWebgl();
    }

    // Switch to faster detection rate while the tab is active (2 s).
    this.startCliDetection();

    this.fitWhenReady();
  }

  hide() {
    this.visible = false;
    this.containerEl.style.display = "none";

    // Release the WebGL context while hidden to avoid hitting GPU limits.
    // The terminal falls back to canvas/DOM renderer until the tab is shown again.
    if (this.webglAddon) {
      try { this.webglAddon.dispose(); } catch { /* ignore */ }
      this.webglAddon = null;
    }

    // Throttle detection polling while hidden to reduce CPU overhead (10 s).
    this.startCliDetection();
  }

  focus() {
    this.terminal.focus();
  }

  sendText(text: string, appendNewline = false) {
    if (!text) return;
    const suffix = appendNewline ? "\r" : "";
    this.pty.write(text + suffix);
  }

  // ─── Hibernation ────────────────────────────────────────────────────────────

  /**
   * Kill the underlying shell process to free OS resources.
   * The xterm display is preserved (frozen) so the tab still looks useful.
   * Called automatically for tabs that have been hidden past the idle threshold.
   */
  hibernate() {
    if (this.isHibernated || this.exited) return;
    if (this.cwdPollTimer) { clearTimeout(this.cwdPollTimer); this.cwdPollTimer = null; }
    this.stopCliDetection();
    this.pty.kill();
    this.isHibernated = true;
    this.terminal.write(
      "\r\n\x1b[2m[Tab hibernated — select to resume]\x1b[0m\r\n"
    );
  }

  /**
   * Respawn the shell in the last-known cwd.
   * Called automatically when the user selects a hibernated tab.
   */
  wake() {
    if (!this.isHibernated) return;
    this.isHibernated = false;
    this.exited = false;
    this.lastPtyDataAt = 0;
    this.terminal.write(
      "\r\n\x1b[2m[Resuming…]\x1b[0m\r\n"
    );
    this.pty.restart(this.cwd);
    this.startCliDetection();
    this.fitWhenReady();
  }

  /** Timestamp of the last PTY activity (ms). 0 if never active. */
  get lastActivityAt(): number {
    return this.lastPtyDataAt;
  }

  // ─── AI usage ────────────────────────────────────────────────────────────────

  /**
   * Return how many AI turns have been recorded within the last `windowMs` ms.
   */
  getAiTurnCount(windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    // Prune old entries in-place while counting
    let i = 0;
    while (i < this.aiTurnTimestamps.length && this.aiTurnTimestamps[i] < cutoff) i++;
    if (i > 0) this.aiTurnTimestamps.splice(0, i);
    return this.aiTurnTimestamps.length;
  }

  // ─── Live settings ───────────────────────────────────────────────────────────

  /**
   * Apply updated display settings to the running terminal without restarting.
   * Called by TerminalView.refreshSettings() after any settings save.
   */
  applySettings(settings: PluginSettings) {
    this.terminal.options.fontSize   = settings.fontSize;
    this.terminal.options.fontFamily = settings.fontFamily;
    this.terminal.options.scrollback = settings.scrollback;
    this.terminal.options.cursorBlink = settings.cursorBlink;
    this.terminal.options.theme      = resolveTheme(settings.theme);
    this.fitAddon.fit();
  }

  // ─── State ───────────────────────────────────────────────────────────────────

  duplicateState(): Omit<TabState, "id" | "position"> {
    return {
      name: this.name,
      group: this.group,
      cwd: this.cwd,
      pinned: this.pinned,
    };
  }

  toState(): TabState {
    return {
      id: this.id,
      name: this.name,
      group: this.group,
      cwd: this.cwd,
      pinned: this.pinned,
      position: this.position,
    };
  }

  getContextText() {
    return [
      `Title: ${this.name}`,
      `Group: ${this.group}`,
      `CWD: ${this.cwd}`,
      `Shell: ${this.getShellLabel()}`,
    ].join("\n");
  }

  hasExited() {
    return this.exited;
  }

  dispose() {
    if (this.cwdPollTimer) { clearTimeout(this.cwdPollTimer); this.cwdPollTimer = null; }
    this.stopCliDetection();
    this.containerEl.removeEventListener("pointerdown", this.focusTerminal);
    this.resizeObserver.disconnect();
    this.pty.kill();
    if (this.webglAddon) { try { this.webglAddon.dispose(); } catch { /* ignore */ } }
    this.terminal.dispose();
    this.containerEl.remove();
    this.mounted = false;
    this.visible = false;
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private attachWebgl() {
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        this.webglAddon = null;
      });
      this.terminal.loadAddon(webgl);
      this.webglAddon = webgl;
    } catch {
      // DOM renderer fallback
      this.webglAddon = null;
    }
  }

  private fitWhenReady() {
    const attempt = () => {
      const { offsetWidth, offsetHeight } = this.containerEl;
      if (offsetWidth > 0 && offsetHeight > 0) {
        this.fitAddon.fit();
        this.terminal.focus();
      } else {
        requestAnimationFrame(attempt);
      }
    };
    requestAnimationFrame(attempt);
  }

  /** Debounced poll of /proc/<pid>/cwd on Linux. Fires 500 ms after last data. */
  private scheduleCwdPoll() {
    if (process.platform !== "linux") return;
    if (this.cwdPollTimer) clearTimeout(this.cwdPollTimer);
    this.cwdPollTimer = setTimeout(() => {
      this.cwdPollTimer = null;
      const pid = this.pty.pid;
      if (!pid) return;
      try {
        const resolved = fs.readlinkSync(`/proc/${pid}/cwd`);
        if (resolved && resolved !== this.cwd) {
          this.cwd = resolved;
          this.callbacks.onCwdChange?.(this);
        }
      } catch {
        // process may have exited — ignore
      }
    }, 500);
  }

  private getShellLabel() {
    return this.shellLabel;
  }

  // ─── CLI process detection ────────────────────────────────────────────────────

  /**
   * Start (or restart) the CLI detection interval.
   * Rate: 2 s when visible, 10 s when hidden — reduces CPU overhead for
   * background tabs while keeping detection snappy for the active one.
   */
  private startCliDetection() {
    this.stopCliDetection();
    if (process.platform !== "linux") return;
    const interval = this.visible ? 2_000 : 10_000;
    this.cliDetectionTimer = setInterval(() => this.runCliDetection(), interval);
  }

  private stopCliDetection() {
    if (this.cliDetectionTimer !== null) {
      clearInterval(this.cliDetectionTimer);
      this.cliDetectionTimer = null;
    }
  }

  private runCliDetection() {
    const detected = this.detectCliProcess();
    const prev = this.detectedCliService;
    if (detected?.kind === prev?.kind) return; // no change

    this.detectedCliService = detected;
    if (detected) {
      this.callbacks.onCliDetected?.(this, detected);
    } else if (prev) {
      this.callbacks.onCliExited?.(this);
    }
  }

  /**
   * Walk the PTY's process tree (up to 3 levels deep) and return the first
   * AiServiceConfig whose processNames includes the running process, or null.
   *
   * Uses /proc/<pid>/task/<pid>/children (Linux only) and /proc/<pid>/comm
   * to identify process base names without spawning any child processes.
   */
  private detectCliProcess(): AiServiceConfig | null {
    const pid = this.pty.pid;
    if (!pid) return null;

    for (const childPid of this.collectChildPids(pid, 3)) {
      try {
        const comm = fs.readFileSync(`/proc/${childPid}/comm`, "utf8")
          .trim()
          .toLowerCase();
        for (const svc of this.settings.aiServices) {
          for (const name of svc.processNames ?? []) {
            // comm is truncated to 15 chars by the kernel; check prefix to handle that
            const lower = name.toLowerCase();
            if (comm === lower || (lower.length > 15 && comm === lower.slice(0, 15))) {
              return svc;
            }
          }
        }
      } catch {
        // process exited between listing children and reading comm — skip
      }
    }
    return null;
  }

  /**
   * Recursively collect PIDs of all child processes via /proc/<pid>/task/<pid>/children.
   * Depth-first up to `depth` levels. Returns an empty array on non-Linux or failure.
   */
  private collectChildPids(pid: number, depth: number): number[] {
    if (depth === 0) return [];
    const result: number[] = [];
    try {
      const content = fs
        .readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
        .trim();
      if (!content) return result;
      for (const part of content.split(/\s+/)) {
        const child = parseInt(part, 10);
        if (!isNaN(child)) {
          result.push(child);
          result.push(...this.collectChildPids(child, depth - 1));
        }
      }
    } catch {
      // no children file or process gone
    }
    return result;
  }
}

// ─── Shell / env resolution ───────────────────────────────────────────────────

function resolveShell(settings: PluginSettings, group: string) {
  if (isAiGroup(group) && settings.aiShellPath.trim()) return settings.aiShellPath.trim();
  if (isManualGroup(group) && settings.manualShellPath.trim()) return settings.manualShellPath.trim();
  return settings.shellPath;
}

function resolveEnv(settings: PluginSettings, group: string) {
  if (isAiGroup(group)) return parseEnvLines(settings.aiEnvVars);
  if (isManualGroup(group)) return parseEnvLines(settings.manualEnvVars);
  return {};
}

// ─── Theme resolution ─────────────────────────────────────────────────────────

function resolveTheme(setting: string) {
  if (setting === "dark") {
    return {
      background: "#1e1e1e", foreground: "#d4d4d4", cursor: "#d4d4d4",
      selectionBackground: "#264f78", black: "#000000", red: "#cd3131",
      green: "#0dbc79", yellow: "#e5e510", blue: "#2472c8", magenta: "#bc3fbc",
      cyan: "#11a8cd", white: "#e5e5e5", brightBlack: "#666666", brightRed: "#f14c4c",
      brightGreen: "#23d18b", brightYellow: "#f5f543", brightBlue: "#3b8eea",
      brightMagenta: "#d670d6", brightCyan: "#29b8db", brightWhite: "#e5e5e5",
    };
  }
  if (setting === "light") {
    return {
      background: "#ffffff", foreground: "#333333", cursor: "#333333",
      selectionBackground: "#add6ff",
    };
  }
  const style = getComputedStyle(document.body);
  const get = (v: string, fallback: string) => style.getPropertyValue(v).trim() || fallback;
  return {
    background: get("--background-primary", "#1e1e1e"),
    foreground: get("--text-normal", "#dcddde"),
    cursor: get("--text-accent", "#7c6af5"),
    selectionBackground: get("--text-selection", "#264f78"),
  };
}
