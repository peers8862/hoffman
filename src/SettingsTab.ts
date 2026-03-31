import { App, PluginSettingTab, Setting } from "obsidian";
import type MultiTerminalPlugin from "./main";
import { DEFAULT_AI_SERVICES, type AiServiceConfig } from "./types";

export class SettingsTab extends PluginSettingTab {
  plugin: MultiTerminalPlugin;

  constructor(app: App, plugin: MultiTerminalPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Multi Terminal" });

    // ─── Shell ──────────────────────────────────────────────────────────────

    new Setting(containerEl)
      .setName("Shell")
      .setDesc("Default shell path for standard groups")
      .addText((text) =>
        text
          .setPlaceholder("/bin/bash")
          .setValue(this.plugin.settings.shellPath)
          .onChange(async (value) => {
            this.plugin.settings.shellPath = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("AI group shell override")
      .setDesc('Optional shell path used when a tab is in the "AI" group')
      .addText((text) =>
        text
          .setPlaceholder("Use default shell")
          .setValue(this.plugin.settings.aiShellPath)
          .onChange(async (value) => {
            this.plugin.settings.aiShellPath = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Manual group shell override")
      .setDesc('Optional shell path used when a tab is in the "Manual" group')
      .addText((text) =>
        text
          .setPlaceholder("Use default shell")
          .setValue(this.plugin.settings.manualShellPath)
          .onChange(async (value) => {
            this.plugin.settings.manualShellPath = value;
            await this.plugin.saveSettings();
          })
      );

    // ─── Display ────────────────────────────────────────────────────────────

    new Setting(containerEl)
      .setName("Font size")
      .setDesc("Terminal font size in pixels")
      .addSlider((slider) =>
        slider
          .setLimits(8, 28, 1)
          .setValue(this.plugin.settings.fontSize)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.fontSize = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Font family")
      .setDesc('Terminal font family (e.g. "Fira Code", monospace)')
      .addText((text) =>
        text
          .setPlaceholder("monospace")
          .setValue(this.plugin.settings.fontFamily)
          .onChange(async (value) => {
            this.plugin.settings.fontFamily = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Scrollback lines")
      .setDesc("Number of lines to keep in terminal scrollback buffer")
      .addText((text) =>
        text
          .setPlaceholder("5000")
          .setValue(String(this.plugin.settings.scrollback))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.scrollback = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Theme")
      .setDesc("Color theme for the terminal")
      .addDropdown((drop) =>
        drop
          .addOptions({
            obsidian: "Follow Obsidian theme",
            dark: "Dark",
            light: "Light",
          })
          .setValue(this.plugin.settings.theme)
          .onChange(async (value) => {
            this.plugin.settings.theme = value as "dark" | "light" | "obsidian";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Cursor blink")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.cursorBlink)
          .onChange(async (value) => {
            this.plugin.settings.cursorBlink = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sidebar width")
      .setDesc("Width of the terminal tabs sidebar in pixels")
      .addSlider((slider) =>
        slider
          .setLimits(120, 420, 4)
          .setValue(this.plugin.settings.sidebarWidth)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.sidebarWidth = value;
            await this.plugin.saveSettings();
          })
      );

    // ─── Performance ────────────────────────────────────────────────────────

    containerEl.createEl("h3", { text: "Performance" });

    new Setting(containerEl)
      .setName("Auto-hibernate idle tabs")
      .setDesc(
        "Kill the shell process for background tabs that have been idle for this many minutes. " +
        "The tab is restored when you select it. Set to 0 to disable."
      )
      .addSlider((slider) =>
        slider
          .setLimits(0, 120, 5)
          .setValue(this.plugin.settings.hibernateAfterMinutes)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.hibernateAfterMinutes = value;
            await this.plugin.saveSettings();
          })
      );

    // ─── Group Environments ──────────────────────────────────────────────────

    containerEl.createEl("h3", { text: "Group Environments" });

    const aiEnvSetting = new Setting(containerEl)
      .setName("AI group env vars")
      .setDesc("One KEY=VALUE pair per line")
      .addTextArea((text) => {
        text
          .setPlaceholder("CODEX_TERMINAL_MODE=ai")
          .setValue(this.plugin.settings.aiEnvVars)
          .onChange(async (value) => {
            this.plugin.settings.aiEnvVars = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 4;
        text.inputEl.addClass("multi-terminal__settings-textarea");
      });
    aiEnvSetting.settingEl.addClass("multi-terminal__settings-block");

    const manualEnvSetting = new Setting(containerEl)
      .setName("Manual group env vars")
      .setDesc("One KEY=VALUE pair per line")
      .addTextArea((text) => {
        text
          .setPlaceholder("CODEX_TERMINAL_MODE=manual")
          .setValue(this.plugin.settings.manualEnvVars)
          .onChange(async (value) => {
            this.plugin.settings.manualEnvVars = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 4;
        text.inputEl.addClass("multi-terminal__settings-textarea");
      });
    manualEnvSetting.settingEl.addClass("multi-terminal__settings-block");

    // ─── Command Presets ────────────────────────────────────────────────────

    containerEl.createEl("h3", { text: "Command Presets" });

    const presetSetting = new Setting(containerEl)
      .setName("Preset commands")
      .setDesc("One command per line for quick new-tab launches")
      .addTextArea((text) => {
        text
          .setPlaceholder("git status\nnpm run dev\npytest -q")
          .setValue(this.plugin.settings.commandPresets.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.commandPresets = value
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 6;
        text.inputEl.addClass("multi-terminal__settings-textarea");
      });
    presetSetting.settingEl.addClass("multi-terminal__settings-block");

    // ─── AI Usage Tracking ──────────────────────────────────────────────────

    containerEl.createEl("h3", { text: "AI Usage Tracking" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Configure AI services to show usage gauges on terminal tabs. " +
        "A tab is associated with a service when its group name contains the service's group pattern (case-insensitive). " +
        "Turns are counted locally using a heuristic: PTY output that arrives ≥2 s after a quiet period is counted as one interaction.",
    });

    this.renderAiServicesTable(containerEl);

    new Setting(containerEl).addButton((btn) =>
      btn
        .setButtonText("Add service")
        .setIcon("plus")
        .onClick(async () => {
          this.plugin.settings.aiServices.push({
            kind: "custom",
            label: "My Service",
            quotaPerWindow: 50,
            windowHours: 24,
            groupPattern: "",
            processNames: [],
          });
          await this.plugin.saveSettings();
          this.display();
        })
    );

    new Setting(containerEl).addButton((btn) =>
      btn
        .setButtonText("Reset to defaults")
        .onClick(async () => {
          this.plugin.settings.aiServices = structuredClone(DEFAULT_AI_SERVICES);
          await this.plugin.saveSettings();
          this.display();
        })
    );
  }

  // ─── AI services table ───────────────────────────────────────────────────────

  private renderAiServicesTable(containerEl: HTMLElement) {
    const services = this.plugin.settings.aiServices;

    for (let i = 0; i < services.length; i++) {
      const svc = services[i];
      this.renderAiServiceRow(containerEl, svc, i);
    }
  }

  private renderAiServiceRow(
    containerEl: HTMLElement,
    svc: AiServiceConfig,
    index: number
  ) {
    const row = containerEl.createDiv({ cls: "multi-terminal__ai-service-row" });

    const save = async () => {
      await this.plugin.saveSettings();
    };

    // Row 1: label, group pattern, quota, hours, delete
    new Setting(row)
      .setName(`Service ${index + 1}`)
      .addText((t) =>
        t
          .setPlaceholder("Label")
          .setValue(svc.label)
          .onChange(async (v) => { svc.label = v; await save(); })
      )
      .addText((t) => {
        t.setPlaceholder("group pattern")
          .setValue(svc.groupPattern)
          .onChange(async (v) => { svc.groupPattern = v; await save(); });
        t.inputEl.title = "Case-insensitive substring of the group name (e.g. 'claude')";
        return t;
      })
      .addText((t) => {
        t.setPlaceholder("quota")
          .setValue(String(svc.quotaPerWindow))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!isNaN(n) && n >= 0) { svc.quotaPerWindow = n; await save(); }
          });
        t.inputEl.type = "number";
        t.inputEl.style.width = "60px";
        t.inputEl.title = "Max interactions per window (0 = unlimited/local)";
        return t;
      })
      .addText((t) => {
        t.setPlaceholder("hours")
          .setValue(String(svc.windowHours))
          .onChange(async (v) => {
            const n = parseFloat(v);
            if (!isNaN(n) && n > 0) { svc.windowHours = n; await save(); }
          });
        t.inputEl.type = "number";
        t.inputEl.style.width = "55px";
        t.inputEl.title = "Rolling window duration in hours";
        return t;
      })
      .addButton((btn) =>
        btn
          .setIcon("trash")
          .setTooltip("Remove this service")
          .onClick(async () => {
            this.plugin.settings.aiServices.splice(index, 1);
            await save();
            this.display();
          })
      );

    // Row 2: process names (for PTY process-tree detection)
    new Setting(row)
      .setName("")
      .setDesc("Process names (space-separated) to auto-detect in terminal — e.g. claude claude-code")
      .addText((t) => {
        t.setPlaceholder("process names")
          .setValue((svc.processNames ?? []).join(" "))
          .onChange(async (v) => {
            svc.processNames = v.trim().split(/\s+/).filter(Boolean);
            await save();
          });
        t.inputEl.style.width = "100%";
        t.inputEl.title = "Space-separated base process names (comm) to detect in the PTY's process tree";
        return t;
      });

    // Row 3: API key for live rate-limit probing
    new Setting(row)
      .setName("")
      .setDesc("API key for live usage probing (optional — leave blank to use local turn counting only)")
      .addText((t) => {
        t.setPlaceholder("API key")
          .setValue(svc.apiKey ?? "")
          .onChange(async (v) => { svc.apiKey = v.trim() || undefined; await save(); });
        t.inputEl.type = "password";
        t.inputEl.style.width = "100%";
        t.inputEl.autocomplete = "off";
        return t;
      });
  }
}
