/** Hand-written lexer + recursive descent parser (no Parsimmon). */
import { parseDateKeyword, parseISODate } from "../values/date";
import { parseDuration } from "../values/duration";
import { Link } from "../values/link";
import { BinOp, Expr, Header, NamedExpr, Op, Query, Source } from "./ast";
import { describePosition, QueryError } from "./errors";

type TokKind = "num" | "str" | "id" | "link" | "tag" | "op" | "eof";

interface Token {
    k: TokKind;
    v: string;
    pos: number;
    end: number;
    embed?: boolean;
}

const WS = /\s+/y;
const NUM = /\d+(?:\.\d+)?/y;
const IDENT = /[\p{L}\p{Emoji_Presentation}_][\p{L}\p{Emoji_Presentation}\p{N}_-]*/uy;
const TAG = /#[^\s,()"'&|!#[\]]+/uy;
const TWO_CHAR_OPS = new Set(["=>", "!=", "<=", ">="]);
const ONE_CHAR_OPS = new Set("&|!=<>+-*/%()[]{},.:".split(""));

class Lexer {
    pos = 0;
    lastEnd = 0;
    private peeked: Token | null = null;

    constructor(readonly src: string) {}

    peek(): Token {
        return this.peeked ?? (this.peeked = this.lex());
    }

    next(): Token {
        const t = this.peek();
        this.peeked = null;
        this.lastEnd = t.end;
        return t;
    }

    /** Rewinds to a saved position (used for lambda lookahead). */
    reset(pos: number): void {
        this.pos = pos;
        this.peeked = null;
    }

    /** Start position of the next token (without consuming it). */
    mark(): number {
        return this.peek().pos;
    }

    private lex(): Token {
        const src = this.src;
        WS.lastIndex = this.pos;
        if (WS.exec(src)) this.pos = WS.lastIndex;
        const start = this.pos;
        if (start >= src.length) return { k: "eof", v: "", pos: start, end: start };

        const c = src.charCodeAt(start);

        // Numbers
        if (c >= 48 && c <= 57) {
            NUM.lastIndex = start;
            NUM.exec(src);
            this.pos = NUM.lastIndex;
            return { k: "num", v: src.slice(start, this.pos), pos: start, end: this.pos };
        }

        // Strings
        if (c === 34 || c === 39) {
            let out = "";
            let i = start + 1;
            while (i < src.length) {
                const ch = src.charCodeAt(i);
                if (ch === c) break;
                if (ch === 92 && i + 1 < src.length) {
                    const esc = src[i + 1];
                    out += esc === "n" ? "\n" : esc === "t" ? "\t" : esc;
                    i += 2;
                    continue;
                }
                out += src[i];
                i++;
            }
            if (i >= src.length) throw this.error("unterminated string", start);
            this.pos = i + 1;
            return { k: "str", v: out, pos: start, end: this.pos };
        }

        // Links [[...]] and ![[...]]
        const embed = c === 33 && src.startsWith("[[", start + 1);
        if ((c === 91 && src.charCodeAt(start + 1) === 91) || embed) {
            const open = embed ? start + 1 : start;
            const close = src.indexOf("]]", open + 2);
            if (close < 0) throw this.error("unterminated link, missing ']]'", start);
            this.pos = close + 2;
            return { k: "link", v: src.slice(open + 2, close), pos: start, end: this.pos, embed };
        }

        // Tags
        if (c === 35) {
            TAG.lastIndex = start;
            if (TAG.exec(src)) {
                this.pos = TAG.lastIndex;
                return { k: "tag", v: src.slice(start, this.pos), pos: start, end: this.pos };
            }
        }

        // Identifiers
        IDENT.lastIndex = start;
        if (IDENT.exec(src)) {
            this.pos = IDENT.lastIndex;
            return { k: "id", v: src.slice(start, this.pos), pos: start, end: this.pos };
        }

        const two = src.slice(start, start + 2);
        if (TWO_CHAR_OPS.has(two)) {
            this.pos = start + 2;
            return { k: "op", v: two, pos: start, end: this.pos };
        }
        if (ONE_CHAR_OPS.has(src[start])) {
            this.pos = start + 1;
            return { k: "op", v: src[start], pos: start, end: this.pos };
        }
        throw this.error(`unexpected character '${src[start]}'`, start);
    }

    error(message: string, pos: number): QueryError {
        return new QueryError(`Syntax error (${describePosition(this.src, pos)}): ${message}`, pos);
    }
}

const COMMANDS = new Set(["from", "where", "sort", "group", "flatten", "limit"]);
const COMPARE_OPS = new Set(["=", "!=", "<", "<=", ">", ">="]);

function describe(t: Token): string {
    if (t.k === "eof") return "end of query";
    if (t.k === "str") return `"${t.v}"`;
    return `'${t.v}'`;
}

