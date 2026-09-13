/** AST of the query language and its expressions. */
import type { Literal } from "../values/types";

export type BinOp = "+" | "-" | "*" | "/" | "%" | "=" | "!=" | "<" | "<=" | ">" | ">=" | "and" | "or";

export type Expr =
    | { t: "lit"; v: Literal }
    | { t: "var"; name: string }
    | { t: "not"; e: Expr }
    | { t: "neg"; e: Expr }
    | { t: "bin"; op: BinOp; l: Expr; r: Expr }
    | { t: "list"; items: Expr[] }
    | { t: "obj"; entries: [string, Expr][] }
    | { t: "idx"; obj: Expr; key: Expr }
    | { t: "call"; fn: Expr; args: Expr[] }
    | { t: "lambda"; params: string[]; body: Expr };

export type Source =
    | { t: "all" }
    | { t: "tag"; tag: string }
    | { t: "folder"; path: string }
    | { t: "link"; target: string; dir: "in" | "out" }
    | { t: "csv"; path: string }
    | { t: "not"; s: Source }
    | { t: "and"; l: Source; r: Source }
    | { t: "or"; l: Source; r: Source };

export interface NamedExpr {
    expr: Expr;
    name: string;
}

export type Header =
    | { t: "table"; withoutId: boolean; cols: NamedExpr[] }
    | { t: "list"; withoutId: boolean; expr: Expr | null }
    | { t: "task" };

export type Op =
    | { t: "where"; e: Expr }
    | { t: "sort"; keys: { e: Expr; dir: 1 | -1 }[] }
    | { t: "group"; e: Expr; name: string }
    | { t: "flatten"; e: Expr; name: string }
    | { t: "limit"; e: Expr };

export interface Query {
    header: Header;
    source: Source;
    ops: Op[];
}

/** Static path of an expression (`file.tags` -> ["file", "tags"]), or null. */
export function staticPath(e: Expr): string[] | null {
    if (e.t === "var") return [e.name];
    if (e.t === "idx" && e.key.t === "lit" && typeof e.key.v === "string") {
        const base = staticPath(e.obj);
        return base ? [...base, e.key.v] : null;
    }
    return null;
}
