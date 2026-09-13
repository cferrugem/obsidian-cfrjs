/** Value types and basic helpers (no Obsidian dependency). */
import { CDate } from "./date";
import { CDuration } from "./duration";
import { Link } from "./link";

/** Any value handled by the query language. */
export type Literal = null | boolean | number | string | object;

export type LType =
    | "null"
    | "boolean"
    | "number"
    | "string"
    | "date"
    | "duration"
    | "link"
    | "array"
    | "object"
    | "widget"
    | "function"
    | "html";

/** Object with string and symbol keys: query rows, frontmatter objects, etc. */
export type Row = { [key: string]: unknown; [key: symbol]: unknown };

export type Callable = (...args: unknown[]) => unknown;

export interface ListPairWidget {
    $widget: "listpair";
    key: unknown;
    value: unknown;
}

export interface ExternalLinkWidget {
    $widget: "elink";
    url: string;
    display?: string;
}

export type Widget = ListPairWidget | ExternalLinkWidget;

const hasHTMLElement = typeof HTMLElement !== "undefined";

/**
 * "Base" row of a query object. Missing fields are looked up there.
 * Used by task items (base = page) and FLATTEN (base = original row), avoiding
 * Object.create per row — which gives every object a different prototype and makes V8 megamorphic.
 */
export const ROW_BASE: unique symbol = Symbol("cfrjs.base");

export function isRecord(v: unknown): v is Row {
    return typeof v === "object" && v !== null;
}

export function isArray(v: unknown): v is unknown[] {
    return Array.isArray(v);
}

export function isCallable(v: unknown): v is Callable {
    return typeof v === "function";
}

/** Creates an empty, prototype-less row. */
export function createRow(): Row {
    return Object.create(null) as Row;
}

export function typeOf(v: unknown): LType {
    if (v === null || v === undefined) return "null";
    switch (typeof v) {
        case "string":
            return "string";
        case "number":
            return "number";
        case "boolean":
            return "boolean";
        case "function":
            return "function";
    }
    if (isArray(v)) return "array";
    if (v instanceof Link) return "link";
    if (v instanceof CDate) return "date";
    if (v instanceof CDuration) return "duration";
    if (hasHTMLElement && v instanceof HTMLElement) return "html";
    if (isWidget(v)) return "widget";
    return "object";
}

export function isWidget(v: unknown): v is Widget {
    return isRecord(v) && typeof v.$widget === "string";
}

export function truthy(v: unknown): boolean {
    if (v === null || v === undefined) return false;
    switch (typeof v) {
        case "boolean":
            return v;
        case "number":
            return v !== 0 && !Number.isNaN(v);
        case "string":
            return v.length > 0;
        case "function":
            return true;
    }
    if (isArray(v)) return v.length > 0;
    if (v instanceof CDate || v instanceof CDuration || v instanceof Link) return true;
    if (hasHTMLElement && v instanceof HTMLElement) return true;
    if (isRecord(v)) {
        for (const _ in v) return true;
    }
    return false;
}

/** Formats used when converting dates to text. Updated from the settings. */
export const displayFormats = {
    date: "MMMM dd, yyyy",
    dateTime: "h:mm a - MMMM dd, yyyy",
    nullAs: "-",
};

export function formatDate(d: CDate): string {
    return d.format(d.hasTime ? displayFormats.dateTime : displayFormats.date);
}

/** Text conversion used by concatenation, join() and string(). */
export function valueToString(v: unknown, depth = 0): string {
    if (v === null || v === undefined) return "null";
    switch (typeof v) {
        case "string":
            return v;
        case "number":
        case "boolean":
        case "bigint":
            return String(v);
        case "symbol":
            return v.toString();
        case "function":
            return "<function>";
    }
    if (!isRecord(v)) return "";
    if (depth > 6) return "...";
    if (isArray(v)) return v.map(x => valueToString(x, depth + 1)).join(", ");
    if (v instanceof CDate) return formatDate(v);
    if (v instanceof CDuration) return v.toHuman();
    if (v instanceof Link) return v.markdown();
    if (hasHTMLElement && v instanceof HTMLElement) return v.outerHTML;
    if (isWidget(v)) {
        if (v.$widget === "listpair") return `${valueToString(v.key, depth + 1)}: ${valueToString(v.value, depth + 1)}`;
        return v.display ?? v.url;
    }
    const custom = customToString(v);
    if (custom !== null) return custom;
    return "{ " + Object.entries(v).map(([k, x]) => `${k}: ${valueToString(x, depth + 1)}`).join(", ") + " }";
}

/**
 * Stable textual key for grouping, distinct and result diffing.
 * Cheaper than JSON.stringify and aware of the custom value types.
 */
export function valueKey(v: unknown, depth = 0): string {
    if (v === null || v === undefined) return "n";
    switch (typeof v) {
        case "string":
            return "s" + v;
        case "number":
            return "#" + String(v);
        case "boolean":
            return v ? "T" : "F";
        case "function":
            return "f";
    }
    if (!isRecord(v)) return "?";
    if (depth > 8) return "…";
    if (isArray(v)) {
        let out = "[";
        for (let i = 0; i < v.length; i++) out += (i ? "\u0001" : "") + valueKey(v[i], depth + 1);
        return out + "]";
    }
    if (v instanceof Link) return `L${v.path}#${v.subpath ?? ""}|${v.display ?? ""}${v.embed ? "!" : ""}`;
    if (v instanceof CDate) return `D${v.ms}${v.hasTime ? "t" : ""}`;
    if (v instanceof CDuration) return `U${v.months}:${v.ms}`;
    if (hasHTMLElement && v instanceof HTMLElement) return "H" + String(v.outerHTML.length);
    const custom = customToString(v);
    if (custom !== null) return "O" + custom;
    let out = "{";
    for (const k in v) out += k + "=" + valueKey(v[k], depth + 1) + "\u0002";
    return out + "}";
}

/** Class instances with their own toString (e.g. file) are displayed through it, not through their keys. */
export function customToString(v: object): string | null {
    const proto: unknown = Object.getPrototypeOf(v);
    if (proto === Object.prototype || proto === null) return null;
    const toString: unknown = (v as { toString?: unknown }).toString;
    if (typeof toString !== "function" || toString === Object.prototype.toString) return null;
    const out: unknown = toString.call(v);
    return typeof out === "string" ? out : null;
}

export function isNull(v: unknown): v is null | undefined {
    return v === null || v === undefined;
}
