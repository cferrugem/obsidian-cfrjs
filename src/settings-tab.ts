import { App, Notice, PluginSettingTab, SettingDefinitionItem } from "obsidian";
import type CfrPlugin from "./main";
import { isCommunityPluginEnabled, reloadPlugin } from "./obsidian-internals";
import { CfrSettings, DEFAULT_SETTINGS, KEYWORD_RE, workerCount } from "./settings";
import { br, callIfSupported, code, desc, link, renderDefinitions, strong } from "./settings-ui";
import { CDate } from "./values/date";

type BoolKey = { [K in keyof CfrSettings]: CfrSettings[K] extends boolean ? K : never }[keyof CfrSettings];
type StrKey = { [K in keyof CfrSettings]: CfrSettings[K] extends string ? K : never }[keyof CfrSettings];
type NumKey = { [K in keyof CfrSettings]: CfrSettings[K] extends number ? K : never }[keyof CfrSettings];
type SettingKey = keyof CfrSettings;

const DOCS_URL = "https://github.com/cferrugem/obsidian-cfrjs#readme";

/** Settings that do not invalidate query results, so views need no refresh when they change. */
const NO_IMMEDIATE_REFRESH = new Set<SettingKey>([
    "queryKeyword",
    "jsKeyword",
    "registerDataviewAliases",
    "enableLivePreviewInline",
    "refreshEnabled",
    "refreshDelay",
    "renderChunkSize",
    "workers",
    "taskCompletionTracking",
    "taskCompletionUseEmoji",
    "taskCompletionText",
    "taskCompletionDateFormat",
]);

/** Settings applied at load time; changing them takes effect only after the plugin reloads. */
const NEEDS_RELOAD = new Set<SettingKey>(["queryKeyword", "jsKeyword", "registerDataviewAliases", "enableLivePreviewInline", "workers"]);

/** Formats a date with a user-supplied pattern, returning "" rather than breaking the tab. */
function preview(date: CDate, format: string): string {
    try {
        return date.format(format);
    } catch {
        return "";
    }
}

export class CfrSettingTab extends PluginSettingTab {
    /** Set when a load-time setting changes, so the reload banner appears. */
    private reloadPending = false;

    constructor(app: App, private readonly plugin: CfrPlugin) {
        super(app, plugin);
    }

