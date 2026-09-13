/**
 * Persistent cache in native IndexedDB (no localforage).
 * - A single getAll() on startup.
 * - Writes and deletes are batched and applied in ONE transaction.
 */
import type { ContentData } from "./parse-content";

export interface CachedContent {
    path: string;
    mtime: number;
    size: number;
    v: string;
    data: ContentData;
}

const STORE = "content";

function request<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
    });
}

export class ContentStore {
    private db: IDBDatabase | null = null;
    private pending = new Map<string, CachedContent | null>();
    private timer: number | null = null;

    constructor(private readonly name: string, private readonly version: string) {}

    async open(): Promise<void> {
        if (typeof indexedDB === "undefined") return;
        try {
            this.db = await new Promise<IDBDatabase>((resolve, reject) => {
                const req = indexedDB.open(this.name, 1);
                req.onupgradeneeded = () => {
                    if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "path" });
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error ?? new Error("Could not open the IndexedDB cache"));
            });
        } catch (e) {
            console.warn("cfrjs: persistent cache unavailable", e);
            this.db = null;
        }
    }

    async loadAll(): Promise<Map<string, CachedContent>> {
        const out = new Map<string, CachedContent>();
        if (!this.db) return out;
        try {
            const all = await request(this.db.transaction(STORE, "readonly").objectStore(STORE).getAll());
            for (const record of all as CachedContent[]) if (record.v === this.version) out.set(record.path, record);
        } catch (e) {
            console.warn("cfrjs: failed to read the cache", e);
        }
        return out;
    }

    put(path: string, mtime: number, size: number, data: ContentData): void {
        this.pending.set(path, { path, mtime, size, v: this.version, data });
        this.schedule();
    }

    remove(path: string): void {
        this.pending.set(path, null);
        this.schedule();
    }

    private schedule(): void {
        if (this.timer !== null || !this.db) return;
        this.timer = window.setTimeout(() => {
            this.timer = null;
            void this.flush();
        }, 2000);
    }

    async flush(): Promise<void> {
        if (!this.db || this.pending.size === 0) return;
        const batch = this.pending;
        this.pending = new Map();
        try {
            await new Promise<void>((resolve, reject) => {
                const tx = this.db!.transaction(STORE, "readwrite");
                const store = tx.objectStore(STORE);
                for (const [path, record] of batch) {
                    if (record) store.put(record);
                    else store.delete(path);
                }
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
                tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction was aborted"));
            });
        } catch (e) {
            console.warn("cfrjs: failed to write the cache", e);
        }
    }

    /** Removes entries for files that no longer exist (one transaction). */
    async prune(existing: ReadonlySet<string>, cached: Iterable<string>): Promise<number> {
        let removed = 0;
        for (const path of cached) {
            if (!existing.has(path)) {
                this.pending.set(path, null);
                removed++;
            }
        }
        if (removed) await this.flush();
        return removed;
    }

    async clear(): Promise<void> {
        this.pending.clear();
        if (!this.db) return;
        try {
            await request(this.db.transaction(STORE, "readwrite").objectStore(STORE).clear());
        } catch (e) {
            console.warn("cfrjs: failed to clear the cache", e);
        }
    }

    close(): void {
        if (this.timer !== null) window.clearTimeout(this.timer);
        this.timer = null;
        void this.flush().finally(() => this.db?.close());
    }
}
