/**
 * API available to scripts (`cfr` and, for compatibility, `dv`).
 * Every index read records dependencies, so the block only refreshes when needed.
 */
import { App, Component, TFile } from "obsidian";
import type CfrPlugin from "../main";
import { Row } from "../index/page";
import { EvalContext, FuncImpl } from "../query/compile";
import { DepSet } from "../query/deps";
import { getParsedQuery, PreparedExpression, PreparedQuery, QueryResult, resolveSourcePaths } from "../query/execute";
import { FUNCTIONS } from "../query/functions";
import { parseExpression, parseSource } from "../query/parser";
import { Source } from "../query/ast";
import { createResultState, renderList, renderTable, renderTasks } from "../render/results";
import { renderValue, RenderContext } from "../render/value";
import { toggleTask } from "../tasks/toggle";
import { compare, equals } from "../values/compare";
import { CDate, parseDateKeyword, parseISODate } from "../values/date";
import { CDuration, parseDuration } from "../values/duration";
import { Link } from "../values/link";
import { DataArray } from "./data-array";

const sourceCache = new Map<string, Source>();

function cachedSource(text: string): Source {
    let src = sourceCache.get(text);
    if (!src) {
        src = parseSource(text);
        if (sourceCache.size > 256) sourceCache.clear();
        sourceCache.set(text, src);
    }
    return src;
}

export class InlineApi {
    readonly DataArray = DataArray;
    readonly io: {
        csv: (path: string, originFile?: string) => Promise<DataArray<Row>>;
        load: (path: string, originFile?: string) => Promise<string | undefined>;
        normalize: (path: string, originFile?: string) => string;
    };
    private _func?: Record<string, (...args: any[]) => any>;

    constructor(
        readonly plugin: CfrPlugin,
        readonly container: HTMLElement,
        readonly component: Component,
        readonly currentFilePath: string,
        readonly deps: DepSet
    ) {
        this.io = {
            csv: async (path, originFile) => {
                const csv = await plugin.index.loadCsv(path, originFile ?? currentFilePath);
                deps.csv.add(csv.path);
                return DataArray.wrap(csv.rows);
            },
            load: async (path, originFile) => {
                const file = plugin.index.resolveFile(path, originFile ?? currentFilePath);
                if (!(file instanceof TFile)) return undefined;
                deps.paths.add(file.path);
                return plugin.app.vault.cachedRead(file);
            },
            normalize: (path, originFile) => plugin.index.resolveLinkPath(path, originFile ?? currentFilePath) ?? path,
        };
    }

    get app(): App {
        return this.plugin.app;
    }

    get settings() {
        return this.plugin.settings;
    }

    get index() {
        return this.plugin.index;
    }

    private get rc(): RenderContext {
        const component = this.component;
        return { app: this.plugin.app, settings: this.plugin.settings, sourcePath: this.currentFilePath, component };
    }

    // ---------------- data ----------------

