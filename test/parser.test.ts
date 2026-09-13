import { describe, expect, it } from "vitest";
import { compile, EvalContext } from "../src/query/compile";
import { QueryError } from "../src/query/errors";
import { FUNCTIONS } from "../src/query/functions";
import { parseExpression, parseQuery, parseSource } from "../src/query/parser";
import { CDate } from "../src/values/date";
import { CDuration } from "../src/values/duration";

const ctx: EvalContext = {
    thisRow: () => null,
    resolveLink: () => null,
    normalizeLink: p => p,
    functions: FUNCTIONS,
    markDynamic: () => {},
};

function evaluate(text: string, row: Record<string, any> = {}): any {
    return compile(parseExpression(text), ctx)(row);
}

describe("query parser", () => {
    it("parses a complete TABLE query", () => {
        const q = parseQuery(`TABLE status, file.mtime AS "Modified"
            FROM #project AND "Folder/Sub"
            WHERE priority > 1 AND !completed
            SORT file.mtime DESC, file.name
            LIMIT 10`);
        expect(q.header).toMatchObject({ t: "table", withoutId: false });
        if (q.header.t !== "table") throw new Error();
        expect(q.header.cols.map(c => c.name)).toEqual(["status", "Modified"]);
        expect(q.source).toMatchObject({ t: "and", l: { t: "tag", tag: "#project" }, r: { t: "folder", path: "Folder/Sub" } });
        expect(q.ops.map(o => o.t)).toEqual(["where", "sort", "limit"]);
        const sort = q.ops[1];
        if (sort.t !== "sort") throw new Error();
        expect(sort.keys.map(k => k.dir)).toEqual([-1, 1]);
    });

    it("parses LIST, TASK, GROUP BY and FLATTEN", () => {
        expect(parseQuery("LIST WITHOUT ID file.name").header).toMatchObject({ t: "list", withoutId: true });
        expect(parseQuery("list").header).toMatchObject({ t: "list", expr: null });
        const q = parseQuery("TASK FROM [[Note]] GROUP BY file.link AS source FLATTEN tags");
        expect(q.header.t).toBe("task");
        expect(q.source).toEqual({ t: "link", target: "Note", dir: "in" });
        expect(q.ops).toMatchObject([{ t: "group", name: "source" }, { t: "flatten", name: "tags" }]);
    });

    it("parses sources with negation and parentheses", () => {
        expect(parseSource('(#a or #b) and -"archive"')).toMatchObject({
            t: "and",
            l: { t: "or" },
            r: { t: "not", s: { t: "folder", path: "archive" } },
        });
        expect(parseSource("outgoing([[X]])")).toEqual({ t: "link", target: "X", dir: "out" });
        expect(parseSource('csv("data.csv")')).toEqual({ t: "csv", path: "data.csv" });
    });

    it("produces readable errors", () => {
        expect(() => parseQuery("WHERE x")).toThrow(QueryError);
        expect(() => parseQuery("TABLE x WHERE")).toThrow(/line 1/);
        expect(() => parseQuery("TABLE x FROM #a SORTT y")).toThrow(/unknown command/);
    });
});

describe("expressions", () => {
    it("respects operator precedence", () => {
        expect(evaluate("1 + 2 * 3")).toBe(7);
        expect(evaluate("(1 + 2) * 3")).toBe(9);
        expect(evaluate("1 < 2 and 3 > 4 or true")).toBe(true);
        expect(evaluate("-2 + 5")).toBe(3);
        expect(evaluate("!false")).toBe(true);
    });

    it("reads fields and paths", () => {
        const row = { a: 5, file: { name: "Note", tags: ["#x", "#y"] }, "field with spaces": 1 };
        expect(evaluate("a * 2", row)).toBe(10);
        expect(evaluate("file.name", row)).toBe("Note");
        expect(evaluate('row["field with spaces"]', row)).toBe(1);
        expect(evaluate("file.tags[1]", row)).toBe("#y");
        expect(evaluate("missing", row)).toBeNull();
        expect(evaluate("missing.x", row)).toBeNull();
    });

    it("supports date and duration literals", () => {
        expect(evaluate("date(2024-01-01)")).toBeInstanceOf(CDate);
        expect(evaluate("date(today)")).toBeInstanceOf(CDate);
        expect(evaluate("dur(1 day)")).toBeInstanceOf(CDuration);
        expect(evaluate("(date(2024-01-01) + dur(2 days)).day")).toBe(3);
        expect(evaluate("date(2024-01-10) - date(2024-01-01)").days).toBe(9);
        expect(evaluate('date("2024-02-03").month')).toBe(2);
    });

    it("supports functions and lambdas", () => {
        expect(evaluate("filter([1, 2, 3], (x) => x > 1)")).toEqual([2, 3]);
        expect(evaluate("map([1, 2], x => x * 10)")).toEqual([10, 20]);
        expect(evaluate('contains(["project", "home"], "proj")')).toBe(true);
        expect(evaluate('econtains(["project", "home"], "proj")')).toBe(false);
        expect(evaluate('lower(["A", "B"])')).toEqual(["a", "b"]);
        expect(evaluate("sum([1, 2, 3])")).toBe(6);
        expect(evaluate("round(3.14159, 2)")).toBe(3.14);
        expect(evaluate('default(null, "x")')).toBe("x");
        expect(evaluate('choice(1 > 2, "a", "b")')).toBe("b");
        expect(evaluate('regexreplace("a-b-c", "-", "+")')).toBe("a+b+c");
        expect(evaluate('join(sort([3, 1, 2]), "|")')).toBe("1|2|3");
        expect(evaluate('dateformat(date(2024-03-07), "dd/MM/yyyy")')).toBe("07/03/2024");
        expect(evaluate('"a" + 1')).toBe("a1");
        expect(evaluate("length(null)")).toBe(0);
    });

    it("folds constants", () => {
        const fn = compile(parseExpression("[1, 2, 3 * 4]"), ctx);
        expect(fn({})).toBe(fn({ other: 1 }));
    });
});