    getSettingDefinitions(): SettingDefinitionItem<SettingKey>[] {
        const s = this.plugin.settings;
        const dataviewEnabled = isCommunityPluginEnabled(this.app, "dataview");

        const keyword = (name: string, description: DocumentFragment, key: "queryKeyword" | "jsKeyword", other: "queryKeyword" | "jsKeyword") => ({
            name,
            desc: description,
            aliases: ["code block", "language", "fence"],
            control: {
                type: "text" as const,
                key,
                defaultValue: DEFAULT_SETTINGS[key],
                placeholder: DEFAULT_SETTINGS[key],
                validate: (raw: string): string | void => {
                    const value = raw.trim();
                    if (!KEYWORD_RE.test(value)) return "Use only letters, numbers, - and _.";
                    if (value.toLowerCase() === this.plugin.settings[other].toLowerCase()) return "Must differ from the other keyword.";
                    const query = (key === "queryKeyword" ? value : this.plugin.settings[other]).toLowerCase();
                    const js = (key === "jsKeyword" ? value : this.plugin.settings[other]).toLowerCase();
                    if (query === js + "js") return `Swapped: queries should use "${js}" and JavaScript "${query}".`;
                },
            },
        });
        const toggle = (name: string, description: string | DocumentFragment, key: BoolKey, extra: { disabled?: () => boolean; aliases?: string[] } = {}) => ({
            name,
            desc: description,
            aliases: extra.aliases,
            control: { type: "toggle" as const, key, defaultValue: DEFAULT_SETTINGS[key], disabled: extra.disabled },
        });
        const text = (
            name: string,
            description: string | DocumentFragment,
            key: StrKey,
            extra: { allowEmpty?: boolean; disabled?: () => boolean; aliases?: string[] } = {}
        ) => ({
            name,
            desc: description,
            aliases: extra.aliases,
            control: {
                type: "text" as const,
                key,
                defaultValue: DEFAULT_SETTINGS[key],
                placeholder: DEFAULT_SETTINGS[key],
                disabled: extra.disabled,
                validate: extra.allowEmpty ? undefined : (value: string): string | void => (value.trim() === "" ? "This value cannot be empty." : undefined),
            },
        });
        const number = (
            name: string,
            description: string | DocumentFragment,
            key: NumKey,
            min: number,
            max: number,
            extra: { disabled?: () => boolean; aliases?: string[] } = {}
        ) => ({
            name,
            desc: description,
            aliases: extra.aliases,
            control: {
                type: "number" as const,
                key,
                defaultValue: DEFAULT_SETTINGS[key],
                placeholder: String(DEFAULT_SETTINGS[key]),
                min,
                max,
                step: 1,
                disabled: extra.disabled,
            },
        });

        return [
            {
                name: "CFR Js",
                searchable: false,
                desc: desc(
                    "Indexes your vault so your notes can query it. Write a ",
                    code("```" + s.queryKeyword),
                    " block for TABLE, LIST and TASK queries, a ",
                    code("```" + s.jsKeyword),
                    " block for JavaScript, or ",
                    code("`" + s.inlineQueryPrefix + " expression`"),
                    " inside a line of text.",
                    br(),
                    link("Query language and API reference", DOCS_URL)
                ),
            },
            {
                name: "Reload to apply changes",
                searchable: false,
                visible: () => this.reloadPending,
                desc: "Block keywords, Live Preview and worker settings are applied when the plugin loads.",
                render: setting => {
                    setting.addButton(b =>
                        b
                            .setButtonText("Reload now")
                            .setCta()
                            .onClick(async () => {
                                if (!(await reloadPlugin(this.app, this.plugin.manifest.id))) {
                                    new Notice("Could not reload automatically. Turn the plugin off and on again under community plugins.");
                                }
                            })
                    );
                },
            },
            {
                type: "group",
                heading: "Code blocks",
                items: [
                    keyword(
                        "Query block keyword",
                        desc("Opens a query block: ", code("```" + s.queryKeyword), " followed by TABLE, LIST or TASK."),
                        "queryKeyword",
                        "jsKeyword"
                    ),
                    keyword("JavaScript block keyword", desc("Opens a JavaScript block: ", code("```" + s.jsKeyword), "."), "jsKeyword", "queryKeyword"),
                    toggle(
                        "Also read dataview blocks",
                        dataviewEnabled
                            ? desc("The Dataview plugin is enabled and keeps its own blocks. Disable Dataview to let CFR Js render them.")
                            : desc(
                                  "Render existing ",
                                  code("```dataview"),
                                  " and ",
                                  code("```dataviewjs"),
                                  " blocks with CFR Js, so you can migrate without editing your notes."
                              ),
                        "registerDataviewAliases",
                        { disabled: () => dataviewEnabled, aliases: ["dataview", "migration", "compatibility", "alias"] }
                    ),
                    toggle(
                        "Run JavaScript blocks",
                        desc(
                            code("```" + s.jsKeyword),
                            " blocks run code stored in your notes, with the same access to your vault as Obsidian itself. Only leave this on for vaults you trust."
                        ),
                        "enableJs",
                        { aliases: ["security", "javascript", "script", "sandbox"] }
                    ),
                ],
            },
            {
                type: "group",
                heading: "Inline queries",
                items: [
                    toggle(
                        "Inline queries",
                        desc("Evaluate an expression inside a line of text: ", code("`" + s.inlineQueryPrefix + " this.file.name`"), "."),
                        "enableInlineQueries"
                    ),
                    text("Inline query prefix", desc("Marks an inline query. Default: ", code(DEFAULT_SETTINGS.inlineQueryPrefix), "."), "inlineQueryPrefix", {
                        disabled: () => !this.plugin.settings.enableInlineQueries,
                    }),
                    toggle(
                        "Inline JavaScript",
                        s.enableJs
                            ? desc("Evaluate JavaScript inside a line of text: ", code("`" + s.inlineJsQueryPrefix + ' cfr.pages("#project").length`'), ".")
                            : desc("Turn on ", strong("Run JavaScript blocks"), " first."),
                        "enableInlineJs",
                        { disabled: () => !this.plugin.settings.enableJs, aliases: ["security", "javascript", "script"] }
                    ),
                    text(
                        "Inline JavaScript prefix",
                        desc("Marks inline JavaScript. Default: ", code(DEFAULT_SETTINGS.inlineJsQueryPrefix), "."),
                        "inlineJsQueryPrefix",
                        { disabled: () => !this.plugin.settings.enableJs || !this.plugin.settings.enableInlineJs }
                    ),
                    toggle(
                        "Show results in Live Preview",
                        "Inline results always render in Reading view. Turn this on to also see them while editing.",
                        "enableLivePreviewInline",
                        {
                            disabled: () => !this.plugin.settings.enableInlineQueries && !this.plugin.settings.enableInlineJs,
                            aliases: ["editor", "live preview"],
                        }
                    ),
                ],
            },
            {
                type: "group",
                heading: "Results",
                items: [
                    text("File column name", "Heading of the first column in TABLE results, which holds the link to each note.", "tableIdColumnName", {
                        aliases: ["table", "column"],
                    }),
                    text("Group column name", "Heading of the column added by GROUP BY.", "tableGroupColumnName", { aliases: ["table", "group by", "column"] }),
                    text("Empty value text", "Shown in place of a field that is missing or empty.", "renderNullAs", {
                        allowEmpty: true,
                        aliases: ["null", "placeholder"],
                    }),
                    text(
                        "Date format",
                        desc("Luxon-style tokens used to print dates. Today reads as ", strong(preview(CDate.today(), s.dateFormat)), "."),
                        "dateFormat",
                        { aliases: ["luxon", "tokens"] }
                    ),
                    text(
                        "Date and time format",
                        desc("Luxon-style tokens used when a value also carries a time. Now reads as ", strong(preview(CDate.now(), s.dateTimeFormat)), "."),
                        "dateTimeFormat",
                        { aliases: ["luxon", "tokens"] }
                    ),
                    toggle("Show result count", "Add the number of rows next to the result.", "showResultCount"),
                    toggle("Warn on empty results", "Show a short message instead of nothing when a query matches no rows.", "warnOnEmptyResult"),
                    toggle("Show query timings", "Print query and render time under each block. Useful for tracking down a slow query.", "showTimings", {
                        aliases: ["performance", "debug", "benchmark"],
                    }),
                ],
            },
            {
                type: "group",
                heading: "Performance",
                items: [
                    toggle(
                        "Refresh views automatically",
                        desc("Re-run affected queries when notes change. With this off, use the ", strong("Refresh all views"), " command instead."),
                        "refreshEnabled",
                        { aliases: ["live", "update"] }
                    ),
                    number(
                        "Refresh delay",
                        "Milliseconds to wait after a change before refreshing, so a burst of edits is handled once. Raise it if typing feels heavy.",
                        "refreshDelay",
                        50,
                        10000,
                        { disabled: () => !this.plugin.settings.refreshEnabled, aliases: ["debounce", "ms"] }
                    ),
                    number(
                        "Rows per chunk",
                        "Rows drawn in one go; the rest is filled in during idle time. Lower values keep a large table from blocking the editor.",
                        "renderChunkSize",
                        10,
                        5000,
                        { aliases: ["render", "chunk", "large table"] }
                    ),
                    {
                        name: "Indexing workers",
                        desc: "Background threads used to parse inline fields and list items when the index is built.",
                        aliases: ["threads", "cache", "index", "cpu"],
                        control: {
                            type: "slider" as const,
                            key: "workers" as const,
                            defaultValue: DEFAULT_SETTINGS.workers,
                            min: 0,
                            max: 8,
                            step: 1,
                            displayFormat: (value: number) =>
                                value === 0 ? `Automatic (${workerCount({ ...this.plugin.settings, workers: 0 })})` : String(value),
                        },
                    },
                ],
            },
            {
                type: "group",
                heading: "Tasks",
                items: [
                    toggle("Record completion date", "When you check a task from a query result, stamp today's date on the task line.", "taskCompletionTracking", {
                        aliases: ["checkbox", "done"],
                    }),
                    toggle(
                        "Completion emoji",
                        desc("Writes ", code(`✅ ${CDate.today().format("yyyy-MM-dd")}`), ". Turn off to write an inline field instead."),
                        "taskCompletionUseEmoji",
                        { disabled: () => !this.plugin.settings.taskCompletionTracking, aliases: ["emoji"] }
                    ),
                    text(
                        "Completion field name",
                        desc("Writes ", code(`[${s.taskCompletionText}:: ${preview(CDate.today(), s.taskCompletionDateFormat)}]`), " when the emoji is off."),
                        "taskCompletionText",
                        {
                            disabled: () => !this.plugin.settings.taskCompletionTracking || this.plugin.settings.taskCompletionUseEmoji,
                            aliases: ["inline field"],
                        }
                    ),
                    text(
                        "Completion date format",
                        desc("Luxon-style tokens for the inline field. Today reads as ", strong(preview(CDate.today(), s.taskCompletionDateFormat)), "."),
                        "taskCompletionDateFormat",
                        {
                            disabled: () => !this.plugin.settings.taskCompletionTracking || this.plugin.settings.taskCompletionUseEmoji,
                            aliases: ["luxon", "tokens"],
                        }
                    ),
                ],
            },
            {
                type: "group",
                heading: "Index",
                items: [
                    { name: "Status", searchable: false, desc: this.indexStatus() },
                    {
                        name: "Refresh all views",
                        desc: "Re-run every query currently on screen.",
                        aliases: ["reload", "update"],
                        disabled: () => !this.plugin.index?.ready,
                        action: () => this.plugin.index?.touch(),
                    },
                    {
                        name: "Rebuild index",
                        desc: "Discard the cache and read every file again. Use this if results look stale after editing notes outside Obsidian.",
                        aliases: ["cache", "reset", "repair"],
                        disabled: () => !this.plugin.index?.ready,
                        action: () => void this.rebuild(),
                    },
                ],
            },
        ];
    }

