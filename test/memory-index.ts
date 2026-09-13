/** In-memory index (no Obsidian) for tests and benchmarks. Simulates Obsidian's metadata. */
import { Page, PageEnv, RawLink, Row } from "../src/index/page";
import { ParseMeta, parseContent } from "../src/index/parse-content";
import { QueryIndex, UNRESOLVED_PREFIX } from "../src/query/execute";
import { Link } from "../src/values/link";

export interface NoteSpec {
    path: string;
    frontmatter?: Record<string, unknown>;
    tags?: string[];
    content?: string;
    ctime?: number;
    mtime?: number;
}

const LIST_LINE = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[(.)\]\s*)?/;
const LINK_RE = /(!?)\[\[([^\]]+)\]\]/g;
const TAG_RE = /(?:^|\s)(#[\p{L}\p{N}_\-/]+)/gu;

/** Produces metadata similar to Obsidian's MetadataCache. */
export function fakeMetadata(content: string): { meta: ParseMeta; links: RawLink[]; tags: string[] } {
    const lines = content.split("\n");
    const meta: ParseMeta = { lists: [], sections: [], headings: [] };
    const links: RawLink[] = [];
    const tags: string[] = [];
    const stack: { indent: number; line: number }[] = [];
    let sectionStart = -1;
    let sectionType = "";

    const closeSection = (end: number) => {
        if (sectionStart >= 0) meta.sections.push([sectionType, sectionStart, end]);
        sectionStart = -1;
    };

    lines.forEach((line, i) => {
        let m: RegExpExecArray | null;
        LINK_RE.lastIndex = 0;
        while ((m = LINK_RE.exec(line))) links.push({ link: Link.parseInner(m[2], m[1] === "!"), line: i });
        TAG_RE.lastIndex = 0;
        while ((m = TAG_RE.exec(line))) tags.push(m[1]);

        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        const list = LIST_LINE.exec(line);
        const type = heading ? "heading" : list ? "list" : line.trim() === "" ? "" : "paragraph";

        if (type !== sectionType || type === "heading") {
            closeSection(i - 1);
            if (type !== "") {
                sectionStart = i;
                sectionType = type;
            } else sectionType = "";
        }
        if (heading) meta.headings.push([i, heading[2]]);
        if (list) {
            const indent = list[1].length;
            while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
            const parent = stack.length ? stack[stack.length - 1].line : -i - 1;
            meta.lists.push([i, i, parent, list[2] ?? null, null]);
            stack.push({ indent, line: i });
        } else if (type !== "list") stack.length = 0;
    });
    closeSection(lines.length - 1);
    return { meta, links, tags };
}

export class MemoryIndex implements QueryIndex, PageEnv {
    pages = new Map<string, Page>();
    private tagIndex = new Map<string, Set<string>>();
    private incoming = new Map<string, Set<string>>();
    private outgoing = new Map<string, Set<string>>();
    private unresolved = new Map<string, Set<string>>();

    constructor(notes: NoteSpec[]) {
        for (const note of notes) this.add(note);
        this.rebuildLinks();
    }

    add(note: NoteSpec): void {
        const content = note.content ?? "";
        const { meta, links, tags } = fakeMetadata(content);
        const page = new Page(
            {
                path: note.path,
                ctime: note.ctime ?? 0,
                mtime: note.mtime ?? 0,
                size: content.length,
                frontmatter: note.frontmatter ?? null,
                tags: [...(note.tags ?? []), ...tags],
                aliases: [],
                links,
            },
            parseContent(content, meta),
            this
        );
        this.pages.set(note.path, page);
        for (const t of page.tagKeys) {
            let set = this.tagIndex.get(t);
            if (!set) this.tagIndex.set(t, (set = new Set()));
            set.add(note.path);
        }
    }

    rebuildLinks(): void {
        this.incoming.clear();
        this.outgoing.clear();
        this.unresolved.clear();
        for (const page of this.pages.values()) {
            const out = new Set<string>();
            for (const { link } of page.input.links) {
                const dest = this.resolveLinkPath(link.path, page.path);
                if (dest) {
                    out.add(dest);
                    let inc = this.incoming.get(dest);
                    if (!inc) this.incoming.set(dest, (inc = new Set()));
                    inc.add(page.path);
                } else {
                    const key = link.path.toLowerCase();
                    let un = this.unresolved.get(key);
                    if (!un) this.unresolved.set(key, (un = new Set()));
                    un.add(page.path);
                }
            }
            this.outgoing.set(page.path, out);
        }
    }

    // PageEnv
    resolveLinkPath(linkpath: string, _origin: string): string | null {
        if (this.pages.has(linkpath)) return linkpath;
        if (this.pages.has(linkpath + ".md")) return linkpath + ".md";
        for (const path of this.pages.keys()) {
            const base = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
            if (base === linkpath) return path;
        }
        return null;
    }
    linkEpoch(): number {
        return 0;
    }
    inlinks(path: string): ReadonlySet<string> {
        return this.incoming.get(path) ?? new Set();
    }
    isStarred(): boolean {
        return false;
    }

    // QueryIndex
    allPagePaths(): Iterable<string> {
        return this.pages.keys();
    }
    pageRow(path: string): Row | undefined {
        return this.pages.get(path)?.row;
    }
    pageTasks(path: string): Iterable<Row> {
        return this.pages.get(path)?.tasks ?? [];
    }
    tagPaths(tagKey: string): ReadonlySet<string> {
        return this.tagIndex.get(tagKey) ?? new Set();
    }
    folderPaths(folder: string): ReadonlySet<string> | null {
        const prefix = folder + "/";
        const out = new Set<string>();
        for (const p of this.pages.keys()) if (p.startsWith(prefix)) out.add(p);
        return out.size ? out : null;
    }
    isPage(path: string): boolean {
        return this.pages.has(path);
    }
    fileExists(path: string): boolean {
        return this.pages.has(path);
    }
    incomingPaths(path: string): ReadonlySet<string> {
        return this.incoming.get(path) ?? new Set();
    }
    unresolvedIncoming(linktext: string): ReadonlySet<string> {
        return this.unresolved.get(linktext.replace(UNRESOLVED_PREFIX, "")) ?? new Set();
    }
    outgoingPaths(path: string): ReadonlySet<string> {
        return this.outgoing.get(path) ?? new Set();
    }
    async loadCsv(path: string): Promise<{ path: string; rows: Row[] }> {
        throw new Error("CSV is not supported by the in-memory index: " + path);
    }
}
