# Multi Terminal

An Obsidian plugin that embeds a full PTY terminal with a vertical tab sidebar. Supports multiple sessions, tab groups, drag-and-drop reordering, hibernation, and AI usage tracking.

Desktop only (requires Electron / node-pty).

---

## Features

- **Vertical tab sidebar** with collapsible groups and resize handle
- **Multiple terminal sessions** — new, duplicate, rename, pin, close
- **Tab groups** — group tabs with per-group shell/env overrides, color-coded accents
- **Drag-and-drop reorder** within and across groups
- **Session persistence** — tabs, names, groups, and cwd restored on reload
- **Hibernation** — idle background tabs have their PTY killed to save RAM; automatically respawned on selection
- **CWD tracking** — OSC 7 for instant updates, `/proc/<pid>/cwd` fallback on Linux
- **AI usage gauges** — per-tab turn counter + live rate-limit probing via API headers (Anthropic, OpenAI, Gemini)
- **CLI process detection** — `/proc` tree walk identifies which AI tool is running in a tab (Linux)
- **Command presets** — one-click tab launchers for common commands
- **Tab switcher** — fuzzy search across all open tabs (Ctrl+Shift+F or command palette)
- **WebGL renderer** — contexts released on hide, reacquired on show, to stay under the browser's ~16 context limit

---

## Architecture

```
src/
  main.ts          Plugin entry point — commands, ribbon, settings, status bar
  TerminalView.ts  ItemView container — tab lifecycle, session persistence, hibernation sweep
  TerminalTab.ts   Single terminal instance — xterm.js, PTY, OSC 7, CLI detection, AI turns
  TabBar.ts        Sidebar UI — group headers, tab rows, AI usage gauge, drag-and-drop
  PtyBridge.ts     Thin EventEmitter wrapper around node-pty (spawn/resize/kill/restart)
  Modals.ts        Rename, GroupPicker, Command, TabSwitcher modals
  SettingsTab.ts   Plugin settings UI
  UsageProbe.ts    Live rate-limit header fetching from AI service APIs
  types.ts         Shared types, defaults, and pure helpers
```

### Key data flows

**Tab lifecycle**
`TerminalView.addTab()` → `new TerminalTab()` → `tab.mount()` → `PtyBridge.start()`

**State persistence**
Every structural change calls `persistSession()` which does an immediate in-memory sync (`plugin.session = …`) then schedules a debounced 300 ms disk flush. `onClose()` cancels the debounce and flushes synchronously to prevent an empty-array overwrite.

**Tab bar rendering**
Two render paths:
- `renderTabBarNow()` — immediate, used for structural changes (add, close, select, rename, reorder)
- `renderTabBar()` — debounced 80 ms, used for high-frequency callbacks (PTY activity, AI turns, cwd changes)

**AI turn counting**
`TerminalTab` watches for PTY output bursts that arrive ≥2 s after a quiet period. A turn is only recorded when `detectedCliService !== null` (an AI CLI is confirmed running in the PTY tree), preventing shell output from inflating counts. Probe calls to the service API fire every 10 locally-counted turns.

---

## Development

### Prerequisites

- Node.js 18+
- An Obsidian vault for testing

### Setup

```sh
npm install
```

### Build

```sh
npm run dev      # watch mode with inline source maps
npm run build    # production bundle (minified, no source maps)
```

The build copies node-pty's JS and native binaries from `node_modules/node-pty` into `node_modules_bundled/node-pty`. The plugin `require()`s it at runtime via `__dirname` so it works inside Electron regardless of the vault's node environment.

### Install into Obsidian

Symlink or copy the plugin directory into your vault's `.obsidian/plugins/` folder:

```sh
ln -s /path/to/this/repo ~/.obsidian-vault/.obsidian/plugins/multi-terminal
```

Then enable the plugin in Obsidian → Settings → Community plugins.

### Project files

| File | Purpose |
|---|---|
| `main.js` | Compiled output — committed so the plugin works without a build step |
| `node_modules_bundled/` | Bundled node-pty — committed alongside `main.js` |
| `manifest.json` | Obsidian plugin manifest (id, version, minAppVersion) |
| `styles.css` | Plugin CSS |

---

## Configuration

Settings are under Obsidian → Settings → Multi Terminal.

| Setting | Default | Notes |
|---|---|---|
| Shell | `$SHELL` | Default shell for all groups |
| AI group shell | — | Shell override for tabs in the "AI" group |
| Manual group shell | — | Shell override for tabs in the "Manual" group |
| Font size | 13 | px |
| Font family | monospace | |
| Scrollback | 5000 | Lines |
| Theme | Follow Obsidian | `obsidian` / `dark` / `light` |
| Cursor blink | on | |
| Sidebar width | 148 px | Also draggable at runtime |
| Auto-hibernate | 30 min | 0 = disabled |
| AI group env vars | `CODEX_TERMINAL_MODE=ai` | KEY=VALUE per line |
| Manual group env vars | `CODEX_TERMINAL_MODE=manual` | KEY=VALUE per line |
| Command presets | — | One command per line |
| AI services | see below | Usage tracking config |

Display settings (font, theme, scrollback, cursor) are applied live to all open terminals without restarting.

### AI services

Each service entry controls usage tracking for one AI tool:

| Field | Description |
|---|---|
| Label | Display name |
| Group pattern | Case-insensitive substring matched against the tab's group name |
| Quota | Max interactions per window (0 = unlimited) |
| Hours | Rolling window length |
| Process names | Space-separated process comm names for auto-detection (Linux) |
| API key | Optional — enables live rate-limit header probing |

Built-in entries: Claude, OpenAI/Codex, Gemini, Aider, Ollama, LLM/sgpt.

---

## Keyboard shortcuts

Shortcuts work when the terminal has focus.

| Shortcut | Action |
|---|---|
| Alt+1…9 | Switch to tab by index |
| Ctrl+Shift+T | New tab |
| Ctrl+Shift+W | Close tab |
| Ctrl+Shift+D | Duplicate tab |
| Ctrl+Shift+R | Rename tab |
| Ctrl+Shift+G | Move tab to group |
| Ctrl+Shift+F | Open tab switcher |
| Ctrl+Shift+P | Open preset menu |

All actions are also available as Obsidian commands (bindable in Settings → Hotkeys).

---

## Platform notes

- **Linux** — full feature set: OSC 7 + `/proc` cwd fallback, CLI process detection
- **macOS** — OSC 7 cwd tracking, no `/proc`-based CLI detection
- **Windows** — not tested; node-pty should work but is untested in this build setup

---

## License

MIT
