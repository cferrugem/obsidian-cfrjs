/**
 * Indexed page. The query "row" is built once per page version and shared by every
 * query — no serialize()/deepCopy per execution.
 */
import { DataArray } from "../api/data-array";
import { CDate, extractDate } from "../values/date";
import { Link } from "../values/link";
import { canonicalizeKey, parseFrontmatterValue, parseInlineValue } from "../values/parse-value";
import { Literal, ROW_BASE } from "../values/types";
import { ContentData, RawListItem } from "./parse-content";

export interface PageEnv {
    resolveLinkPath(linkpath: string, origin: string): string | null;
    /** Incremented when files are created/renamed/deleted (link targets may change). */
    linkEpoch(): number;
    inlinks(path: string): ReadonlySet<string>;
    isStarred(path: string): boolean;
}

export interface RawLink {
    link: Link;
    line: number;
}

export interface PageInput {
    path: string;
    ctime: number;
    mtime: number;
    size: number;
    frontmatter: Record<string, unknown> | null;
    tags: string[];
    aliases: string[];
    links: RawLink[];
}

export type Row = { [key: string]: any; [key: symbol]: any };

/** Page that owns a list item (non-enumerable, not listed by Object.keys). */
export const ITEM_PAGE: unique symbol = Symbol("cfrjs.page");

function extractSubtags(tag: string): string[] {
    const out = [tag];
    let t = tag;
    for (let i = t.lastIndexOf("/"); i > 0; i = t.lastIndexOf("/")) {
        t = t.slice(0, i);
        out.push(t);
    }
    return out;
}

function addField(map: Map<string, Literal[]>, key: string, value: Literal): void {
    const existing = map.get(key);
    if (existing) existing.push(value);
    else map.set(key, [value]);
}

/** Flattens values and adds normalized keys that do not collide with the original ones. */
function finalizeFields(map: Map<string, Literal[]>, target: Row): void {
    for (const [key, values] of map) target[key] = values.length === 1 ? values[0] : values;
    const canon = new Map<string, Literal[]>();
    for (const [key, values] of map) {
        const c = canonicalizeKey(key);
        if (c === "" || c === key || map.has(c)) continue;
        const existing = canon.get(c);
        if (existing) existing.push(...values);
        else canon.set(c, values.slice());
    }
    for (const [key, values] of canon) target[key] = values.length === 1 ? values[0] : values;
}

export class Page {
    readonly path: string;
    readonly ctime: CDate;
    readonly mtime: CDate;
    readonly size: number;
    readonly frontmatter: Record<string, Literal>;
    readonly etags: string[];
    readonly fullTags: string[];
    /** Lowercase tags including subtags — used by indexes and dependencies. */
    readonly tagKeys: Set<string>;
    readonly aliases: string[];
    readonly day: CDate | null;
    readonly fields: Row;

    private _row?: Row;
    private _lists?: DataArray<ListItemRow>;
    private _tasks?: DataArray<ListItemRow>;

    constructor(readonly input: PageInput, readonly content: ContentData | null, readonly env: PageEnv) {
        this.path = input.path;
        this.ctime = new CDate(input.ctime, true);
        this.mtime = new CDate(input.mtime, true);
        this.size = input.size;

        const etags = new Set<string>();
        for (const t of input.tags) etags.add(t.startsWith("#") ? t : "#" + t);
        this.etags = [...etags];
        const full = new Set<string>();
        for (const t of this.etags) for (const s of extractSubtags(t)) full.add(s);
        this.fullTags = [...full];
        this.tagKeys = new Set(this.fullTags.map(t => t.toLowerCase()));
        this.aliases = input.aliases;

        const fm: Record<string, Literal> = {};
        const fieldMap = new Map<string, Literal[]>();
        if (input.frontmatter) {
            for (const key in input.frontmatter) {
                if (key === "position") continue;
                const value = parseFrontmatterValue(input.frontmatter[key]);
                fm[key] = value;
                addField(fieldMap, key, value);
            }
        }
        this.frontmatter = fm;

        if (content) {
            for (const [key, raw] of content.fields) addField(fieldMap, key, parseInlineValue(raw));
            // Fields of non-task list items bubble up to the page (Dataview semantics).
            for (const item of content.lists) {
                if (item.status !== null) continue;
                for (const [key, raw] of item.fields) addField(fieldMap, key, parseInlineValue(raw));
            }
        }

        const fields: Row = Object.create(null);
        finalizeFields(fieldMap, fields);
        this.fields = fields;
        this.day = this.findDay();
    }

    withContent(content: ContentData | null): Page {
        return new Page(this.input, content, this.env);
    }

    withInput(input: PageInput): Page {
        return new Page(input, this.content, this.env);
    }

