/**
 * Array with query helpers. It is a real Array subclass (no Proxy), so indexing,
 * length and iteration have native cost.
 */
import { compare } from "../values/compare";
import { valueKey, valueToString } from "../values/types";

type Pred<T> = (value: T, index: number, array: T[]) => unknown;
type KeyFn<T, U> = (value: T) => U;

export interface Grouping<K, T> {
    key: K;
    rows: DataArray<T>;
}

export class DataArray<T = any> extends Array<T> {
    [prop: string]: any;

    /** Wraps an iterable; returns the same instance if it already is a DataArray. */
    static wrap<T>(values: Iterable<T> | ArrayLike<T> | null | undefined): DataArray<T> {
        if (values instanceof DataArray) return values;
        const out = new DataArray<T>();
        if (values === null || values === undefined) return out;
        if (Array.isArray(values)) {
            for (let i = 0; i < values.length; i++) out.push(values[i]);
            return out;
        }
        for (const v of values as Iterable<T>) out.push(v);
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
        return DataArray.wrap(Array.prototype.slice.call(this, 0, count) as T[]);
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
    sort(key?: any, direction?: "asc" | "desc", comparator?: (a: any, b: any) => number): DataArray<T> {
        if (typeof key === "function" && key.length >= 2 && direction === undefined) {
            return super.sort(key) as DataArray<T>;
        }
        const keyFn: KeyFn<T, unknown> = typeof key === "function" ? key : (v: T) => v;
        const cmp = comparator ?? ((a: unknown, b: unknown) => compare(a, b));
        const sign = direction === "desc" ? -1 : 1;
        const keys = new Array(this.length);
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
            const hash = valueKey(key ? key(this[i]) : this[i]);
            if (!seen.has(hash)) {
                seen.add(hash);
                out.push(this[i]);
            }
        }
        return out;
    }

    /** Extracts a field from every element, flattening lists (like `pages.file.name` in Dataview). */
    to(field: string): DataArray<any> {
        const out = new DataArray<any>();
        for (let i = 0; i < this.length; i++) {
            const el: any = this[i];
            if (el === null || el === undefined) continue;
            const v = el[field];
            if (v === undefined) continue;
            if (Array.isArray(v)) for (const x of v) out.push(x);
            else out.push(v);
        }
        return out;
    }

    /** Like `to`, without flattening. */
    into(field: string): DataArray<any> {
        const out = new DataArray<any>();
        for (let i = 0; i < this.length; i++) {
            const el: any = this[i];
            if (el !== null && el !== undefined && el[field] !== undefined) out.push(el[field]);
        }
        return out;
    }

    /** Dotted path: `pluck("file.name")`. */
    pluck(path: string): DataArray<any> {
        let cur: DataArray<any> = this;
        for (const part of path.split(".")) cur = cur.to(part);
        return cur;
    }

    /** Recursively flattens a tree (e.g. tasks and subtasks through "children"). */
    expand(field: string): DataArray<any> {
        const out = new DataArray<any>();
        const stack: any[] = Array.from(this).reverse();
        const seen = new Set<any>();
        while (stack.length) {
            const el = stack.pop();
            if (el === null || el === undefined || seen.has(el)) continue;
            seen.add(el);
            out.push(el);
            const children = el[field];
            if (Array.isArray(children)) for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
        }
        return out;
    }

    sum(): number {
        let acc = 0;
        for (let i = 0; i < this.length; i++) {
            const v: any = this[i];
            if (typeof v === "number") acc += v;
        }
        return acc;
    }

    avg(): number {
        let acc = 0;
        let n = 0;
        for (let i = 0; i < this.length; i++) {
            const v: any = this[i];
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
    get(this: DataArray) {
        return Array.from(this);
    },
    configurable: true,
});

// "Swizzled" access to the most common fields: pages.file.name, page.file.tasks.text, groups.key...
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
        get(this: DataArray) {
            return this.to(field);
        },
        configurable: true,
    });
}
