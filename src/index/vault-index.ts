/**
 * Vault index integrated with Obsidian.
 *
 * - Frontmatter, tags and links come from the MetadataCache (no file reads).
 * - Inline fields and lists are parsed in batches by workers, only for files without a valid cache.
 * - Changes are accumulated and emitted in batches with old and new tags/links, so that
 *   only affected views are refreshed.
 */
import {
    App,
    CachedMetadata,
    Component,
    getAllTags,
    getLinkpath,
    normalizePath,
    parseFrontMatterAliases,
    TAbstractFile,
    TFile,
    TFolder,
} from "obsidian";
import workerCode from "worker-code";
import { BookmarkItem, getAppId, getBookmarks } from "../obsidian-internals";
import { ChangeBatch, PageChange } from "../query/deps";
import { QueryError } from "../query/errors";
import { QueryIndex, UNRESOLVED_PREFIX } from "../query/execute";
import { Link } from "../values/link";
import { canonicalizeKey, parseScalar } from "../values/parse-value";
import { createRow } from "../values/types";
import { EMPTY_SET, SetIndex } from "./indices";
import { Page, PageEnv, PageInput, RawLink, Row } from "./page";
import { ContentData, ParseMeta } from "./parse-content";
import { ContentStore } from "./persist";
import { handleRequest } from "./worker";
import { WorkerPool } from "./worker-pool";

/** Bump when the ContentData format changes. */
const CACHE_VERSION = "1";
const BATCH_SIZE = 64;

export interface IndexStats {
    files: number;
    cached: number;
    parsed: number;
    skipped: number;
    metadataMs: number;
    parseMs: number;
    workers: number;
}

const yieldToMain = () => new Promise<void>(resolve => window.setTimeout(resolve, 0));

function isMarkdown(file: TAbstractFile): file is TFile {
    return file instanceof TFile && (file.extension === "md" || file.extension === "markdown");
}

function ancestors(path: string): Set<string> {
    const out = new Set<string>();
    for (let i = path.indexOf("/"); i >= 0; i = path.indexOf("/", i + 1)) out.add(path.slice(0, i));
    return out;
}

function unionSets(a: ReadonlySet<string>, b: ReadonlySet<string>): Set<string> {
    const out = new Set(a);
    for (const v of b) out.add(v);
    return out;
}

export class VaultIndex extends Component implements QueryIndex, PageEnv {
    readonly pages = new Map<string, Page>();
    private readonly tags = new SetIndex();
    private readonly links = new SetIndex();
    private readonly unresolved = new SetIndex();
    private readonly folders = new SetIndex();

    revision = 0;
    ready = false;
    stats: IndexStats = { files: 0, cached: 0, parsed: 0, skipped: 0, metadataMs: 0, parseMs: 0, workers: 0 };

    private epoch = 0;
    private readonly pool: WorkerPool;
    private readonly store: ContentStore;
    private readonly listeners = new Set<(batch: ChangeBatch) => void>();
    private pending: PageChange[] = [];
    private flushTimer: number | null = null;
    private bulk = false;
    private parseQueue = new Map<string, TFile>();
    private parseTimer: number | null = null;
    private linkCache = new Map<string, string | null>();
    private linkCacheEpoch = -1;
    private csvCache = new Map<string, { mtime: number; rows: Row[] }>();
    private starred: Set<string> | null = null;
    /** Files resolved by Obsidian while initialization was still running. */
    private lateFiles = new Set<TFile>();

    constructor(private readonly app: App, workers: number) {
        super();
        this.pool = new WorkerPool(workerCode, workers, handleRequest);
        this.stats.workers = this.pool.size;
        this.store = new ContentStore(`cfrjs-cache-${getAppId(app)}`, CACHE_VERSION);
    }

