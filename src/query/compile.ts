/**
 * Compiles the AST into JS closures once. Each node becomes `(row) => value`,
 * with no intermediate Result objects; errors are exceptions.
 */
import { compare, equals, LinkNormalizer } from "../values/compare";
import { CDate } from "../values/date";
import { CDuration } from "../values/duration";
import { Link } from "../values/link";
import { ROW_BASE, truthy, typeOf, valueToString } from "../values/types";
import { BinOp, Expr } from "./ast";
import { QueryError } from "./errors";

export type Row = { [key: string]: any; [key: symbol]: any };
export type Compiled = (row: Row) => any;
export type FuncImpl = (ctx: EvalContext, ...args: any[]) => any;

export interface EvalContext {
    /** Row of the current page (`this`). */
    thisRow(): Row | null;
    /** Resolves a link to its page row (and records the dependency). */
    resolveLink(link: Link): Row | null;
    normalizeLink: LinkNormalizer;
    functions: Record<string, FuncImpl>;
    /** Signals that the expression depends on global data (inlinks, bookmarks). */
    markDynamic(kind: "inlinks" | "starred"): void;
}

const EMPTY_ROW: Row = Object.freeze(Object.create(null));

export function compile(e: Expr, ctx: EvalContext): Compiled {
    switch (e.t) {
        case "lit": {
            const v = e.v;
            return () => v;
        }
        case "var": {
            const name = e.name;
            if (name === "this") return () => ctx.thisRow();
            if (name === "row") return r => r;
            return r => {
                let v = r[name];
                if (v === undefined) {
                    for (let base = r[ROW_BASE]; base !== undefined && base !== null; base = base[ROW_BASE]) {
                        v = base[name];
                        if (v !== undefined) return v;
                    }
                    return null;
                }
                return v;
            };
        }
        case "not": {
            const inner = compile(e.e, ctx);
            return fold(e, ctx, r => !truthy(inner(r)));
        }
        case "neg": {
            const inner = compile(e.e, ctx);
            return fold(e, ctx, r => negate(inner(r)));
        }
        case "bin":
            return fold(e, ctx, compileBinary(e.op, compile(e.l, ctx), compile(e.r, ctx), ctx));
        case "list": {
            const items = e.items.map(i => compile(i, ctx));
            return fold(e, ctx, r => {
                const out = new Array(items.length);
                for (let i = 0; i < items.length; i++) out[i] = items[i](r);
                return out;
            });
        }
        case "obj": {
            const entries = e.entries.map(([k, v]) => [k, compile(v, ctx)] as const);
            return fold(e, ctx, r => {
                const out: Row = {};
                for (const [k, f] of entries) out[k] = f(r);
                return out;
            });
        }
        case "idx":
            return compileIndex(e.obj, e.key, ctx);
        case "call":
            return compileCall(e.fn, e.args, ctx);
        case "lambda": {
            const body = compile(e.body, ctx);
            const params = e.params;
            return r => {
                const base = r ?? EMPTY_ROW;
                return (...args: any[]) => {
                    const scope: Row = { [ROW_BASE]: base };
                    for (let i = 0; i < params.length; i++) scope[params[i]] = args[i] ?? null;
                    return body(scope);
                };
            };
        }
    }
}

/** Constant folding: if every child is a literal, evaluate once. */
function fold(e: Expr, _ctx: EvalContext, fn: Compiled): Compiled {
    if (!isConstant(e)) return fn;
    try {
        const v = fn(EMPTY_ROW);
        return () => v;
    } catch {
        return fn;
    }
}

function isConstant(e: Expr): boolean {
    switch (e.t) {
        case "lit":
            return true;
        case "not":
        case "neg":
            return isConstant(e.e);
        case "bin":
            return isConstant(e.l) && isConstant(e.r);
        case "list":
            return e.items.every(isConstant);
        case "obj":
            return e.entries.every(([, v]) => isConstant(v));
        default:
            return false;
    }
}

