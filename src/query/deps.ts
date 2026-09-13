/** Dependency tracking: decides which views need refreshing after a change. */

export interface PageChange {
    kind: "page" | "csv";
    path: string;
    oldPath?: string;
    /** Tags (lowercase, including subtags) before AND after the change. */
    tags: ReadonlySet<string>;
    /** Link targets (resolved paths) before AND after the change. */
    links: ReadonlySet<string>;
}

export interface ChangeBatch {
    revision: number;
    /** Invalidates everything (index ready, manual refresh, settings). */
    global: boolean;
    starred: boolean;
    changes: PageChange[];
}

export class DepSet {
    all = false;
    starred = false;
    tags = new Set<string>();
    folders = new Set<string>();
    paths = new Set<string>();
    linksTo = new Set<string>();
    csv = new Set<string>();

    merge(other: DepSet): void {
        this.all ||= other.all;
        this.starred ||= other.starred;
        other.tags.forEach(t => this.tags.add(t));
        other.folders.forEach(f => this.folders.add(f));
        other.paths.forEach(p => this.paths.add(p));
        other.linksTo.forEach(l => this.linksTo.add(l));
        other.csv.forEach(c => this.csv.add(c));
    }

    clear(): void {
        this.all = false;
        this.starred = false;
        this.tags.clear();
        this.folders.clear();
        this.paths.clear();
        this.linksTo.clear();
        this.csv.clear();
    }
}

function inFolder(path: string, folder: string): boolean {
    return path.length > folder.length && path.startsWith(folder) && path.charCodeAt(folder.length) === 47;
}

function intersects(small: ReadonlySet<string>, large: ReadonlySet<string>): boolean {
    if (small.size > large.size) [small, large] = [large, small];
    for (const v of small) if (large.has(v)) return true;
    return false;
}

export function isAffected(deps: DepSet, batch: ChangeBatch): boolean {
    if (batch.global) return true;
    if (batch.starred && deps.starred) return true;

    for (const c of batch.changes) {
        if (c.kind === "csv") {
            if (deps.csv.has(c.path)) return true;
            continue;
        }
        if (deps.all) return true;
        if (deps.paths.has(c.path) || (c.oldPath !== undefined && deps.paths.has(c.oldPath))) return true;
        if (deps.tags.size && c.tags.size && intersects(deps.tags, c.tags)) return true;
        if (deps.linksTo.size && c.links.size && intersects(deps.linksTo, c.links)) return true;
        for (const folder of deps.folders) {
            if (inFolder(c.path, folder) || (c.oldPath !== undefined && inFolder(c.oldPath, folder))) return true;
        }
    }
    return false;
}