    private findDay(): CDate | null {
        for (const key in this.fields) {
            const lower = key.toLowerCase();
            if (lower !== "date" && lower !== "day") continue;
            let v = this.fields[key];
            if (Array.isArray(v)) v = v[0];
            if (v instanceof CDate) return v;
            if (v instanceof Link) {
                const d = extractDate(v.path) ?? extractDate(v.display ?? "");
                if (d) return d;
            }
        }
        return extractDate(this.name);
    }

    get name(): string {
        let name = this.path;
        const slash = name.lastIndexOf("/");
        if (slash >= 0) name = name.slice(slash + 1);
        const dot = name.lastIndexOf(".");
        return dot > 0 ? name.slice(0, dot) : name;
    }

    get folder(): string {
        const slash = this.path.lastIndexOf("/");
        return slash >= 0 ? this.path.slice(0, slash) : "";
    }

    /** Queryable page object. Built on demand and reused. */
    get row(): Row {
        if (this._row) return this._row;
        const row: Row = Object.create(null);
        for (const key in this.fields) row[key] = this.fields[key];
        row.file = new FileMeta(this);
        return (this._row = row);
    }

    get lists(): DataArray<ListItemRow> {
        if (!this._lists) this.buildLists();
        return this._lists!;
    }

    get tasks(): DataArray<ListItemRow> {
        if (!this._tasks) this.buildLists();
        return this._tasks!;
    }

    /** Unresolved links that appear between the given lines. */
    linksBetween(start: number, end: number): RawLink[] {
        const out: RawLink[] = [];
        for (const l of this.input.links) if (l.line >= start && l.line <= end) out.push(l);
        return out;
    }

    private buildLists(): void {
        const raw = this.content?.lists ?? [];
        const lists = new DataArray<ListItemRow>();
        const tasks = new DataArray<ListItemRow>();
        this._lists = lists;
        this._tasks = tasks;
        if (raw.length === 0) return;

        const row = this.row;
        const byLine = new Map<number, ListItemRow>();
        const fileLink = Link.file(this.path);

        for (const item of raw) {
            const obj = new ListItemRow(this, item, row, fileLink);
            byLine.set(item.line, obj);
            lists.push(obj);
            if (obj.task) tasks.push(obj);
        }

        for (const item of lists) {
            const parent = item.parent !== undefined ? byLine.get(item.parent) : undefined;
            if (parent) parent.children.push(item);
        }

        // Propagate fullyCompleted to ancestors.
        for (const item of tasks) {
            let cur: ListItemRow | undefined = item;
            const guard = new Set<ListItemRow>();
            while (cur && !guard.has(cur)) {
                guard.add(cur);
                if (cur.task) cur.fullyCompleted = cur.fullyCompleted && item.completed;
                cur = cur.parent !== undefined ? byLine.get(cur.parent) : undefined;
            }
        }
    }
}

const OUTLINKS: unique symbol = Symbol("cfrjs.outlinks");

/**
 * List/task item. All fixed fields are assigned in the same order (stable V8 shape);
 * page fields are reached through ROW_BASE, without copies.
 */
export class ListItemRow {
    [key: string]: any;
    declare [ROW_BASE]: Row;
    declare [ITEM_PAGE]: Page;
    declare [OUTLINKS]: DataArray<Link> | undefined;

    symbol: string;
    text: string;
    line: number;
    lineCount: number;
    list: number;
    path: string;
    section: Link;
    header: Link;
    link: Link;
    tags: DataArray<string>;
    children: DataArray<ListItemRow>;
    subtasks: DataArray<ListItemRow>;
    parent: number | undefined;
    task: boolean;
    real: boolean;
    status: string;
    checked: boolean;
    completed: boolean;
    fullyCompleted: boolean;
    annotated: boolean;
    blockId: string | undefined;
    position: { start: { line: number }; end: { line: number } };

    constructor(page: Page, item: RawListItem, pageRow: Row, fileLink: Link) {
        const path = page.path;
        const section = item.section ? Link.header(path, item.section) : fileLink;
        const isTask = item.status !== null;
        const status = item.status ?? "";
        const completed = status === "x" || status === "X";
        const children = new DataArray<ListItemRow>();

        this.symbol = item.symbol;
        this.text = item.text;
        this.line = item.line;
        this.lineCount = item.lineCount;
        this.list = item.list;
        this.path = path;
        this.section = section;
        this.header = section;
        this.link = item.blockId ? Link.block(path, item.blockId) : section;
        this.tags = DataArray.wrap(item.tags);
        this.children = children;
        this.subtasks = children;
        this.parent = item.parent >= 0 ? item.parent : undefined;
        this.task = isTask;
        this.real = isTask;
        this.status = status;
        this.checked = isTask && status !== "" && status !== " ";
        this.completed = completed;
        this.fullyCompleted = completed;
        this.annotated = item.fields.length > 0;
        this.blockId = item.blockId ?? undefined;
        this.position = { start: { line: item.line }, end: { line: item.line + item.lineCount - 1 } };
        Object.defineProperty(this, ROW_BASE, { value: pageRow });
        Object.defineProperty(this, ITEM_PAGE, { value: page });
        Object.defineProperty(this, OUTLINKS, { value: undefined, writable: true });

        if (item.fields.length > 0) this.addFields(item, isTask);
    }