function compileIndex(objExpr: Expr, keyExpr: Expr, ctx: EvalContext): Compiled {
    const obj = compile(objExpr, ctx);
    if (keyExpr.t === "lit" && (typeof keyExpr.v === "string" || typeof keyExpr.v === "number")) {
        const key = keyExpr.v;
        if (key === "inlinks") ctx.markDynamic("inlinks");
        else if (key === "starred") ctx.markDynamic("starred");
        return r => getField(obj(r), key, ctx);
    }
    const keyFn = compile(keyExpr, ctx);
    return r => {
        const k = keyFn(r);
        if (k === null || k === undefined) return null;
        if (typeof k !== "string" && typeof k !== "number")
            throw new QueryError("Can only index with a string or a number");
        return getField(obj(r), k, ctx);
    };
}

const objectProto = Object.prototype as Record<string, unknown>;

/** Field access with language semantics (links resolve to pages, lists map, etc.). */
export function getField(o: any, key: string | number, ctx: EvalContext): any {
    if (o === null || o === undefined) return null;
    if (typeof o === "object") {
        if (Array.isArray(o)) {
            if (typeof key === "number") return key >= 0 && key < o.length ? o[key] ?? null : null;
            const out = new Array(o.length);
            for (let i = 0; i < o.length; i++) out[i] = getField(o[i], key, ctx);
            return out;
        }
        if (o instanceof Link) {
            const row = ctx.resolveLink(o);
            if (!row) return null;
            const v = row[key];
            return v === undefined ? null : v;
        }
        if (o instanceof CDate) return dateField(o, String(key));
        if (o instanceof CDuration) return o.as(String(key));
        const v = o[key];
        if (v === undefined) {
            const base = o[ROW_BASE];
            return base !== undefined && base !== null ? getField(base, key, ctx) : null;
        }
        if (typeof v === "function" && v === objectProto[key as string]) return null;
        return v;
    }
    if (typeof o === "string" && typeof key === "number") return key >= 0 && key < o.length ? o[key] : null;
    return null;
}

function dateField(d: CDate, key: string): any {
    switch (key) {
        case "year":
            return d.year;
        case "month":
            return d.month;
        case "day":
            return d.day;
        case "hour":
            return d.hour;
        case "minute":
            return d.minute;
        case "second":
            return d.second;
        case "millisecond":
            return d.millisecond;
        case "weekday":
            return d.weekday;
        case "week":
            return Math.floor(d.day / 7) + 1;
        case "weekyear":
            return d.weekNumber;
        case "quarter":
            return d.quarter;
        default:
            return null;
    }
}

function compileCall(fnExpr: Expr, argExprs: Expr[], ctx: EvalContext): Compiled {
    const args = argExprs.map(a => compile(a, ctx));

    if (fnExpr.t === "var") {
        const impl = ctx.functions[fnExpr.name] ?? ctx.functions[fnExpr.name.toLowerCase()];
        if (impl) {
            switch (args.length) {
                case 0:
                    return () => impl(ctx);
                case 1: {
                    const [a] = args;
                    return r => impl(ctx, a(r));
                }
                case 2: {
                    const [a, b] = args;
                    return r => impl(ctx, a(r), b(r));
                }
                case 3: {
                    const [a, b, c] = args;
                    return r => impl(ctx, a(r), b(r), c(r));
                }
                default:
                    return r => impl(ctx, ...args.map(a => a(r)));
            }
        }
    }

    const fn = compile(fnExpr, ctx);
    const name = fnExpr.t === "var" ? fnExpr.name : "expression";
    return r => {
        const f = fn(r);
        if (typeof f !== "function") {
            if (f === null && fnExpr.t === "var") throw new QueryError(`Unknown function '${name}'`);
            throw new QueryError(`Cannot call a value of type ${typeOf(f)} as a function`);
        }
        return f(...args.map(a => a(r)));
    };
}

