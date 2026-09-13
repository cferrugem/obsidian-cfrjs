/** Converts raw text (inline fields, frontmatter, CSV) into typed values — no Parsimmon. */
import { parseISODate } from "./date";
import { parseDuration } from "./duration";
import { Link } from "./link";
import { Literal } from "./types";

const NUMBER_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/** Parses a scalar text value: number, boolean, date, duration, link or string. */
export function parseScalar(raw: string, allowNumbers = true): Literal {
    const s = raw.trim();
    if (s.length === 0) return null;
    const c = s.charCodeAt(0);

    // Digits or a sign: number, date or duration.
    if ((c >= 48 && c <= 57) || c === 45 || c === 46) {
        if (allowNumbers && NUMBER_RE.test(s)) return Number(s);
        const date = parseISODate(s);
        if (date) return date;
        const dur = parseDuration(s);
        if (dur) return dur;
        return s;
    }

    // Links [[...]] or ![[...]]
    if (c === 91 || c === 33) {
        const link = parseLinkText(s);
        if (link) return link;
        return s;
    }

    if (c === 116 || c === 102 || c === 84 || c === 70) {
        const lower = s.toLowerCase();
        if (lower === "true") return true;
        if (lower === "false") return false;
    }

    // Quoted string.
    if ((c === 34 && s.endsWith('"') && s.length >= 2) || (c === 39 && s.endsWith("'") && s.length >= 2)) {
        return s.slice(1, -1);
    }
    return s;
}

/** `[[Note]]` or `![[Note]]` spanning the whole text. */
export function parseLinkText(s: string): Link | null {
    const embed = s.startsWith("!");
    const body = embed ? s.slice(1) : s;
    if (!body.startsWith("[[") || !body.endsWith("]]")) return null;
    const inner = body.slice(2, -2);
    if (inner.includes("]]") || inner.includes("[[")) return null;
    return Link.parseInner(inner, embed);
}

/** Splits on top-level commas, respecting [[ ]], quotes and parentheses. */
function splitTopLevel(s: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let quote = 0;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (quote) {
            if (c === quote && s.charCodeAt(i - 1) !== 92) quote = 0;
            continue;
        }
        if (c === 34) quote = c;
        else if (c === 91 || c === 40 || c === 123) depth++;
        else if (c === 93 || c === 41 || c === 125) depth--;
        else if (c === 44 && depth === 0) {
            parts.push(s.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(s.slice(start));
    return parts;
}

/**
 * Inline field value. Lists are only created when every element is a non-text literal
 * (links, numbers, dates...) or a quoted string — same as Dataview.
 */
export function parseInlineValue(raw: string): Literal {
    const s = raw.trim();
    if (s.length === 0) return null;
    if (s.indexOf(",") >= 0) {
        const parts = splitTopLevel(s);
        if (parts.length > 1) {
            const values: Literal[] = [];
            let ok = true;
            for (const part of parts) {
                const p = part.trim();
                const v = parseScalar(p);
                if (typeof v === "string" && !(p.startsWith('"') && p.endsWith('"'))) {
                    ok = false;
                    break;
                }
                values.push(v);
            }
            if (ok) return values;
        }
    }
    return parseScalar(s);
}

/** Recursively converts frontmatter (already parsed by Obsidian) into typed values. */
export function parseFrontmatterValue(value: unknown, depth = 0): Literal {
    if (value === null || value === undefined) return null;
    switch (typeof value) {
        case "number":
        case "boolean":
            return value;
        case "string": {
            if (value.length === 0) return value;
            const c = value.charCodeAt(0);
            // Only attempt conversions when the first character allows it.
            if ((c >= 48 && c <= 57) || c === 45) {
                const date = parseISODate(value);
                if (date) return date;
                const dur = parseDuration(value);
                if (dur) return dur;
                return value;
            }
            if (c === 91 || c === 33) return parseLinkText(value.trim()) ?? value;
            return value;
        }
    }
    if (depth > 20) return null;
    if (Array.isArray(value)) {
        const out: Literal[] = [];
        for (const item of value) out.push(parseFrontmatterValue(item, depth + 1));
        return out;
    }
    if (value instanceof Date) return null;
    const out: Record<string, Literal> = {};
    const record = value as Record<string, unknown>;
    for (const key in record) {
        out[key] = parseFrontmatterValue(record[key], depth + 1);
    }
    return out;
}

const CANON_STRIP = /[^\p{L}\p{N}\p{Extended_Pictographic}_-]/gu;

/** Normalizes a field name ("Due Date" -> "due-date"). */
export function canonicalizeKey(key: string): string {
    return key.trim().toLowerCase().replace(/\s+/g, "-").replace(CANON_STRIP, "");
}