    onunload(): void {
        this.pool.terminate();
        this.store.close();
        if (this.flushTimer) window.clearTimeout(this.flushTimer);
        if (this.parseTimer) window.clearTimeout(this.parseTimer);
        this.listeners.clear();
    }

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    onBatch(listener: (batch: ChangeBatch) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private queueChange(change: PageChange): void {
        if (!this.ready) return;
        this.pending.push(change);
        if (this.flushTimer !== null) return;
        this.flushTimer = window.setTimeout(() => {
            this.flushTimer = null;
            this.emit(false, false);
        }, this.bulk ? 750 : 30);
    }

    private emit(allPages: boolean, starred: boolean): void {
        const changes = this.pending;
        this.pending = [];
        if (!allPages && !starred && changes.length === 0) return;
        this.revision++;
        const batch: ChangeBatch = { revision: this.revision, allPages, starred, changes };
        for (const listener of this.listeners) {
            try {
                listener(batch);
            } catch (e) {
                console.error("cfrjs: error while notifying a change", e);
            }
        }
    }

    /** Forces every view to refresh. */
    touch(): void {
        this.emit(true, false);
    }

    // ------------------------------------------------------------------
    // Initialization
    // ------------------------------------------------------------------

    async initialize(): Promise<void> {
        const { vault, metadataCache } = this.app;
        this.registerEvent(metadataCache.on("resolve", file => this.onResolve(file)));
        this.registerEvent(metadataCache.on("resolved", () => this.refreshAllLinks()));
        this.registerEvent(vault.on("rename", (file, oldPath) => this.onRename(file, oldPath)));
        this.registerEvent(vault.on("delete", file => this.onDelete(file)));
        this.registerEvent(vault.on("create", () => this.epoch++));
        this.registerEvent(vault.on("modify", file => this.onModify(file)));
        this.watchBookmarks();

        const start = performance.now();
        await this.store.open();
        const cached = await this.store.loadAll();

        const files = vault.getMarkdownFiles();
        const toParse: TFile[] = [];
        let processed = 0;
        for (const file of files) {
            const meta = metadataCache.getFileCache(file);
            if (!meta) {
                this.stats.skipped++;
                continue;
            }
            const record = cached.get(file.path);
            const valid = record && record.mtime === file.stat.mtime && record.size === file.stat.size;
            this.setPage(file, meta, valid ? record.data : null);
            if (valid) this.stats.cached++;
            else toParse.push(file);
            // Yield periodically so Obsidian's startup is not blocked.
            if (++processed % 2000 === 0) await yieldToMain();
        }

        // Files that had no metadata at first and were resolved during the loop above.
        for (const file of this.lateFiles) {
            const meta = metadataCache.getFileCache(file);
            if (!meta || this.pages.has(file.path) || vault.getAbstractFileByPath(file.path) !== file) continue;
            this.setPage(file, meta, null);
            toParse.push(file);
            this.stats.skipped = Math.max(0, this.stats.skipped - 1);
        }
        this.lateFiles.clear();

        this.stats.files = files.length;
        this.stats.metadataMs = performance.now() - start;
        this.ready = true;
        this.emit(true, false);
        this.app.metadataCache.trigger("cfrjs:index-ready");

        const parseStart = performance.now();
        this.bulk = true;
        try {
            await this.parseFiles(toParse);
        } finally {
            this.bulk = false;
        }
        this.stats.parseMs = performance.now() - parseStart;

        // Nothing is logged; timings are available through the "Show index statistics" command.
        await this.store.prune(new Set(files.map(f => f.path)), cached.keys());
    }

    /** Discards the persistent cache and re-parses every file. */
    async rebuild(): Promise<void> {
        await this.store.clear();
        this.csvCache.clear();
        const start = performance.now();
        this.bulk = true;
        try {
            await this.parseFiles(this.app.vault.getMarkdownFiles());
        } finally {
            this.bulk = false;
        }
        this.stats.parseMs = performance.now() - start;
        this.touch();
    }

    // ------------------------------------------------------------------
    // Page construction
    // ------------------------------------------------------------------

    private buildInput(file: TFile, meta: CachedMetadata): PageInput {
        const links: RawLink[] = [];
        const push = (raw: { link: string; original: string; displayText?: string }, line: number, embed: boolean) => {
            const parsed = Link.parseInner(raw.link, embed);
            const display = raw.original.includes("|") ? raw.displayText : undefined;
            links.push({ link: display ? parsed.withDisplay(display) : parsed, line });
        };
        for (const l of meta.frontmatterLinks ?? []) push(l, -1, false);
        for (const l of meta.links ?? []) push(l, l.position.start.line, false);
        for (const l of meta.embeds ?? []) push(l, l.position.start.line, true);

        return {
            path: file.path,
            ctime: file.stat.ctime,
            mtime: file.stat.mtime,
            size: file.stat.size,
            frontmatter: (meta.frontmatter) ?? null,
            tags: getAllTags(meta) ?? [],
            aliases: parseFrontMatterAliases(meta.frontmatter ?? null) ?? [],
            links,
        };
    }

    private static parseMeta(meta: CachedMetadata): ParseMeta {
        return {
            lists: (meta.listItems ?? []).map(l => [l.position.start.line, l.position.end.line, l.parent, l.task ?? null, l.id ?? null]),
            sections: (meta.sections ?? []).map(s => [s.type, s.position.start.line, s.position.end.line]),
            headings: (meta.headings ?? []).map(h => [h.position.start.line, h.heading]),
        };
    }

    private setPage(file: TFile, meta: CachedMetadata, content: ContentData | null): void {
        const path = file.path;
        const old = this.pages.get(path);
        const page = new Page(this.buildInput(file, meta), content ?? old?.content ?? null, this);
        this.pages.set(path, page);

        const oldTags = this.tags.get(path);
        this.tags.set(path, page.tagKeys);
        this.folders.set(path, ancestors(path));
        const oldLinks = this.linkKeys(path);
        this.updateLinks(path);

        this.queueChange({
            kind: "page",
            path,
            tags: unionSets(oldTags, page.tagKeys),
            links: unionSets(oldLinks, this.linkKeys(path)),
        });
    }

    private linkKeys(path: string): Set<string> {
        const out = new Set(this.links.get(path));
        for (const u of this.unresolved.get(path)) out.add(UNRESOLVED_PREFIX + u);
        return out;
    }

    private updateLinks(path: string): boolean {
        const resolved = this.app.metadataCache.resolvedLinks[path];
        const unresolved = this.app.metadataCache.unresolvedLinks[path];
        const a = this.links.set(path, new Set(resolved ? Object.keys(resolved) : []));
        const b = this.unresolved.set(path, new Set(unresolved ? Object.keys(unresolved).map(k => k.toLowerCase()) : []));
        return a || b;
    }

    private refreshAllLinks(): void {
        this.epoch++;
        for (const path of this.pages.keys()) {
            const oldLinks = this.linkKeys(path);
            if (this.updateLinks(path)) {
                this.queueChange({ kind: "page", path, tags: EMPTY_SET, links: unionSets(oldLinks, this.linkKeys(path)) });
            }
        }
    }

    // ------------------------------------------------------------------
    // Batched content parsing
    // ------------------------------------------------------------------

    private async parseFiles(files: TFile[]): Promise<void> {
        if (files.length === 0) return;
        const maxInFlight = Math.max(2, this.pool.size * 2);
        const inFlight = new Set<Promise<void>>();

        for (let i = 0; i < files.length; i += BATCH_SIZE) {
            const batch = files.slice(i, i + BATCH_SIZE);
            const task = this.parseBatch(batch).catch(e => console.error("cfrjs: failed to process batch", e));
            inFlight.add(task);
            void task.finally(() => inFlight.delete(task));
            if (inFlight.size >= maxInFlight) await Promise.race(inFlight);
        }
        await Promise.all(inFlight);
    }

    private async parseBatch(files: TFile[]): Promise<void> {
        const { vault, metadataCache } = this.app;
        const snapshots: { file: TFile; mtime: number; size: number; meta: CachedMetadata }[] = [];
        const contents = await Promise.all(
            files.map(async file => {
                const meta = metadataCache.getFileCache(file);
                if (!meta) return null;
                try {
                    const content = await vault.cachedRead(file);
                    snapshots.push({ file, mtime: file.stat.mtime, size: file.stat.size, meta });
                    return { content, meta: VaultIndex.parseMeta(meta), file };
                } catch {
                    return null;
                }
            })
        );
        const jobs = contents.filter((c): c is NonNullable<typeof c> => c !== null);
        if (jobs.length === 0) return;

        const response = await this.pool.run<"parse">({ kind: "parse", jobs: jobs.map(j => ({ content: j.content, meta: j.meta })) });
        if (response.kind !== "parse") return;

        response.results.forEach((data, i) => {
            if (!data) return;
            const { file } = jobs[i];
            const snap = snapshots.find(s => s.file === file)!;
            // File deleted or renamed while it was being processed.
            if (this.app.vault.getAbstractFileByPath(file.path) !== file) return;
            const meta = metadataCache.getFileCache(file) ?? snap.meta;
            this.setPage(file, meta, data);
            this.store.put(file.path, snap.mtime, snap.size, data);
            this.stats.parsed++;
        });
    }

    private queueParse(file: TFile): void {
        this.parseQueue.set(file.path, file);
        if (this.parseTimer !== null) return;
        this.parseTimer = window.setTimeout(() => {
            this.parseTimer = null;
            const files = [...this.parseQueue.values()];
            this.parseQueue.clear();
            void this.parseFiles(files);
        }, 50);
    }

    // ------------------------------------------------------------------
    // Vault handlers
    // ------------------------------------------------------------------

    private onResolve(file: TFile): void {
        if (!isMarkdown(file)) return;
        if (!this.ready) {
            this.lateFiles.add(file);
            return;
        }
        const meta = this.app.metadataCache.getFileCache(file);
        if (!meta) return;
        const page = this.pages.get(file.path);

        if (page && page.content && page.input.mtime === file.stat.mtime && page.input.size === file.stat.size) {
            // Same content: only link targets may have changed.
            const oldLinks = this.linkKeys(file.path);
            if (this.updateLinks(file.path)) {
                this.queueChange({ kind: "page", path: file.path, tags: EMPTY_SET, links: unionSets(oldLinks, this.linkKeys(file.path)) });
            }
            return;
        }

        // Frontmatter/tags update immediately; inline fields arrive after parsing.
        this.setPage(file, meta, null);
        this.queueParse(file);
    }

    private onRename(file: TAbstractFile, oldPath: string): void {
        this.epoch++;
        if (file instanceof TFile && file.extension === "csv") {
            this.csvCache.delete(oldPath);
            this.queueChange({ kind: "csv", path: oldPath, tags: EMPTY_SET, links: EMPTY_SET });
            return;
        }
        if (!isMarkdown(file)) return;
        const old = this.pages.get(oldPath);
        if (!old) return;

        const oldTags = this.tags.get(oldPath);
        const oldLinks = this.linkKeys(oldPath);
        this.pages.delete(oldPath);
        this.tags.delete(oldPath);
        this.links.delete(oldPath);
        this.unresolved.delete(oldPath);
        this.folders.delete(oldPath);

        const input: PageInput = { ...old.input, path: file.path };
        const page = new Page(input, old.content, this);
        this.pages.set(file.path, page);
        this.tags.set(file.path, page.tagKeys);
        this.folders.set(file.path, ancestors(file.path));
        this.updateLinks(file.path);

        this.store.remove(oldPath);
        if (old.content) this.store.put(file.path, input.mtime, input.size, old.content);
        this.queueChange({ kind: "page", path: file.path, oldPath, tags: oldTags, links: unionSets(oldLinks, this.linkKeys(file.path)) });
    }

    private onDelete(file: TAbstractFile): void {
        this.epoch++;
        if (file instanceof TFile && file.extension === "csv") {
            this.csvCache.delete(file.path);
            this.queueChange({ kind: "csv", path: file.path, tags: EMPTY_SET, links: EMPTY_SET });
            return;
        }
        if (!isMarkdown(file) || !this.pages.has(file.path)) return;
        const tags = this.tags.get(file.path);
        const links = this.linkKeys(file.path);
        this.pages.delete(file.path);
        this.tags.delete(file.path);
        this.links.delete(file.path);
        this.unresolved.delete(file.path);
        this.folders.delete(file.path);
        this.store.remove(file.path);
        this.queueChange({ kind: "page", path: file.path, tags, links });
    }

    private onModify(file: TAbstractFile): void {
        if (file instanceof TFile && file.extension === "csv") {
            this.csvCache.delete(file.path);
            this.queueChange({ kind: "csv", path: file.path, tags: EMPTY_SET, links: EMPTY_SET });
        }
    }

    // ------------------------------------------------------------------
    // Bookmarks — event-driven, no polling
    // ------------------------------------------------------------------

    private watchBookmarks(): void {
        const instance = getBookmarks(this.app);
        if (instance && typeof instance.on === "function") {
            this.registerEvent(
                instance.on("changed", () => {
                    this.starred = null;
                    this.emit(false, true);
                })
            );
        }
    }

    isStarred(path: string): boolean {
        if (!this.starred) {
            const set = new Set<string>();
            const walk = (items: BookmarkItem[] | undefined) => {
                for (const item of items ?? []) {
                    if (item.type === "file" && item.path) set.add(item.path);
                    else if (item.type === "group") walk(item.items);
                }
            };
            walk(getBookmarks(this.app)?.items);
            this.starred = set;
        }
        return this.starred.has(path);
    }

    // ------------------------------------------------------------------
    // PageEnv / QueryIndex
    // ------------------------------------------------------------------

    linkEpoch(): number {
        return this.epoch;
    }

    inlinks(path: string): ReadonlySet<string> {
        return this.links.getInverse(path);
    }

    resolveLinkPath(linktext: string, origin: string): string | null {
        if (this.linkCacheEpoch !== this.epoch || this.linkCache.size > 50000) {
            this.linkCache.clear();
            this.linkCacheEpoch = this.epoch;
        }
        const key = origin + "\u0000" + linktext;
        let result = this.linkCache.get(key);
        if (result === undefined) {
            result = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(linktext), origin)?.path ?? null;
            this.linkCache.set(key, result);
        }
        return result;
    }

