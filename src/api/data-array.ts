/**
 * Array with query helpers. It is a real Array subclass (no Proxy), so indexing,
 * length and iteration have native cost.
 */
import { compare } from "../values/compare";
import { isArray, isRecord, valueKey, valueToString } from "../values/types";

type Pred<T> = (value: T, index: number, array: T[]) => unknown;
type KeyFn<T, U> = (value: T) => U;

export interface Grouping<K, T> {
    key: K;
    rows: DataArray<T>;
}

export class DataArray<T = unknown> extends Array<T> {
    // "Swizzled" fields, defined as prototype getters below: `pages.file.name`, `page.file.tasks.text`...
    declare readonly file: DataArray;
    declare readonly name: DataArray;
    declare readonly path: DataArray;
    declare readonly link: DataArray;
    declare readonly folder: DataArray;
    declare readonly tasks: DataArray;
    declare readonly lists: DataArray;
    declare readonly tags: DataArray;
    declare readonly etags: DataArray;
    declare readonly outlinks: DataArray;
    declare readonly inlinks: DataArray;
    declare readonly aliases: DataArray;
    declare readonly text: DataArray;
    declare readonly status: DataArray;
    declare readonly checked: DataArray;
    declare readonly completed: DataArray;
    declare readonly fullyCompleted: DataArray;
    declare readonly children: DataArray;
    declare readonly rows: DataArray;
    declare readonly key: DataArray;
    declare readonly ctime: DataArray;
    declare readonly mtime: DataArray;
    declare readonly day: DataArray;
    declare readonly size: DataArray;
    declare readonly frontmatter: DataArray;
    declare readonly section: DataArray;
    declare readonly due: DataArray;

    /** Wraps an iterable; returns the same instance if it already is a DataArray. */
    static wrap<T>(values: Iterable<T> | ArrayLike<T> | null | undefined): DataArray<T> {
        if (values instanceof DataArray) return values as DataArray<T>;
        const out = new DataArray<T>();
        if (values === null || values === undefined) return out;
        if (Array.isArray(values)) {
            for (const v of values as T[]) out.push(v);
            return out;
        }
        for (const v of Array.from(values)) out.push(v);
        return out;
    }

    static isDataArray(v: unknown): v is DataArray {
        return v instanceof DataArray;
    }

    map<U>(fn: (value: T, index: number, array: T[]) => U, thisArg?: unknown): DataArray<U> {
        return super.map(fn, thisArg) as DataArray<U>;
    }

    where(pred: Pred<T>): DataArray<T> {
        const out = new DataArray<T>();
        for (let i = 0; i < this.length; i++) if (pred(this[i], i, this)) out.push(this[i]);
        return out;
    }

    mutate(fn: (value: T, index: number) => void): this {
        for (let i = 0; i < this.length; i++) fn(this[i], i);
        return this;
    }

    limit(count: number): DataArray<T> {
        const out = new DataArray<T>();
        for (let i = 0; i < Math.min(count, this.length); i++) out.push(this[i]);
        return out;
    }

    first(): T | undefined {
        return this[0];
    }

    last(): T | undefined {
        return this[this.length - 1];
    }

    none(pred: Pred<T>): boolean {
        return !this.some(pred);
    }

    /**
     * `sort(key, "asc"|"desc", comparator?)` returns a new sorted array (Dataview style).
     * `sort((a, b) => ...)` with two parameters keeps the native (in-place) behavior.
     */
    // @ts-ignore extended signature compared to Array.prototype.sort
    sort<U>(key?: (value: T) => U, direction?: "asc" | "desc", comparator?: (a: U, b: U) => number): DataArray<T>;
    // @ts-ignore
    sort(compareFn: (a: T, b: T) => number): this;
    // @ts-ignore
    sort(
        key?: ((value: T) => unknown) | ((a: T, b: T) => number),
        direction?: "asc" | "desc",
        comparator?: (a: unknown, b: unknown) => number
    ): DataArray<T> {
        if (typeof key === "function" && key.length >= 2 && direction === undefined) {
            super.sort(key as (a: T, b: T) => number);
            return this;
        }
        const keyFn = typeof key === "function" ? (key as (value: T) => unknown) : (v: T): unknown => v;
        const cmp = comparator ?? ((a: unknown, b: unknown) => compare(a, b));
        const sign = direction === "desc" ? -1 : 1;
        const keys = new Array<unknown>(this.length);
        const idx = new Array<number>(this.length);
        for (let i = 0; i < this.length; i++) {
            keys[i] = keyFn(this[i]);
            idx[i] = i;
        }
        idx.sort((a, b) => sign * cmp(keys[a], keys[b]) || a - b);
        const out = new DataArray<T>();
        for (const i of idx) out.push(this[i]);
        return out;
    }