class Parser {
    constructor(readonly lx: Lexer) {}

    // ---------- helpers ----------

    isKw(t: Token, kw: string): boolean {
        return t.k === "id" && t.v.length === kw.length && t.v.toLowerCase() === kw;
    }

    isOp(t: Token, op: string): boolean {
        return t.k === "op" && t.v === op;
    }

    expectOp(op: string): Token {
        const t = this.lx.next();
        if (!this.isOp(t, op)) throw this.lx.error(`expected '${op}', found ${describe(t)}`, t.pos);
        return t;
    }

    expectKw(kw: string): void {
        const t = this.lx.next();
        if (!this.isKw(t, kw)) throw this.lx.error(`expected '${kw.toUpperCase()}', found ${describe(t)}`, t.pos);
    }

    atCommandStart(): boolean {
        const t = this.lx.peek();
        return t.k === "eof" || (t.k === "id" && COMMANDS.has(t.v.toLowerCase()));
    }

    expectEof(): void {
        const t = this.lx.peek();
        if (t.k !== "eof") throw this.lx.error(`unexpected token ${describe(t)}`, t.pos);
    }

    // ---------- query ----------

    query(): Query {
        const header = this.header();
        let source: Source = { t: "all" };
        if (this.isKw(this.lx.peek(), "from")) {
            this.lx.next();
            source = this.source();
        }

        const ops: Op[] = [];
        for (;;) {
            const t = this.lx.peek();
            if (t.k === "eof") break;
            if (t.k !== "id") throw this.lx.error(`expected a command, found ${describe(t)}`, t.pos);
            const kw = t.v.toLowerCase();
            this.lx.next();
            switch (kw) {
                case "where":
                    ops.push({ t: "where", e: this.expr() });
                    break;
                case "sort": {
                    const keys: { e: Expr; dir: 1 | -1 }[] = [];
                    do {
                        const e = this.expr();
                        let dir: 1 | -1 = 1;
                        const d = this.lx.peek();
                        if (this.isKw(d, "asc") || this.isKw(d, "ascending")) this.lx.next();
                        else if (this.isKw(d, "desc") || this.isKw(d, "descending")) {
                            this.lx.next();
                            dir = -1;
                        }
                        keys.push({ e, dir });
                    } while (this.isOp(this.lx.peek(), ",") && this.lx.next());
                    ops.push({ t: "sort", keys });
                    break;
                }
                case "group": {
                    this.expectKw("by");
                    const named = this.namedExpr();
                    ops.push({ t: "group", e: named.expr, name: named.name });
                    break;
                }
                case "flatten": {
                    const named = this.namedExpr();
                    ops.push({ t: "flatten", e: named.expr, name: named.name });
                    break;
                }
                case "limit":
                    ops.push({ t: "limit", e: this.expr() });
                    break;
                case "from":
                    throw this.lx.error("FROM must come right after TABLE/LIST/TASK", t.pos);
                default:
                    throw this.lx.error(`unknown command '${t.v}'`, t.pos);
            }
        }
        return { header, source, ops };
    }

    header(): Header {
        const t = this.lx.next();
        const kw = t.k === "id" ? t.v.toLowerCase() : "";
        if (kw === "table" || kw === "list") {
            let withoutId = false;
            if (this.isKw(this.lx.peek(), "without")) {
                this.lx.next();
                this.expectKw("id");
                withoutId = true;
            }
            if (kw === "list") {
                return { t: "list", withoutId, expr: this.atCommandStart() ? null : this.expr() };
            }
            const cols: NamedExpr[] = [];
            if (!this.atCommandStart()) {
                do cols.push(this.namedExpr());
                while (this.isOp(this.lx.peek(), ",") && this.lx.next());
            }
            return { t: "table", withoutId, cols };
        }
        if (kw === "task") return { t: "task" };
        throw this.lx.error(`a query must start with TABLE, LIST or TASK (found ${describe(t)})`, t.pos);
    }

    namedExpr(): NamedExpr {
        const start = this.lx.mark();
        const expr = this.expr();
        let name = this.lx.src.slice(start, this.lx.lastEnd).trim();
        if (this.isKw(this.lx.peek(), "as")) {
            this.lx.next();
            const n = this.lx.next();
            if (n.k !== "str" && n.k !== "id") throw this.lx.error("expected a name after AS", n.pos);
            name = n.v;
        }
        return { expr, name };
    }

    // ---------- sources (FROM) ----------

    source(): Source {
        let left = this.sourceAnd();
        for (;;) {
            const t = this.lx.peek();
            if (this.isKw(t, "or") || this.isOp(t, "|")) {
                this.lx.next();
                left = { t: "or", l: left, r: this.sourceAnd() };
            } else return left;
        }
    }

