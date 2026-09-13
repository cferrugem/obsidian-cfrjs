import { describe, expect, it } from "vitest";
import { extractFullLineField, extractInlineFields, extractTags, parseContent } from "../src/index/parse-content";
import { fakeMetadata } from "./memory-index";

describe("inline fields", () => {
    it("extracts bracketed and parenthesized fields", () => {
        const fields = extractInlineFields("Text [a:: 1] and (b:: [[Link]]) end");
        expect(fields.map(f => [f.key, f.value])).toEqual([
            ["a", "1"],
            ["b", "[[Link]]"],
        ]);
    });

    it("extracts full-line fields with Markdown in the key", () => {
        expect(extractFullLineField("**Status**:: active")).toMatchObject({ key: "Status", value: "active" });
        expect(extractFullLineField("no separator")).toBeUndefined();
    });

    it("extracts task emoji dates", () => {
        const fields = extractInlineFields("do something 📅 2024-02-01 ✅ 2024-01-30", true);
        expect(fields.map(f => [f.key, f.value])).toEqual([
            ["due", "2024-02-01"],
            ["completion", "2024-01-30"],
        ]);
    });

    it("extracts tags", () => {
        expect(extractTags("hi #tag/sub and #other, but not #123")).toEqual(["#tag/sub", "#other"]);
    });
});

describe("parseContent", () => {
    it("skips files without fields or lists", () => {
        const content = "# Title\n\nJust text.";
        expect(parseContent(content, fakeMetadata(content).meta)).toEqual({ fields: [], lists: [] });
    });

    it("handles sections, nested lists and headings", () => {
        const content = [
            "# Section",
            "author:: Ann",
            "",
            "- [ ] task #urgent [prio:: 1]",
            "    - child",
            "- item:: value",
            "",
            "## Other",
            "- [x] done",
        ].join("\n");
        const data = parseContent(content, fakeMetadata(content).meta);
        expect(data.fields).toEqual([["author", "Ann"]]);
        expect(data.lists.map(l => [l.line, l.status, l.parent, l.section])).toEqual([
            [3, " ", -1, "Section"],
            [4, null, 3, "Section"],
            [5, null, -1, "Section"],
            [8, "x", -1, "Other"],
        ]);
        expect(data.lists[0].tags).toEqual(["#urgent"]);
        expect(data.lists[0].fields).toEqual([["prio", "1"]]);
        expect(data.lists[2].fields).toEqual([["item", "value"]]);
    });

    it("handles CRLF line endings", () => {
        const content = "field:: x\r\n- [ ] t\r\n";
        const data = parseContent(content, fakeMetadata(content.replace(/\r/g, "")).meta);
        expect(data.fields).toEqual([["field", "x"]]);
        expect(data.lists[0].text).toBe("t");
    });
});
