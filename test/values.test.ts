import { describe, expect, it } from "vitest";
import { compare } from "../src/values/compare";
import { CDate, parseDateWithFormat, parseISODate, setLocale } from "../src/values/date";
import { CDuration, parseDuration } from "../src/values/duration";
import { Link } from "../src/values/link";
import { canonicalizeKey, parseFrontmatterValue, parseInlineValue } from "../src/values/parse-value";
import { truthy, valueKey } from "../src/values/types";

setLocale("en");

describe("dates", () => {
    it("parses ISO dates", () => {
        const d = parseISODate("2024-05-01")!;
        expect([d.year, d.month, d.day, d.hasTime]).toEqual([2024, 5, 1, false]);
        const t = parseISODate("2024-05-01T10:30")!;
        expect([t.hour, t.minute, t.hasTime]).toEqual([10, 30, true]);
        expect(parseISODate("2024-13-01")).toBeNull();
        expect(parseISODate("2024-02-30")).toBeNull();
        expect(parseISODate("hello")).toBeNull();
    });

    it("formats with compiled tokens", () => {
        const d = CDate.fromParts(2024, 3, 7, 15, 4, 5);
        expect(d.format("yyyy-MM-dd HH:mm:ss")).toBe("2024-03-07 15:04:05");
        expect(d.format("MMMM d, yyyy 'at' h a")).toBe("March 7, 2024 at 3 PM");
    });

    it("adds months clamping to the end of the month", () => {
        const d = parseISODate("2024-01-31")!;
        expect(d.plus(CDuration.of({ months: 1 })).toISODate()).toBe("2024-02-29");
        expect(d.plus(CDuration.of({ days: 1 })).toISODate()).toBe("2024-02-01");
    });

    it("parses with an explicit format", () => {
        expect(parseDateWithFormat("07/03/2024", "dd/MM/yyyy")!.toISODate()).toBe("2024-03-07");
    });
});

describe("durations", () => {
    it("parses several units", () => {
        expect(parseDuration("1 day")!.days).toBe(1);
        expect(parseDuration("2h 30m")!.minutes).toBe(150);
        expect(parseDuration("1 year, 2 months")!.months).toBe(14);
        expect(parseDuration("abc")).toBeNull();
    });

    it("formats in a human-readable way", () => {
        expect(CDuration.of({ days: 3, hours: 2 }).toHuman()).toBe("3 days, 2 hours");
    });
});

describe("values", () => {
    it("parses inline field values", () => {
        expect(parseInlineValue("42")).toBe(42);
        expect(parseInlineValue("true")).toBe(true);
        expect(parseInlineValue("a, b")).toBe("a, b");
        const links = parseInlineValue("[[A]], [[B|b]]") as Link[];
        expect(links.map(l => l.path)).toEqual(["A", "B"]);
        expect(parseInlineValue("2024-01-01")).toBeInstanceOf(CDate);
        expect(parseInlineValue("")).toBeNull();
    });

    it("converts frontmatter recursively", () => {
        const v = parseFrontmatterValue({ due: "2024-01-01", list: ["[[X]]", 1], name: "abc" }) as any;
        expect(v.due).toBeInstanceOf(CDate);
        expect(v.list[0]).toBeInstanceOf(Link);
        expect(v.name).toBe("abc");
    });

    it("normalizes field names", () => {
        expect(canonicalizeKey("Due Date")).toBe("due-date");
        expect(canonicalizeKey("**Status**")).toBe("status");
    });

    it("compares different types by rank and equal types by value", () => {
        expect(compare(null, 1)).toBeLessThan(0);
        expect(compare(2, 10)).toBeLessThan(0);
        expect(compare("b", "a")).toBeGreaterThan(0);
        expect(compare(parseISODate("2024-01-01"), parseISODate("2023-01-01"))).toBeGreaterThan(0);
        expect(compare(Link.file("A"), Link.file("A.md"), p => (p.endsWith(".md") ? p : p + ".md"))).toBe(0);
    });

    it("computes truthiness and keys", () => {
        expect(truthy([])).toBe(false);
        expect(truthy({})).toBe(false);
        expect(truthy("x")).toBe(true);
        expect(valueKey([1, "1"])).not.toBe(valueKey(["1", 1]));
    });
});