function compileBinary(op: BinOp, l: Compiled, r: Compiled, ctx: EvalContext): Compiled {
    const norm = ctx.normalizeLink;
    switch (op) {
        case "and":
            return row => truthy(l(row)) && truthy(r(row));
        case "or":
            return row => truthy(l(row)) || truthy(r(row));
        case "=":
            return row => equals(l(row), r(row), norm);
        case "!=":
            return row => !equals(l(row), r(row), norm);
        case "<":
            return row => {
                const a = l(row);
                const b = r(row);
                return typeof a === "number" && typeof b === "number" ? a < b : compare(a, b, norm) < 0;
            };
        case "<=":
            return row => {
                const a = l(row);
                const b = r(row);
                return typeof a === "number" && typeof b === "number" ? a <= b : compare(a, b, norm) <= 0;
            };
        case ">":
            return row => {
                const a = l(row);
                const b = r(row);
                return typeof a === "number" && typeof b === "number" ? a > b : compare(a, b, norm) > 0;
            };
        case ">=":
            return row => {
                const a = l(row);
                const b = r(row);
                return typeof a === "number" && typeof b === "number" ? a >= b : compare(a, b, norm) >= 0;
            };
        case "+":
            return row => add(l(row), r(row));
        case "-":
            return row => subtract(l(row), r(row));
        case "*":
            return row => multiply(l(row), r(row));
        case "/":
            return row => divide(l(row), r(row));
        case "%":
            return row => {
                const a = l(row);
                const b = r(row);
                if (a === null || b === null) return null;
                if (typeof a === "number" && typeof b === "number") return a % b;
                throw typeError("%", a, b);
            };
    }
}

function typeError(op: string, a: unknown, b: unknown): QueryError {
    return new QueryError(`Operation '${op}' is not supported between ${typeOf(a)} and ${typeOf(b)}`);
}

export function negate(v: any): any {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") return -v;
    if (v instanceof CDuration) return v.negate();
    throw new QueryError(`Cannot negate a value of type ${typeOf(v)}`);
}

export function add(a: any, b: any): any {
    if (typeof a === "number" && typeof b === "number") return a + b;
    if (typeof a === "string" || typeof b === "string") {
        if (a === null || a === undefined) return b;
        if (b === null || b === undefined) return a;
        return valueToString(a) + valueToString(b);
    }
    if (a === null || a === undefined || b === null || b === undefined) return null;
    if (a instanceof CDate && b instanceof CDuration) return a.plus(b);
    if (a instanceof CDuration && b instanceof CDate) return b.plus(a);
    if (a instanceof CDuration && b instanceof CDuration) return a.plus(b);
    if (Array.isArray(a) && Array.isArray(b)) return a.concat(b);
    if (typeOf(a) === "object" && typeOf(b) === "object") return Object.assign({}, a, b);
    throw typeError("+", a, b);
}

export function subtract(a: any, b: any): any {
    if (typeof a === "number" && typeof b === "number") return a - b;
    if (a === null || a === undefined || b === null || b === undefined) return null;
    if (a instanceof CDate && b instanceof CDate) return a.diff(b);
    if (a instanceof CDate && b instanceof CDuration) return a.minus(b);
    if (a instanceof CDuration && b instanceof CDuration) return a.minus(b);
    throw typeError("-", a, b);
}

export function multiply(a: any, b: any): any {
    if (typeof a === "number" && typeof b === "number") return a * b;
    if (a === null || a === undefined || b === null || b === undefined) return null;
    if (a instanceof CDuration && typeof b === "number") return a.times(b);
    if (typeof a === "number" && b instanceof CDuration) return b.times(a);
    if (typeof a === "string" && typeof b === "number") return a.repeat(Math.max(0, b));
    throw typeError("*", a, b);
}

export function divide(a: any, b: any): any {
    if (a === null || a === undefined || b === null || b === undefined) return null;
    if (typeof a === "number" && typeof b === "number") {
        if (b === 0) throw new QueryError("Division by zero");
        return a / b;
    }
    if (a instanceof CDuration && typeof b === "number") {
        if (b === 0) throw new QueryError("Division by zero");
        return a.times(1 / b);
    }
    throw typeError("/", a, b);
}