    /**
     * One-line summary of the index, shown in the Index group.
     *
     * `addSettingTab()` builds the definitions during `onload`, before the index and the
     * API exist, so neither can be assumed here: a throw would abort the whole load.
     */
    private indexStatus(): string {
        if (!this.plugin.index?.ready || !this.plugin.api) return "Indexing your vault…";
        const s = this.plugin.api.stats();
        const n = (value: number) => value.toLocaleString();
        const workers = s.workers || 1;
        return (
            `${n(s.pages)} pages from ${n(s.files)} files · ${n(s.cached)} from cache, ${n(s.parsed)} parsed · ` +
            `${workers} worker${workers === 1 ? "" : "s"} · metadata ${s.metadataMs.toFixed(0)} ms, parsing ${s.parseMs.toFixed(0)} ms`
        );
    }

    private async rebuild(): Promise<void> {
        if (!this.plugin.index?.ready) return;
        new Notice("Rebuilding the index…");
        await this.plugin.index.rebuild();
        new Notice("Index rebuilt.");
        this.refresh();
    }

    /**
     * Rebuilds the definitions so the index status line reflects the new numbers.
     * On Obsidian 1.13 the framework re-renders from `update()`; older versions have
     * only `display()`, which is this tab's own fallback renderer.
     */
    private refresh(): void {
        if (!callIfSupported(this, "update")) this.renderFallback();
    }

    getControlValue(key: string): unknown {
        return key in DEFAULT_SETTINGS ? this.plugin.settings[key as SettingKey] : undefined;
    }

    async setControlValue(key: string, value: unknown): Promise<void> {
        if (!(key in DEFAULT_SETTINGS)) return;
        const settingKey = key as SettingKey;
        const expected = DEFAULT_SETTINGS[settingKey];
        if (typeof value !== typeof expected) return;
        await this.plugin.updateSettings({ [settingKey]: value }, !NO_IMMEDIATE_REFRESH.has(settingKey));
        if (NEEDS_RELOAD.has(settingKey)) this.reloadPending = true;
        // Re-evaluate the `disabled`/`visible` predicates of the rows that depend on this one.
        callIfSupported(this, "refreshDomState");
    }

    /** Only reached on Obsidian versions older than 1.13, which ignore `getSettingDefinitions()`. */
    display(): void {
        this.renderFallback();
    }

    /** Renders the same definitions imperatively, for Obsidian versions without the declarative API. */
    private renderFallback(): void {
        this.containerEl.empty();
        renderDefinitions(this.containerEl, this.getSettingDefinitions(), this);
    }
}