    sourceAnd(): Source {
        let left = this.sourceUnary();
        for (;;) {
            const t = this.lx.peek();
            if (this.isKw(t, "and") || this.isOp(t, "&")) {
                this.lx.next();
                left = { t: "and", l: left, r: this.sourceUnary() };
            } else return left;
        }
    }

    sourceUnary(): Source {
        const t = this.lx.peek();
        if (this.isOp(t, "-") || this.isOp(t, "!")) {
            this.lx.next();
            return { t: "not", s: this.sourceUnary() };
        }
        return this.sourcePrimary();
    }

    sourcePrimary(): Source {
        const t = this.lx.next();
        switch (t.k) {
            case "tag":
                return { t: "tag", tag: t.v };
            case "str":
                return { t: "folder", path: t.v };
            case "link":
                return { t: "link", target: Link.parseInner(t.v).path, dir: "in" };
            case "op":
                if (t.v === "(") {
                    const s = this.source();
                    this.expectOp(")");
                    return s;
                }
                break;
            case "id": {
                const kw = t.v.toLowerCase();
                if (kw === "outgoing" || kw === "incoming") {
                    this.expectOp("(");
                    const l = this.lx.next();
                    if (l.k !== "link") throw this.lx.error(`${kw}() expects a link [[...]]`, l.pos);
                    this.expectOp(")");
                    return { t: "link", target: Link.parseInner(l.v).path, dir: kw === "outgoing" ? "out" : "in" };
                }
                if (kw === "csv") {
                    this.expectOp("(");
                    const p = this.lx.next();
                    if (p.k !== "str") throw this.lx.error("csv() expects a quoted path", p.pos);
                    this.expectOp(")");
                    return { t: "csv", path: p.v };
                }
                break;
            }
        }
        throw this.lx.error(`invalid source ${describe(t)} (use #tag, "folder", [[link]], outgoing([[link]]) or csv("file"))`, t.pos);
    }

    // ---------- expressions ----------

    expr(): Expr {
        return this.or();
    }

    or(): Expr {
        let left = this.and();
        for (;;) {
            const t = this.lx.peek();
            if (this.isKw(t, "or") || this.isOp(t, "|")) {
                this.lx.next();
                left = { t: "bin", op: "or", l: left, r: this.and() };
            } else return left;
        }
    }

    and(): Expr {
        let left = this.cmp();
        for (;;) {
            const t = this.lx.peek();
            if (this.isKw(t, "and") || this.isOp(t, "&")) {
                this.lx.next();
                left = { t: "bin", op: "and", l: left, r: this.cmp() };
            } else return left;
        }
    }

    cmp(): Expr {
        let left = this.add();
        for (;;) {
            const t = this.lx.peek();
            if (t.k === "op" && COMPARE_OPS.has(t.v)) {
                this.lx.next();
                left = { t: "bin", op: t.v as BinOp, l: left, r: this.add() };
            } else return left;
        }
    }

    add(): Expr {
        let left = this.mul();
        for (;;) {
            const t = this.lx.peek();
            if (this.isOp(t, "+") || this.isOp(t, "-")) {
                this.lx.next();
                left = { t: "bin", op: t.v as BinOp, l: left, r: this.mul() };
            } else return left;
        }
    }

    mul(): Expr {
        let left = this.unary();
        for (;;) {
            const t = this.lx.peek();
            if (this.isOp(t, "*") || this.isOp(t, "/") || this.isOp(t, "%")) {
                this.lx.next();
                left = { t: "bin", op: t.v as BinOp, l: left, r: this.unary() };
            } else return left;
        }
    }

    unary(): Expr {
        const t = this.lx.peek();
        if (this.isOp(t, "!")) {
            this.lx.next();
            return { t: "not", e: this.unary() };
        }
        if (this.isOp(t, "-")) {
            this.lx.next();
            const inner = this.unary();
            if (inner.t === "lit" && typeof inner.v === "number") return { t: "lit", v: -inner.v };
            return { t: "neg", e: inner };
        }
        return this.postfix();
    }

    postfix(): Expr {
        let e = this.primary();
        for (;;) {
            const t = this.lx.peek();
            if (this.isOp(t, ".")) {
                this.lx.next();
                const name = this.lx.next();
                if (name.k !== "id" && name.k !== "num")
                    throw this.lx.error(`expected a field name after '.', found ${describe(name)}`, name.pos);
                e = { t: "idx", obj: e, key: { t: "lit", v: name.v } };
            } else if (this.isOp(t, "[")) {
                this.lx.next();
                const key = this.expr();
                this.expectOp("]");
                e = { t: "idx", obj: e, key };
            } else if (this.isOp(t, "(")) {
                const special = e.t === "var" ? this.rawLiteralCall(e.name, t) : null;
                if (special) {
                    e = special;
                    continue;
                }
                this.lx.next();
                const args: Expr[] = [];
                if (!this.isOp(this.lx.peek(), ")")) {
                    do args.push(this.expr());
                    while (this.isOp(this.lx.peek(), ",") && this.lx.next());
                }
                this.expectOp(")");
                e = { t: "call", fn: e, args };
            } else return e;
        }
    }