    sortBy(key: KeyFn<T, unknown>, direction?: "asc" | "desc"): DataArray<T> {
        return this.sort(key, direction);
    }

    groupBy<K>(key: KeyFn<T, K>, comparator?: (a: K, b: K) => number): DataArray<Grouping<K, T>> {
        const groups = new Map<string, Grouping<K, T>>();
        for (let i = 0; i < this.length; i++) {
            const k = key(this[i]);
            const hash = valueKey(k);
            let g = groups.get(hash);
            if (!g) groups.set(hash, (g = { key: k, rows: new DataArray<T>() }));
            g.rows.push(this[i]);
        }
        const cmp = comparator ?? ((a: K, b: K) => compare(a, b));
        return DataArray.wrap([...groups.values()].sort((a, b) => cmp(a.key, b.key)));
    }

    distinct<U>(key?: KeyFn<T, U>): DataArray<T> {
        const seen = new Set<string>();
        const out = new DataArray<T>();
        for (let i = 0; i < this.length; i++) {
            const hash = key ? valueKey(key(this[i])) : valueKey(this[i]);
            if (!seen.has(hash)) {
                seen.add(hash);
                out.push(this[i]);
            }
        }
        return out;
    }

    /** Extracts a field from every element, flattening lists (like `pages.file.name` in Dataview). */
    to(field: string): DataArray {
        const out = new DataArray();
        for (let i = 0; i < this.length; i++) {
            const el: unknown = this[i];
            if (!isRecord(el)) continue;
            const v = el[field];
            if (v === undefined) continue;
            if (isArray(v)) for (const x of v) out.push(x);
            else out.push(v);
        }
        return out;
    }

    /** Like `to`, without flattening. */
    into(field: string): DataArray {
        const out = new DataArray();
        for (let i = 0; i < this.length; i++) {
            const el: unknown = this[i];
            if (isRecord(el) && el[field] !== undefined) out.push(el[field]);
        }
        return out;
    }

    /** Dotted path: `pluck("file.name")`. */
    pluck(path: string): DataArray {
        let cur: DataArray = DataArray.wrap<unknown>(Array.from(this));
        for (const part of path.split(".")) cur = cur.to(part);
        return cur;
    }

    /** Recursively flattens a tree (e.g. tasks and subtasks through "children"). */
    expand(field: string): DataArray {
        const out = new DataArray();
        const stack: unknown[] = Array.from<unknown>(this).reverse();
        const seen = new Set<unknown>();
        while (stack.length) {
            const el = stack.pop();
            if (!isRecord(el) || seen.has(el)) continue;
            seen.add(el);
            out.push(el);
            const children = el[field];
            if (isArray(children)) for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
        }
        return out;
    }

    sum(): number {
        let acc = 0;
        for (let i = 0; i < this.length; i++) {
            const v: unknown = this[i];
            if (typeof v === "number") acc += v;
        }
        return acc;
    }

    avg(): number {
        let acc = 0;
        let n = 0;
        for (let i = 0; i < this.length; i++) {
            const v: unknown = this[i];
            if (typeof v === "number") {
                acc += v;
                n++;
            }
        }
        return n ? acc / n : NaN;
    }

    min(): T | undefined {
        let best: T | undefined;
        for (let i = 0; i < this.length; i++) if (best === undefined || compare(this[i], best) < 0) best = this[i];
        return best;
    }

    max(): T | undefined {
        let best: T | undefined;
        for (let i = 0; i < this.length; i++) if (best === undefined || compare(this[i], best) > 0) best = this[i];
        return best;
    }

    join(separator = ", "): string {
        let out = "";
        for (let i = 0; i < this.length; i++) out += (i ? separator : "") + valueToString(this[i]);
        return out;
    }

    /** Plain JS array. */
    array(): T[] {
        return Array.from(this);
    }
}

// `.values` returns the raw array (Dataview compatibility). Iteration uses Symbol.iterator, so it is unaffected.
Object.defineProperty(DataArray.prototype, "values", {
    get(this: DataArray): unknown[] {
        return Array.from(this);
    },
    configurable: true,
});

const SWIZZLED = [
    "file",
    "name",
    "path",
    "link",
    "folder",
    "tasks",
    "lists",
    "tags",
    "etags",
    "outlinks",
    "inlinks",
    "aliases",
    "text",
    "status",
    "checked",
    "completed",
    "fullyCompleted",
    "children",
    "rows",
    "key",
    "ctime",
    "mtime",
    "day",
    "size",
    "frontmatter",
    "section",
    "due",
];
for (const field of SWIZZLED) {
    Object.defineProperty(DataArray.prototype, field, {
        get(this: DataArray): DataArray {
            return this.to(field);
        },
        configurable: true,
    });
}
