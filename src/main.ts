import { MarkdownPostProcessorContext, Notice, Plugin } from "obsidian";
import { CfrApi } from "./api/plugin-api";
import { VaultIndex } from "./index/vault-index";
import { isCommunityPluginEnabled } from "./obsidian-internals";
import { CfrSettings, DEFAULT_SETTINGS, KEYWORD_RE, workerCount } from "./settings";
import { CfrSettingTab } from "./settings-tab";
import { setCollatorLocale } from "./values/compare";
import { setLocale } from "./values/date";
import { displayFormats } from "./values/types";
import { processInlineQueries } from "./views/inline-view";
import { JsView } from "./views/js-view";
import { inlineLivePreview } from "./views/lp-inline";
import { QueryView } from "./views/query-view";
import { Scheduler } from "./views/scheduler";

/** Ensures keywords are valid and distinct (old or hand-edited settings). */
function sanitizeKeywords(settings: CfrSettings): void {
    if (!KEYWORD_RE.test(settings.queryKeyword)) settings.queryKeyword = DEFAULT_SETTINGS.queryKeyword;
    if (!KEYWORD_RE.test(settings.jsKeyword)) settings.jsKeyword = DEFAULT_SETTINGS.jsKeyword;
    const query = settings.queryKeyword.toLowerCase();
    const js = settings.jsKeyword.toLowerCase();
    if (js === query) {
        settings.queryKeyword = DEFAULT_SETTINGS.queryKeyword;
        settings.jsKeyword = DEFAULT_SETTINGS.jsKeyword;
    } else if (query === js + "js") {
        // Swapped (e.g. queries = "dataviewjs", JavaScript = "dataview"): undo the swap.
        [settings.queryKeyword, settings.jsKeyword] = [settings.jsKeyword, settings.queryKeyword];
        new Notice("cfrjs: the query and JavaScript keywords were swapped and have been fixed.");
    }
}

export default class CfrPlugin extends Plugin {
    settings!: CfrSettings;
    index!: VaultIndex;
    scheduler!: Scheduler;
    api!: CfrApi;

    async onload(): Promise<void> {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        sanitizeKeywords(this.settings);
        this.applyDisplaySettings();
        // Register the tab first: even if something below fails, settings stay reachable.
        this.addSettingTab(new CfrSettingTab(this.app, this));

        const locale = (window as any).moment?.locale?.();
        if (locale) {
            setLocale(locale);
            setCollatorLocale(locale);
        }

        this.index = this.addChild(new VaultIndex(this.app, workerCount(this.settings)));
        this.scheduler = new Scheduler(this.settings);
        this.register(this.index.onBatch(batch => this.scheduler.onBatch(batch)));
        this.register(() => this.scheduler.destroy());

        this.api = new CfrApi(this);
        (window as any).CfrJsAPI = this.api;
        this.register(() => delete (window as any).CfrJsAPI);

        const queryBlock = (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) =>
            ctx.addChild(new QueryView(this, el, source, ctx.sourcePath));
        const jsBlock = (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) =>
            ctx.addChild(new JsView(this, el, source, ctx.sourcePath));

        this.registerBlock(this.settings.queryKeyword, queryBlock);
        if (this.registerBlock(this.settings.jsKeyword, jsBlock)) this.registerJsHighlighting(this.settings.jsKeyword);

        if (this.settings.registerDataviewAliases && !this.isDataviewEnabled()) {
            this.registerBlock("dataview", queryBlock);
            this.registerBlock("dataviewjs", jsBlock);
        }

        this.registerMarkdownPostProcessor((el, ctx) => processInlineQueries(this, el, ctx), -100);
        if (this.settings.enableLivePreviewInline) this.registerEditorExtension(inlineLivePreview(this));

        this.addCommand({
            id: "refresh-views",
            name: "Refresh all views",
            callback: () => this.index.touch(),
        });
        this.addCommand({
            id: "rebuild-index",
            name: "Rebuild index (discard cache)",
            callback: async () => {
                new Notice("cfrjs: rebuilding the index…");
                await this.index.rebuild();
                new Notice("cfrjs: index rebuilt.");
            },
        });
        this.addCommand({
            id: "index-stats",
            name: "Show index statistics",
            callback: () => {
                const s = this.api.stats();
                const text =
                    `cfrjs — ${s.pages} pages (${s.files} files)\n` +
                    `Metadata: ${s.metadataMs.toFixed(0)}ms · Parsing: ${s.parseMs.toFixed(0)}ms\n` +
                    `Cached: ${s.cached} · Parsed: ${s.parsed} · Workers: ${s.workers}\n` +
                    `Revision: ${s.revision} · Refreshes: ${s.scheduler.invalidations} · Skipped: ${s.scheduler.skipped}`;
                new Notice(text, 10000);
            },
        });

        this.app.workspace.onLayoutReady(() => void this.index.initialize());
    }

    /** Registers a code block without breaking the plugin if the keyword is already taken (e.g. by another plugin). */
    private registerBlock(language: string, handler: (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => void): boolean {
        try {
            this.registerMarkdownCodeBlockProcessor(language, handler, -100);
            return true;
        } catch (e) {
            console.error(`cfrjs: could not register the "${language}" code block`, e);
            new Notice(`cfrjs: the keyword "${language}" is already in use. Change it in the settings.`);
            return false;
        }
    }

    private isDataviewEnabled(): boolean {
        return isCommunityPluginEnabled(this.app, "dataview");
    }

    private registerJsHighlighting(keyword: string): void {
        const cm = (window as any).CodeMirror;
        if (!cm?.defineMode) return;
        cm.defineMode(keyword, (config: unknown) => cm.getMode(config, "javascript"));
        this.register(() => cm.defineMode(keyword, (config: unknown) => cm.getMode(config, "null")));
    }

    applyDisplaySettings(): void {
        displayFormats.date = this.settings.dateFormat;
        displayFormats.dateTime = this.settings.dateTimeFormat;
        displayFormats.nullAs = this.settings.renderNullAs;
    }

    async updateSettings(partial: Partial<CfrSettings>, refresh = true): Promise<void> {
        Object.assign(this.settings, partial);
        this.applyDisplaySettings();
        await this.saveData(this.settings);
        if (refresh) this.index.touch();
    }
}
