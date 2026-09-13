/** Single typed comparator — no Result allocation per comparison. */
import { CDate } from "./date";
import { CDuration } from "./duration";
import { Link } from "./link";
import { typeOf, LType } from "./types";

const TYPE_RANK: Record<LType, number> = {
    null: 0,
    boolean: 1,
    number: 2,
    string: 3,
    date: 4,
    duration: 5,
    link: 6,
    array: 7,
    object: 8,
    widget: 9,
    function: 10,
    html: 11,
};

let collator = new Intl.Collator(undefined, { sensitivity: "variant" });

export function setCollatorLocale(locale: string): void {
    try {
        collator = new Intl.Collator(locale, { sensitivity: "variant" });
    } catch {
        // keep the previous collator
    }
}

export type LinkNormalizer = (path: string) => string;

/** Compares any two values; returns <0, 0 or >0. */
export function compare(a: unknown, b: unknown, normalize?: LinkNormalizer, depth = 0): number {
    if (a === b) return 0;
    const ta = typeof a;
    // Fast paths for the most common cases in SORT/WHERE.
    if (ta === "number" && typeof b === "number") return (a as number) < b ? -1 : (a as number) > b ? 1 : 0;
    if (ta === "string" && typeof b === "string") return collator.compare(a as string, b);

    if (a === undefined) a = null;
    if (b === undefined) b = null;
    const typeA = typeOf(a);
    const typeB = typeOf(b);
    if (typeA !== typeB) return TYPE_RANK[typeA] - TYPE_RANK[typeB];

    switch (typeA) {
        case "null":
            return 0;
        case "boolean":
            return a === b ? 0 : a ? 1 : -1;
        case "number":
            // NaN
            return 0;
        case "date":
            return (a as CDate).ms - (b as CDate).ms;
        case "duration":
            return (a as CDuration).approxMs() - (b as CDuration).approxMs();
        case "link": {
            const la = a as Link;
            const lb = b as Link;
            const pa = normalize ? normalize(la.path) : la.path;
            const pb = normalize ? normalize(lb.path) : lb.path;
            const c = collator.compare(pa, pb);
            if (c !== 0) return c;
            if (la.type !== lb.type) return la.type < lb.type ? -1 : 1;
            return collator.compare(la.subpath ?? "", lb.subpath ?? "");
        }
        case "array": {
            const aa = a as unknown[];
            const ab = b as unknown[];
            if (depth > 16) return 0;
            const n = Math.min(aa.length, ab.length);
            for (let i = 0; i < n; i++) {
                const c = compare(aa[i], ab[i], normalize, depth + 1);
                if (c !== 0) return c;
            }
            return aa.length - ab.length;
        }
        case "object":
        case "widget": {
            if (depth > 16) return 0;
            const ka = Object.keys(a as object);
            const kb = Object.keys(b as object);
            if (ka.length !== kb.length) return ka.length - kb.length;
            ka.sort();
            kb.sort();
            for (let i = 0; i < ka.length; i++) {
                if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
                const c = compare((a as any)[ka[i]], (b as any)[kb[i]], normalize, depth + 1);
                if (c !== 0) return c;
            }
            return 0;
        }
        default:
            return 0;
    }
}

export function equals(a: unknown, b: unknown, normalize?: LinkNormalizer): boolean {
    if (a === b) return true;
    const ta = typeof a;
    if (ta === "number" || ta === "string" || ta === "boolean") return false;
    return compare(a, b, normalize) === 0;
}
