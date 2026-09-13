import { App, PluginSettingTab, Setting } from "obsidian";
import type CfrPlugin from "./main";
import { CfrSettings, DEFAULT_SETTINGS, KEYWORD_RE } from "./settings";
import { CDate } from "./values/date";

type BoolKey = { [K in keyof CfrSettings]: CfrSettings[K] extends boolean ? K : never }[keyof CfrSettings];
type StrKey = { [K in keyof CfrSettings]: CfrSettings[K] extends string ? K : never }[keyof CfrSettings];
type NumKey = { [K in keyof CfrSettings]: CfrSettings[K] extends number ? K : never }[keyof CfrSettings];

export class CfrSettingTab extends PluginSettingTab {
    constructor(app: App, private readonly plugin: CfrPlugin) {
        super(app, plugin);
    }

    private toggle(name: string, desc: string, key: BoolKey, refresh = true): void {
        new Setting(this.containerEl)
            .setName(name)
            .setDesc(desc)
            .addToggle(t => t.setValue(this.plugin.settings[key]).onChange(v => this.plugin.updateSettings({ [key]: v }, refresh)));
    }

    private text(name: string, desc: string, key: StrKey, refresh = true, allowEmpty = false): void {
        new Setting(this.containerEl)
            .setName(name)
            .setDesc(desc)
            .addText(t =>
                t
                    .setPlaceholder(String(DEFAULT_SETTINGS[key]))
                    .setValue(this.plugin.settings[key])
                    .onChange(v => {
                        if (!allowEmpty && v.trim() === "") return;
                        void this.plugin.updateSettings({ [key]: v }, refresh);
                    })
            );
    }

    /** Block keyword: only saves values that are valid and different from the other keyword. */
    private keyword(name: string, desc: string, key: "queryKeyword" | "jsKeyword", other: "queryKeyword" | "jsKeyword"): void {
        const setting = new Setting(this.containerEl).setName(name).setDesc(desc);
        setting.addText(t =>
            t
                .setPlaceholder(DEFAULT_SETTINGS[key])
                .setValue(this.plugin.settings[key])
                .onChange(v => {
                    const value = v.trim();
                    let error = "";
                    if (!KEYWORD_RE.test(value)) error = "Use only letters, numbers, - and _.";
                    else if (value.toLowerCase() === this.plugin.settings[other].toLowerCase()) error = "Must differ from the other keyword.";
                    else {
                        const query = (key === "queryKeyword" ? value : this.plugin.settings[other]).toLowerCase();
                        const js = (key === "jsKeyword" ? value : this.plugin.settings[other]).toLowerCase();
                        if (query === js + "js") error = `Swapped: queries should use "${js}" and JavaScript "${query}".`;
                    }
                    setting.setDesc(error ? `⚠ ${error} (not saved)` : desc);
                    if (!error) void this.plugin.updateSettings({ [key]: value }, false);
                })
        );
    }

    private number(name: string, desc: string, key: NumKey, min: number, max: number): void {
        new Setting(this.containerEl)
            .setName(name)
            .setDesc(desc)
            .addText(t =>
                t
                    .setPlaceholder(String(DEFAULT_SETTINGS[key]))
                    .setValue(String(this.plugin.settings[key]))
                    .onChange(v => {
                        const n = parseInt(v, 10);
                        if (Number.isNaN(n)) return;
                        void this.plugin.updateSettings({ [key]: Math.min(max, Math.max(min, n)) }, false);
                    })
            );
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        const reload = " (requires reloading the plugin)";
        const { queryKeyword, jsKeyword } = this.plugin.settings;

        new Setting(containerEl).setName("Code blocks").setHeading();
        this.keyword("Query keyword", `Code blocks \`\`\`${queryKeyword} with TABLE/LIST/TASK.` + reload, "queryKeyword", "jsKeyword");
        this.keyword("JavaScript keyword", `Code blocks \`\`\`${jsKeyword}.` + reload, "jsKeyword", "queryKeyword");
        this.toggle(
            "Accept dataview/dataviewjs blocks",
            "Process Dataview code blocks while the Dataview plugin is disabled (migration)." + reload,
            "registerDataviewAliases",
            false
        );
        this.toggle("Enable JavaScript", `Allow running ${jsKeyword} code blocks.`, "enableJs");

        new Setting(containerEl).setName("Inline queries").setHeading();
        this.toggle("Enable inline queries", "Evaluate `= expression` in text.", "enableInlineQueries");
        this.toggle("Enable inline JavaScript", "Evaluate `$= code` in text.", "enableInlineJs");
        this.toggle("Inline queries in Live Preview", "Show inline results in Live Preview." + reload, "enableLivePreviewInline", false);
        this.text("Inline query prefix", "Default: =", "inlineQueryPrefix");
        this.text("Inline JavaScript prefix", "Default: $=", "inlineJsQueryPrefix");

        new Setting(containerEl).setName("Display").setHeading();
        this.text("Null value", "Text shown for empty values.", "renderNullAs", true, true);
        this.text("Date format", `Luxon-style tokens. Today: ${CDate.today().format(this.plugin.settings.dateFormat)}`, "dateFormat");
        this.text("Date and time format", "Luxon-style tokens.", "dateTimeFormat");
        this.text("File column name", "Name of the first column in tables.", "tableIdColumnName");
        this.toggle("Show result count", "", "showResultCount");
        this.toggle("Warn on empty results", "", "warnOnEmptyResult");
        this.toggle("Show timings", "Show query and render time below each block.", "showTimings");

        new Setting(containerEl).setName("Performance").setHeading();
        this.toggle("Automatic refresh", "Refresh affected views when files change.", "refreshEnabled", false);
        this.number("Refresh delay (ms)", "How long to wait after changes before refreshing.", "refreshDelay", 50, 10000);
        this.number("Rows per chunk", "Rows rendered at once; the rest is rendered in the background.", "renderChunkSize", 10, 5000);
        this.number("Indexing workers", "0 = automatic." + reload, "workers", 0, 8);

        new Setting(containerEl).setName("Tasks").setHeading();
        this.toggle("Record completion date", "When a task is checked from a view, append its completion date.", "taskCompletionTracking", false);
        this.toggle("Use ✅ emoji", "Disable to use an inline field instead.", "taskCompletionUseEmoji", false);
        this.text("Completion field name", "Used when the emoji is disabled.", "taskCompletionText", false);
        this.text("Completion date format", "Used when the emoji is disabled.", "taskCompletionDateFormat", false);
    }
}
