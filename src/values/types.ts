/** Value types and basic helpers (no Obsidian dependency). */
import { CDate } from "./date";
import { CDuration } from "./duration";
import { Link } from "./link";

export type Literal =
    | null
    | boolean
    | number
    | string
    | CDate
    | CDuration
    | Link
    | Literal[]
    | { [key: string]: Literal }
    | ((...args: any[]) => any)
    | object;

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

export interface ListPairWidget {
    $widget: "listpair";
    key: Literal;
    value: Literal;
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
    if (Array.isArray(v)) return "array";
    if (v instanceof Link) return "link";
    if (v instanceof CDate) return "date";
    if (v instanceof CDuration) return "duration";
    if (hasHTMLElement && v instanceof HTMLElement) return "html";
    if (typeof (v as any).$widget === "string") return "widget";
    return "object";
}

export function isWidget(v: unknown): v is Widget {
    return !!v && typeof v === "object" && typeof (v as any).$widget === "string";
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
    if (Array.isArray(v)) return v.length > 0;
    if (v instanceof CDate || v instanceof CDuration || v instanceof Link) return true;
    if (hasHTMLElement && v instanceof HTMLElement) return true;
    for (const _ in v as object) return true;
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
            return String(v);
        case "function":
            return "<function>";
    }
    if (depth > 6) return "...";
    if (Array.isArray(v)) return v.map(x => valueToString(x, depth + 1)).join(", ");
    if (v instanceof CDate) return formatDate(v);
    if (v instanceof CDuration) return v.toHuman();
    if (v instanceof Link) return v.markdown();
    if (hasHTMLElement && v instanceof HTMLElement) return v.outerHTML;
    if (isWidget(v)) {
        if (v.$widget === "listpair") return `${valueToString(v.key, depth + 1)}: ${valueToString(v.value, depth + 1)}`;
        return v.display ?? v.url;
    }
    if (hasCustomToString(v)) return String(v);
    const entries = Object.entries(v as object);
    return "{ " + entries.map(([k, x]) => `${k}: ${valueToString(x, depth + 1)}`).join(", ") + " }";
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
            return "#" + v;
        case "boolean":
            return v ? "T" : "F";
        case "function":
            return "f";
    }
    if (depth > 8) return "…";
    if (Array.isArray(v)) {
        let out = "[";
        for (let i = 0; i < v.length; i++) out += (i ? "" : "") + valueKey(v[i], depth + 1);
        return out + "]";
    }
    if (v instanceof Link) return `L${v.path}#${v.subpath ?? ""}|${v.display ?? ""}${v.embed ? "!" : ""}`;
    if (v instanceof CDate) return `D${v.ms}${v.hasTime ? "t" : ""}`;
    if (v instanceof CDuration) return `U${v.months}:${v.ms}`;
    if (hasHTMLElement && v instanceof HTMLElement) return "H" + v.outerHTML.length;
    if (hasCustomToString(v)) return "O" + String(v);
    let out = "{";
    for (const k in v as any) out += k + "=" + valueKey((v as any)[k], depth + 1) + "";
    return out + "}";
}

/** Class instances with their own toString (e.g. file) are displayed through it, not through their keys. */
export function hasCustomToString(v: object): boolean {
    const proto = Object.getPrototypeOf(v);
    return (
        proto !== Object.prototype &&
        proto !== null &&
        typeof (v as any).toString === "function" &&
        (v as any).toString !== Object.prototype.toString
    );
}

export function isNull(v: unknown): v is null | undefined {
    return v === null || v === undefined;
}