    pagePaths(source = ""): DataArray<string> {
        if (/^\s*csv\s*\(/i.test(source)) throw new Error("Use cfr.io.csv() to read CSV files.");
        return DataArray.wrap(resolveSourcePaths(cachedSource(source), this.plugin.index, this.currentFilePath, this.deps));
    }

    pages(source = ""): DataArray<Row> {
        const index = this.plugin.index;
        const out = new DataArray<Row>();
        for (const path of this.pagePaths(source)) {
            const row = index.pageRow(path);
            if (row) out.push(row);
        }
        return out;
    }

    page(path: string | Link, originFile?: string): Row | undefined {
        const raw = path instanceof Link ? path.path : path;
        const resolved = this.plugin.index.resolveLinkPath(raw, originFile ?? this.currentFilePath) ?? raw;
        this.deps.paths.add(resolved);
        return this.plugin.index.pageRow(resolved);
    }

    current(): Row | undefined {
        return this.page(this.currentFilePath);
    }

    /** Runs a DQL query and returns the data (without rendering). */
    async query(text: string, originFile?: string): Promise<{ successful: true; value: QueryResult } | { successful: false; error: string }> {
        try {
            const prepared = new PreparedQuery(getParsedQuery(text), this.plugin.index, originFile ?? this.currentFilePath, this.plugin.settings);
            return { successful: true, value: await prepared.run(this.deps) };
        } catch (e) {
            return { successful: false, error: e instanceof Error ? e.message : String(e) };
        }
    }

    async tryQuery(text: string, originFile?: string): Promise<QueryResult> {
        const result = await this.query(text, originFile);
        if (!result.successful) throw new Error(result.error);
        return result.value;
    }

    /** Evaluates a query language expression. */
    evaluate(expression: string, row: Row = {}): any {
        return new PreparedExpression(parseExpression(expression), this.plugin.index, this.currentFilePath).run(this.deps, row);
    }

    // ---------------- rendering ----------------

    /** Renders a DQL query inside the block. */
    async execute(text: string): Promise<void> {
        const el = this.container.createDiv();
        const prepared = new PreparedQuery(getParsedQuery(text), this.plugin.index, this.currentFilePath, this.plugin.settings);
        const result = await prepared.run(this.deps);
        const state = createResultState();
        if (result.type === "table") renderTable(el, result.headers, result.rows, this.rc, state, this.component);
        else if (result.type === "list") renderList(el, result.items, this.rc, state, this.component);
        else renderTasks(el, result.groups, result.count, this.rc, state, this.component, this.toggle);
    }

    table(headers: string[], rows: Iterable<unknown[]>): HTMLElement {
        const el = this.container.createDiv();
        renderTable(el, Array.from(headers), Array.from(rows, r => Array.from(r)), this.rc, createResultState(), this.component);
        return el;
    }

    list(items: Iterable<unknown>): HTMLElement {
        const el = this.container.createDiv();
        renderList(el, Array.from(items), this.rc, createResultState(), this.component);
        return el;
    }

    taskList(tasks: Iterable<Row>, groupByFile = true): HTMLElement {
        const el = this.container.createDiv();
        const rows = Array.from(tasks);
        let groups: { key: unknown; rows: Row[] }[];
        if (groupByFile) {
            const map = new Map<string, { key: unknown; rows: Row[] }>();
            for (const t of rows) {
                let g = map.get(t.path);
                if (!g) map.set(t.path, (g = { key: Link.file(t.path), rows: [] }));
                g.rows.push(t);
            }
            groups = [...map.values()];
        } else {
            groups = [{ key: "", rows }];
        }
        renderTasks(el, groups, rows.length, this.rc, createResultState(), this.component, this.toggle);
        return el;
    }

    private toggle = (item: Row, checked: boolean) => toggleTask(this.plugin.app, this.plugin.settings, item, checked);

    el<K extends keyof HTMLElementTagNameMap>(
        tag: K,
        content?: unknown,
        options: { cls?: string | string[]; attr?: Record<string, string>; container?: HTMLElement } = {}
    ): HTMLElementTagNameMap[K] {
        const el = (options.container ?? this.container).createEl(tag, { cls: options.cls, attr: options.attr });
        if (content !== undefined) renderValue(el, content, this.rc);
        return el;
    }

    paragraph(content: unknown, options?: { cls?: string | string[]; attr?: Record<string, string> }): HTMLParagraphElement {
        return this.el("p", content, options);
    }

    span(content: unknown, options?: { cls?: string | string[]; attr?: Record<string, string> }): HTMLSpanElement {
        return this.el("span", content, options);
    }

    header(level: number, content: unknown, options?: { cls?: string | string[]; attr?: Record<string, string> }): HTMLHeadingElement {
        const tag = `h${Math.min(6, Math.max(1, Math.round(level)))}` as "h1";
        return this.el(tag, content, options);
    }

    /** Loads `path.js` or `path/view.js` (+ view.css) and runs it with `input`. */
    async view(path: string, input?: unknown): Promise<void> {
        const index = this.plugin.index;
        const clean = path.replace(/^\/+/, "").replace(/\.js$/, "");
        const simple = index.resolveFile(clean + ".js", this.currentFilePath);
        const folderScript = simple ? null : index.resolveFile(clean + "/view.js", this.currentFilePath);
        const script = simple ?? folderScript;
        if (!script) throw new Error(`cfr.view: no script found for "${path}"`);

        if (folderScript) {
            const css = index.resolveFile(clean + "/view.css", this.currentFilePath);
            if (css) this.container.createEl("style", { text: await this.plugin.app.vault.cachedRead(css) });
        }
        const source = await this.plugin.app.vault.cachedRead(script);
        const { compileScript } = await import("../views/js-view");
        await compileScript(source).call(this, this, this, input);
    }

    // ---------------- utilities ----------------

    array<T>(value: Iterable<T> | T): DataArray<T> {
        if (value !== null && typeof value === "object" && Symbol.iterator in (value as object)) return DataArray.wrap(value as Iterable<T>);
        return DataArray.wrap([value as T]);
    }

    isArray(value: unknown): boolean {
        return Array.isArray(value);
    }

    date(value: unknown): CDate | null {
        if (value instanceof CDate) return value;
        if (value instanceof Date) return CDate.fromJSDate(value);
        if (typeof value === "number") return new CDate(value, true);
        if (typeof value === "string") return parseDateKeyword(value) ?? parseISODate(value);
        if (value instanceof Link) return this.page(value)?.file?.day ?? null;
        return null;
    }

    duration(value: string | CDuration): CDuration | null {
        return value instanceof CDuration ? value : parseDuration(value);
    }

    fileLink(path: string, embed = false, display?: string): Link {
        return Link.file(path, embed, display);
    }

    sectionLink(path: string, section: string, embed = false, display?: string): Link {
        return Link.header(path, section, embed, display);
    }

    blockLink(path: string, blockId: string, embed = false, display?: string): Link {
        return Link.block(path, blockId, embed, display);
    }

    compare(a: unknown, b: unknown): number {
        return compare(a, b);
    }

    equal(a: unknown, b: unknown): boolean {
        return equals(a, b);
    }

    /** Query language functions: `cfr.func.dateformat(d, "yyyy")`. */
    get func(): Record<string, (...args: any[]) => any> {
        if (this._func) return this._func;
        const index = this.plugin.index;
        const origin = this.currentFilePath;
        const ctx: EvalContext = {
            thisRow: () => index.pageRow(origin) ?? null,
            resolveLink: link => index.pageRow(index.resolveLinkPath(link.path, origin) ?? link.path) ?? null,
            normalizeLink: p => index.resolveLinkPath(p, origin) ?? p,
            functions: FUNCTIONS,
            markDynamic: () => {},
        };
        const out: Record<string, (...args: any[]) => any> = {};
        for (const [name, fn] of Object.entries(FUNCTIONS) as [string, FuncImpl][]) out[name] = (...args) => fn(ctx, ...args);
        return (this._func = out);
    }
}
