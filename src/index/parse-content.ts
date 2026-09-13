/**
 * Content parser that runs in the worker: inline fields and list/task items.
 * Receives only the minimal metadata Obsidian already computed and walks the lines once.
 * Imports nothing from Obsidian and returns only strings/numbers (cheap structured clone).
 *
 * The inline field rules (wrapped `[key:: value]` / `(key:: value)` fields, full-line fields and the
 * task emoji shorthands) are adapted from Dataview (https://github.com/blacksmithgu/obsidian-dataview),
 * Copyright (c) 2021 Michael Brenan, released under the MIT License. See LICENSE.
 */

export interface ParseMeta {
    /** [startLine, endLine, parent (<0 = root), task status or null, blockId or null] */
    lists: [number, number, number, string | null, string | null][];
    /** [type, startLine, endLine] */
    sections: [string, number, number][];
    /** [line, text] */
    headings: [number, string][];
}

export interface RawListItem {
    line: number;
    lineCount: number;
    symbol: string;
    text: string;
    status: string | null;
    parent: number;
    blockId: string | null;
    fields: [string, string][];
    tags: string[];
    section: string | null;
    list: number;
}

export interface ContentData {
    fields: [string, string][];
    lists: RawListItem[];
}

export const EMPTY_CONTENT: ContentData = Object.freeze({ fields: [], lists: [] }) as ContentData;