    /** `date(today)`, `date(2024-01-01)` and `dur(1 day)` accept unquoted arguments. */
    rawLiteralCall(name: string, open: Token): Expr | null {
        const lower = name.toLowerCase();
        if (lower !== "date" && lower !== "dur") return null;
        const src = this.lx.src;
        const close = src.indexOf(")", open.end);
        if (close < 0) return null;
        const inner = src.slice(open.end, close);
        if (inner.includes("(") || inner.includes('"') || inner.includes("'")) return null;

        const value = lower === "date" ? parseDateKeyword(inner) ?? parseISODate(inner.trim()) : parseDuration(inner);
        if (!value) return null;
        this.lx.reset(close + 1);
        this.lx.lastEnd = close + 1;
        // Relative dates (today/now) must be recomputed on every run.
        if (lower === "date" && parseISODate(inner.trim()) === null) {
            return { t: "call", fn: { t: "var", name: "date" }, args: [{ t: "lit", v: inner.trim() }] };
        }
        return { t: "lit", v: value };
    }

    primary(): Expr {
        const t = this.lx.peek();
        switch (t.k) {
            case "num":
                this.lx.next();
                return { t: "lit", v: Number(t.v) };
            case "str":
                this.lx.next();
                return { t: "lit", v: t.v };
            case "link":
                this.lx.next();
                return { t: "lit", v: Link.parseInner(t.v, t.embed) };
            case "id": {
                this.lx.next();
                const lower = t.v.toLowerCase();
                if (lower === "true") return { t: "lit", v: true };
                if (lower === "false") return { t: "lit", v: false };
                if (lower === "null") return { t: "lit", v: null };
                // Single-parameter lambda without parentheses: x => expr
                if (this.isOp(this.lx.peek(), "=>")) {
                    this.lx.next();
                    return { t: "lambda", params: [t.v], body: this.expr() };
                }
                return { t: "var", name: t.v };
            }
            case "op":
                if (t.v === "(") return this.parenOrLambda();
                if (t.v === "[") {
                    this.lx.next();
                    const items: Expr[] = [];
                    if (!this.isOp(this.lx.peek(), "]")) {
                        do items.push(this.expr());
                        while (this.isOp(this.lx.peek(), ",") && this.lx.next());
                    }
                    this.expectOp("]");
                    return { t: "list", items };
                }
                if (t.v === "{") {
                    this.lx.next();
                    const entries: [string, Expr][] = [];
                    if (!this.isOp(this.lx.peek(), "}")) {
                        do {
                            const k = this.lx.next();
                            if (k.k !== "id" && k.k !== "str") throw this.lx.error("expected a key name", k.pos);
                            this.expectOp(":");
                            entries.push([k.v, this.expr()]);
                        } while (this.isOp(this.lx.peek(), ",") && this.lx.next());
                    }
                    this.expectOp("}");
                    return { t: "obj", entries };
                }
                break;
        }
        throw this.lx.error(`expected an expression, found ${describe(t)}`, t.pos);
    }

    parenOrLambda(): Expr {
        const open = this.lx.next();
        const save = open.end;
        // Try a lambda first: (a, b) => expr
        const params: string[] = [];
        let isLambda = false;
        let t = this.lx.peek();
        if (this.isOp(t, ")")) {
            this.lx.next();
            isLambda = this.isOp(this.lx.peek(), "=>");
        } else if (t.k === "id") {
            for (;;) {
                t = this.lx.next();
                if (t.k !== "id") break;
                params.push(t.v);
                const sep = this.lx.next();
                if (this.isOp(sep, ",")) continue;
                if (this.isOp(sep, ")")) isLambda = this.isOp(this.lx.peek(), "=>");
                break;
            }
        }
        if (isLambda) {
            this.lx.next();
            return { t: "lambda", params, body: this.expr() };
        }
        this.lx.reset(save);
        const e = this.expr();
        this.expectOp(")");
        return e;
    }
}

export function parseQuery(text: string): Query {
    const p = new Parser(new Lexer(text));
    const q = p.query();
    p.expectEof();
    return q;
}

export function parseExpression(text: string): Expr {
    const p = new Parser(new Lexer(text));
    const e = p.expr();
    p.expectEof();
    return e;
}

export function parseSource(text: string): Source {
    if (text.trim().length === 0) return { t: "all" };
    const p = new Parser(new Lexer(text));
    const s = p.source();
    p.expectEof();
    return s;
}