    private addFields(item: RawListItem, isTask: boolean): void {
        const map = new Map<string, Literal[]>();
        for (const [key, raw] of item.fields) addField(map, key, parseInlineValue(raw));
        const own: Row = Object.create(null);
        finalizeFields(map, own);
        for (const key in own) if (!(key in this)) this[key] = own[key];
        if (!isTask) return;

        const pick = (...keys: string[]) => {
            for (const k of keys) if (own[k] !== undefined) return Array.isArray(own[k]) ? own[k][0] : own[k];
            return undefined;
        };
        const created = pick("created", "ctime", "cday");
        const due = pick("due", "duetime", "dueday");
        const completion = pick("completion", "completed", "comptime", "compday");
        const start = pick("start");
        const scheduled = pick("scheduled");
        if (created !== undefined) this.created = created;
        if (due !== undefined) this.due = due;
        if (completion !== undefined) this.completion = completion;
        if (start !== undefined) this.start = start;
        if (scheduled !== undefined) this.scheduled = scheduled;
    }

    get outlinks(): DataArray<Link> {
        let out = this[OUTLINKS];
        if (out) return out;
        const page = this[ITEM_PAGE];
        out = new DataArray<Link>();
        for (const l of page.linksBetween(this.line, this.line + this.lineCount - 1)) {
            const resolved = page.env.resolveLinkPath(l.link.path, page.path);
            out.push(resolved ? l.link.withPath(resolved) : l.link);
        }
        return (this[OUTLINKS] = out);
    }
}

/** `file.*` metadata with lazy, memoized getters. */
export class FileMeta {
    private declare readonly _p: Page;
    private declare readonly _m: Record<string, any>;

    constructor(page: Page) {
        Object.defineProperty(this, "_p", { value: page });
        Object.defineProperty(this, "_m", { value: Object.create(null) });
    }

    private memo<T>(key: string, fn: () => T): T {
        const m = this._m;
        return key in m ? m[key] : (m[key] = fn());
    }

    get path(): string {
        return this._p.path;
    }
    get name(): string {
        return this.memo("name", () => this._p.name);
    }
    get folder(): string {
        return this.memo("folder", () => this._p.folder);
    }
    get ext(): string {
        const dot = this._p.path.lastIndexOf(".");
        return dot >= 0 ? this._p.path.slice(dot + 1) : "";
    }
    get link(): Link {
        return this.memo("link", () => Link.file(this._p.path));
    }
    get size(): number {
        return this._p.size;
    }
    get ctime(): CDate {
        return this._p.ctime;
    }
    get cday(): CDate {
        return this.memo("cday", () => this._p.ctime.startOfDay());
    }
    get mtime(): CDate {
        return this._p.mtime;
    }
    get mday(): CDate {
        return this.memo("mday", () => this._p.mtime.startOfDay());
    }
    get day(): CDate | null {
        return this._p.day;
    }
    get frontmatter(): Record<string, Literal> {
        return this._p.frontmatter;
    }
    get tags(): DataArray<string> {
        return this.memo("tags", () => DataArray.wrap(this._p.fullTags));
    }
    get etags(): DataArray<string> {
        return this.memo("etags", () => DataArray.wrap(this._p.etags));
    }
    get aliases(): DataArray<string> {
        return this.memo("aliases", () => DataArray.wrap(this._p.aliases));
    }
    get lists(): DataArray<ListItemRow> {
        return this._p.lists;
    }
    get tasks(): DataArray<ListItemRow> {
        return this._p.tasks;
    }
    get outlinks(): DataArray<Link> {
        const env = this._p.env;
        const epoch = env.linkEpoch();
        const m = this._m;
        if (m.outlinksEpoch === epoch) return m.outlinks;
        const seen = new Set<string>();
        const out = new DataArray<Link>();
        for (const { link } of this._p.input.links) {
            const resolved = env.resolveLinkPath(link.path, this._p.path);
            const final = resolved ? link.withPath(resolved) : link;
            const key = `${final.path}#${final.subpath ?? ""}|${final.embed ? 1 : 0}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(final);
        }
        m.outlinksEpoch = epoch;
        return (m.outlinks = out);
    }
    get inlinks(): DataArray<Link> {
        const out = new DataArray<Link>();
        for (const p of this._p.env.inlinks(this._p.path)) out.push(Link.file(p));
        return out;
    }
    get starred(): boolean {
        return this._p.env.isStarred(this._p.path);
    }

    toString(): string {
        return this.link.markdown();
    }
}