const LIST_ITEM_RE = /^[\s>]*(\d+\.|\d+\)|\*|-|\+)\s*(\[.?\])?\s*(.*)$/u;
const SKIP_SECTIONS = new Set(["list", "code", "yaml", "math", "thematicBreak", "html", "comment"]);
const TAG_RE = /(?:^|[\s,;:!?"'(\[{])#([\p{L}\p{N}_\-/\p{Extended_Pictographic}]+)/gu;
const HAS_EMOJI_HINT = /[✅➕⏳⌛]|\uD83D[\uDCC5\uDCC6\uDDD3\uDEEB]/;

export function parseContent(content: string, meta: ParseMeta): ContentData {
    const hasFieldSep = content.indexOf("::") >= 0;
    if (!hasFieldSep && meta.lists.length === 0) return EMPTY_CONTENT;

    const starts = lineStarts(content);
    const lineCount = starts.length;
    const lineAt = (i: number): string => {
        if (i < 0 || i >= lineCount) return "";
        let end = i + 1 < lineCount ? starts[i + 1] - 1 : content.length;
        if (end > starts[i] && content.charCodeAt(end - 1) === 13) end--;
        return content.slice(starts[i], end);
    };

    const lists = parseLists(meta, lineAt, lineCount);
    const fields: [string, string][] = [];

    if (hasFieldSep) {
        // List lines are handled separately (and can appear inside callouts).
        const listLines = new Uint8Array(lineCount);
        for (const [s, e] of meta.lists) for (let l = s; l <= e && l < lineCount; l++) listLines[l] = 1;

        for (const [type, s, e] of meta.sections) {
            if (SKIP_SECTIONS.has(type)) continue;
            for (let lineno = s; lineno <= e && lineno < lineCount; lineno++) {
                if (listLines[lineno]) continue;
                const raw = lineAt(lineno);
                if (raw.length > 32768 || raw.indexOf("::") < 0) continue;
                const line = raw.trim();
                const inline = extractInlineFields(line);
                if (inline.length > 0) for (const f of inline) fields.push([f.key, f.value]);
                else {
                    const full = extractFullLineField(line);
                    if (full) fields.push([full.key, full.value]);
                }
            }
        }
    }

    return { fields, lists };
}

function lineStarts(content: string): Int32Array {
    let count = 1;
    for (let i = content.indexOf("\n"); i >= 0; i = content.indexOf("\n", i + 1)) count++;
    const starts = new Int32Array(count);
    let n = 1;
    for (let i = content.indexOf("\n"); i >= 0; i = content.indexOf("\n", i + 1)) starts[n++] = i + 1;
    return starts;
}

function parseLists(meta: ParseMeta, lineAt: (i: number) => string, lineCount: number): RawListItem[] {
    const out: RawListItem[] = [];
    if (meta.lists.length === 0) return out;

    const listSections = meta.sections.filter(s => s[0] === "list");
    let sectionPtr = 0;
    let headingPtr = -1;
    const headings = meta.headings;

    // Items, sections and headings are sorted by line — pointers avoid O(n²) lookups.
    const items = meta.lists[0] && meta.lists.every((it, i) => i === 0 || meta.lists[i - 1][0] <= it[0])
        ? meta.lists
        : meta.lists.slice().sort((a, b) => a[0] - b[0]);

    for (const [start, end, parent, task, blockId] of items) {
        if (start >= lineCount) continue;
        const first = LIST_ITEM_RE.exec(lineAt(start));
        if (!first) continue;

        let text = first[3];
        let joined = text;
        for (let l = start + 1; l <= end && l < lineCount; l++) {
            const t = lineAt(l).trim();
            text += "\n" + t;
            joined += " " + t;
        }

        while (sectionPtr < listSections.length && listSections[sectionPtr][2] < start) sectionPtr++;
        const sec = listSections[sectionPtr];
        const list = sec && sec[1] <= start && sec[2] >= start ? sec[1] : -1;

        while (headingPtr + 1 < headings.length && headings[headingPtr + 1][0] <= start) headingPtr++;
        const section = headingPtr >= 0 ? headings[headingPtr][1] : null;

        const fields: [string, string][] = [];
        if (joined.indexOf("::") >= 0 || HAS_EMOJI_HINT.test(joined)) {
            for (const f of extractInlineFields(joined, true)) fields.push([f.key, f.value]);
            if (task === null && fields.length === 0) {
                const full = extractFullLineField(joined);
                if (full) fields.push([full.key, full.value]);
            }
        }

        out.push({
            line: start,
            lineCount: end - start + 1,
            symbol: first[1],
            text,
            status: task,
            parent: parent >= 0 && parent !== start ? parent : -1,
            blockId,
            fields,
            tags: joined.indexOf("#") >= 0 ? extractTags(joined) : [],
            section,
            list,
        });
    }
    return out;
}

export function extractTags(text: string): string[] {
    const out: string[] = [];
    TAG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TAG_RE.exec(text))) {
        // Digit-only tags are not tags in Obsidian.
        if (!/^\d+$/.test(m[1])) out.push("#" + m[1]);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Inline fields: [key:: value], (key:: value) and full-line "Key:: value".
// ---------------------------------------------------------------------------

export interface InlineField {
    key: string;
    value: string;
    start: number;
    startValue: number;
    end: number;
    wrapping?: string;
}

const WRAPPERS: Record<string, string> = { "[": "]", "(": ")" };

function findClosing(line: string, start: number, open: string, close: string): { value: string; endIndex: number } | undefined {
    let nesting = 0;
    let escaped = false;
    for (let i = start; i < line.length; i++) {
        const ch = line[i];
        if (ch === "\\") {
            escaped = !escaped;
            continue;
        }
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === open) nesting++;
        else if (ch === close) nesting--;
        if (nesting < 0) return { value: line.substring(start, i).trim(), endIndex: i + 1 };
    }
    return undefined;
}

function findWrappedField(line: string, start: number): InlineField | undefined {
    const open = line[start];
    const sep = line.indexOf("::", start + 1);
    if (sep < 0) return undefined;
    const key = line.substring(start + 1, sep).trim();
    if (key.length === 0 || /[[\]()]/.test(key)) return undefined;

    const value = findClosing(line, sep + 2, open, WRAPPERS[open]);
    if (!value) return undefined;
    return { key, value: value.value, start, startValue: sep + 2, end: value.endIndex, wrapping: open };
}

const EMOJI_FIELDS: { re: RegExp; key: string }[] = [
    { re: /\u{2795}\s*(\d{4}-\d{2}-\d{2})/u, key: "created" },
    { re: /\u{1F6EB}\s*(\d{4}-\d{2}-\d{2})/u, key: "start" },
    { re: /[\u{23F3}\u{231B}]\s*(\d{4}-\d{2}-\d{2})/u, key: "scheduled" },
    { re: /(?:\u{1F4C5}|\u{1F4C6}|\u{1F5D3}\u{FE0F}?)\s*(\d{4}-\d{2}-\d{2})/u, key: "due" },
    { re: /\u{2705}\s*(\d{4}-\d{2}-\d{2})/u, key: "completion" },
];

export function extractInlineFields(line: string, includeTaskFields = false): InlineField[] {
    let fields: InlineField[] = [];
    if (line.indexOf("::") >= 0) {
        for (const wrapper of ["[", "("]) {
            let found = line.indexOf(wrapper);
            while (found >= 0) {
                const field = findWrappedField(line, found);
                if (!field) {
                    found = line.indexOf(wrapper, found + 1);
                    continue;
                }
                fields.push(field);
                found = line.indexOf(wrapper, field.end);
            }
        }
    }

    if (includeTaskFields && HAS_EMOJI_HINT.test(line)) {
        for (const { re, key } of EMOJI_FIELDS) {
            const m = re.exec(line);
            if (!m) continue;
            fields.push({
                key,
                value: m[1],
                start: m.index,
                startValue: m.index + 1,
                end: m.index + m[0].length,
                wrapping: "emoji-shorthand",
            });
        }
    }

    if (fields.length <= 1) return fields;
    fields.sort((a, b) => a.start - b.start);
    const filtered: InlineField[] = [];
    for (const f of fields) {
        if (filtered.length === 0 || filtered[filtered.length - 1].end < f.start) filtered.push(f);
    }
    fields = filtered;
    return fields;
}

const FULL_LINE_KEY = /^[^\p{L}\p{N}_]*([\p{L}\p{N}_\s/\-\p{Extended_Pictographic}]+?)[_*~`]*$/u;

export function extractFullLineField(text: string): InlineField | undefined {
    const sep = text.indexOf("::");
    if (sep < 0) return undefined;
    const m = FULL_LINE_KEY.exec(text.substring(0, sep).trim());
    if (!m) return undefined;
    const key = m[1].trim();
    if (key.length === 0) return undefined;
    return { key, value: text.substring(sep + 2).trim(), start: 0, startValue: sep + 2, end: text.length };
}