    allPagePaths(): Iterable<string> {
        return this.pages.keys();
    }

    pageRow(path: string): Row | undefined {
        return this.pages.get(path)?.row;
    }

    page(path: string): Page | undefined {
        return this.pages.get(path);
    }

    pageTasks(path: string): Iterable<Row> {
        return this.pages.get(path)?.tasks ?? [];
    }

    tagPaths(tagKey: string): ReadonlySet<string> {
        return this.tags.getInverse(tagKey);
    }

    folderPaths(folder: string): ReadonlySet<string> | null {
        const set = this.folders.getInverse(folder);
        if (set.size > 0) return set;
        return this.app.vault.getAbstractFileByPath(folder) instanceof TFolder ? EMPTY_SET : null;
    }

    isPage(path: string): boolean {
        return this.pages.has(path);
    }

    fileExists(path: string): boolean {
        return this.app.vault.getAbstractFileByPath(path) !== null;
    }

    incomingPaths(path: string): ReadonlySet<string> {
        return this.links.getInverse(path);
    }

    unresolvedIncoming(linktext: string): ReadonlySet<string> {
        return this.unresolved.getInverse(linktext.toLowerCase());
    }

    outgoingPaths(path: string): ReadonlySet<string> {
        return this.links.get(path);
    }

    /** Resolves a user-provided path, absolute from the vault root or relative to the origin note's folder. */
    resolveFile(path: string, origin: string): TFile | null {
        const direct = this.app.vault.getAbstractFileByPath(normalizePath(path));
        if (direct instanceof TFile) return direct;
        const slash = origin.lastIndexOf("/");
        if (slash >= 0) {
            const relative = this.app.vault.getAbstractFileByPath(normalizePath(origin.slice(0, slash) + "/" + path));
            if (relative instanceof TFile) return relative;
        }
        return null;
    }

    async loadCsv(path: string, origin: string): Promise<{ path: string; rows: Row[] }> {
        const file = this.resolveFile(path, origin);
        if (!file) throw new QueryError(`CSV file not found: "${path}"`);

        const cached = this.csvCache.get(file.path);
        if (cached && cached.mtime === file.stat.mtime) return { path: file.path, rows: cached.rows };

        const text = await this.app.vault.cachedRead(file);
        const response = await this.pool.run<"csv">({ kind: "csv", text });
        if (response.kind !== "csv") throw new QueryError("Failed to read the CSV file");

        const [header = [], ...data] = response.rows;
        const keys = header.map(h => h.trim());
        const canon = keys.map(k => canonicalizeKey(k));
        const rows: Row[] = data.map(cells => {
            const row = createRow();
            for (let i = 0; i < keys.length; i++) {
                const value = parseScalar(cells[i] ?? "");
                row[keys[i]] = value;
                if (canon[i] && !(canon[i] in row)) row[canon[i]] = value;
            }
            return row;
        });
        if (this.csvCache.size > 32) this.csvCache.clear();
        this.csvCache.set(file.path, { mtime: file.stat.mtime, rows });
        return { path: file.path, rows };
    }
}
