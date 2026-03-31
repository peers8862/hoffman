export interface PluginSettings {
  shellPath: string;
  fontSize: number;
  fontFamily: string;
  scrollback: number;
  theme: "dark" | "light" | "obsidian";
  cursorBlink: boolean;
  sidebarWidth: number;
  aiShellPath: string;
  aiEnvVars: string;
  manualShellPath: string;
  manualEnvVars: string;
  commandPresets: string[];
  /** Minutes of inactivity before a hidden tab's PTY is hibernated. 0 = disabled. */
  hibernateAfterMinutes: number;
  /** AI service configurations for usage tracking. */
  aiServices: AiServiceConfig[];
}

/**
 * Describes one AI service for usage tracking.
 * kind: machine identifier ("claude" | "openai" | "gemini" | "custom")
 * label: display name
 * quotaPerWindow: max interactions allowed in the time window
 * windowHours: length of the rolling quota window in hours
 * groupPattern: substring match (case-insensitive) against the group name
 *               to auto-associate tabs with this service
 * processNames: base process names (comm) to detect in the PTY's child tree;
 *               e.g. ["claude", "claude-code"] — checked case-insensitively
 * apiKey: optional key for live rate-limit header probing
 */
export interface AiServiceConfig {
  kind: string;
  label: string;
  quotaPerWindow: number;
  windowHours: number;
  groupPattern: string;
  processNames?: string[];
  apiKey?: string;
}

export interface TabState {
  id: string;
  name: string;
  group?: string;
  cwd?: string;
  pinned?: boolean;
  position?: number;
}

export interface SessionState {
  tabs: TabState[];
  activeTabId: string | null;
}

export interface PluginData {
  settings: PluginSettings;
  session: SessionState;
}

export const DEFAULT_AI_SERVICES: AiServiceConfig[] = [
  {
    kind: "claude",
    label: "Claude",
    quotaPerWindow: 45,
    windowHours: 5,
    groupPattern: "claude",
    processNames: ["claude", "claude-code"],
  },
  {
    kind: "openai",
    label: "OpenAI / Codex",
    quotaPerWindow: 50,
    windowHours: 24,
    groupPattern: "codex",
    processNames: ["codex", "openai"],
  },
  {
    kind: "custom",
    label: "Aider",
    quotaPerWindow: 100,
    windowHours: 24,
    groupPattern: "aider",
    processNames: ["aider"],
  },
  {
    kind: "gemini",
    label: "Gemini",
    quotaPerWindow: 60,
    windowHours: 24,
    groupPattern: "gemini",
    processNames: ["gemini", "google-gemini"],
  },
  {
    kind: "custom",
    label: "Ollama",
    quotaPerWindow: 0,
    windowHours: 24,
    groupPattern: "ollama",
    processNames: ["ollama"],
  },
  {
    kind: "custom",
    label: "LLM / sgpt",
    quotaPerWindow: 0,
    windowHours: 24,
    groupPattern: "llm",
    processNames: ["llm", "sgpt"],
  },
];

export const DEFAULT_SETTINGS: PluginSettings = {
  shellPath: process.env.SHELL ?? "/bin/bash",
  fontSize: 13,
  fontFamily: "monospace",
  scrollback: 5000,
  theme: "obsidian",
  cursorBlink: true,
  sidebarWidth: 148,
  aiShellPath: "",
  aiEnvVars: "CODEX_TERMINAL_MODE=ai",
  manualShellPath: "",
  manualEnvVars: "CODEX_TERMINAL_MODE=manual",
  commandPresets: [
    "git status",
    "npm run dev",
    "npm test",
    "pytest -q",
  ],
  hibernateAfterMinutes: 30,
  aiServices: DEFAULT_AI_SERVICES,
};

export const DEFAULT_SESSION: SessionState = {
  tabs: [],
  activeTabId: null,
};

export function normalizeGroup(group?: string) {
  const trimmed = group?.trim();
  return trimmed || "Ungrouped";
}

export function isAiGroup(group?: string) {
  return normalizeGroup(group).toLowerCase() === "ai";
}

export function isManualGroup(group?: string) {
  return normalizeGroup(group).toLowerCase() === "manual";
}

export function parseEnvLines(input: string) {
  const env: Record<string, string> = {};
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();
    if (key) env[key] = value;
  }
  return env;
}

/**
 * Returns the AiServiceConfig whose groupPattern matches the given group name,
 * or null if no service is configured for it.
 */
export function resolveAiService(
  group: string,
  services: AiServiceConfig[]
): AiServiceConfig | null {
  const lower = group.toLowerCase();
  return services.find((s) => s.groupPattern && lower.includes(s.groupPattern.toLowerCase())) ?? null;
}
