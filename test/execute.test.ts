import { describe, expect, it } from "vitest";
import { ChangeBatch, DepSet, isAffected } from "../src/query/deps";
import { getParsedQuery, ListResult, PreparedExpression, PreparedQuery, TableResult, TaskResult } from "../src/query/execute";
import { parseExpression } from "../src/query/parser";
import { Link } from "../src/values/link";
import { MemoryIndex } from "./memory-index";

const settings = { tableIdColumnName: "File", tableGroupColumnName: "Group" };

function makeIndex() {
    return new MemoryIndex([
        {
            path: "projects/A.md",
            frontmatter: { status: "active", priority: 2 },
            tags: ["#project"],
            content: "rating:: 5\n\n- [ ] task one [due:: 2024-01-05]\n- [x] task two\n    - [ ] sub task\n- plain [kind:: note]",
        },
        {
            path: "projects/B.md",
            frontmatter: { status: "done", priority: 1 },
            tags: ["#project/sub"],
            content: "Links to [[A]] here.",
        },
        { path: "notes/C.md", frontmatter: { priority: 3 }, tags: ["#other"], content: "Nothing" },
    ]);
}

async function run(text: string, index = makeIndex(), deps = new DepSet()) {
    return new PreparedQuery(getParsedQuery(text), index, "notes/C.md", settings).run(deps);
}

describe("execution", () => {
    it("filters by tag including subtags", async () => {
        const r = (await run("TABLE status FROM #project")) as TableResult;
        expect(r.headers).toEqual(["File", "status"]);
        expect(r.rows.map(row => row[1]).sort()).toEqual(["active", "done"]);
    });

    it("sorts by folder and field", async () => {
        const r = (await run('TABLE WITHOUT ID file.name FROM "projects" SORT priority')) as TableResult;
        expect(r.rows).toEqual([["B"], ["A"]]);
    });

    it("uses inline fields and list item fields", async () => {
        const r = (await run('LIST WHERE rating = 5 AND kind = "note"')) as ListResult;
        expect(r.items.map((l: Link) => l.path)).toEqual(["projects/A.md"]);
    });

    it("groups and names the group column", async () => {
        const r = (await run("TABLE length(rows) AS n WHERE priority GROUP BY status")) as TableResult;
        expect(r.headers).toEqual(["status", "n"]);
        expect(r.rows).toEqual([
            [null, 1],
            ["active", 1],
            ["done", 1],
        ]);
    });

    it("flattens lists keeping the path", async () => {
        const r = (await run('TABLE WITHOUT ID file.name, file.tags FROM "projects" FLATTEN file.tags SORT file.tags')) as TableResult;
        expect(r.rows).toEqual([
            ["A", "#project"],
            ["B", "#project"],
            ["B", "#project/sub"],
        ]);
    });

    it("queries tasks with page fields reachable through the base row", async () => {
        // The task's own `status` shadows the page field (same semantics as Dataview); priority comes from the page.
        const r = (await run("TASK WHERE !completed AND priority = 2")) as TaskResult;
        expect(r.count).toBe(2);
        const texts = r.groups[0].rows.map(t => t.text);
        expect(texts).toContain("task one [due:: 2024-01-05]");
        expect(r.groups[0].rows[0].due.day).toBe(5);
        const parent = makeIndex().pages.get("projects/A.md")!.tasks.find(t => t.text === "task two")!;
        expect(parent.fullyCompleted).toBe(false);
        expect(parent.children.length).toBe(1);
    });

    it("supports incoming links and negation", async () => {
        const incoming = (await run("LIST FROM [[A]]")) as ListResult;
        expect(incoming.items.map((l: Link) => l.path)).toEqual(["projects/B.md"]);
        const negated = (await run("LIST FROM -#project")) as ListResult;
        expect(negated.items.map((l: Link) => l.path)).toEqual(["notes/C.md"]);
    });

    it("resolves this and links inside expressions", async () => {
        const r = (await run('TABLE WITHOUT ID [[A]].status, this.priority FROM "projects/B.md"')) as TableResult;
        expect(r.rows).toEqual([["active", 3]]);
    });

    it("top-k with LIMIT matches a full sort", async () => {
        const notes = Array.from({ length: 200 }, (_, i) => ({
            path: `n/${i}.md`,
            frontmatter: { score: (i * 7919) % 101 },
        }));
        const index = new MemoryIndex(notes);
        const full = (await run("TABLE score SORT score DESC, file.name", index)) as TableResult;
        const top = (await run("TABLE score SORT score DESC, file.name LIMIT 7", index)) as TableResult;
        expect(top.rows).toEqual(full.rows.slice(0, 7));
    });

    it("evaluates standalone expressions with this", () => {
        const index = makeIndex();
        const expr = new PreparedExpression(parseExpression("this.priority + 1"), index, "projects/A.md");
        expect(expr.run(new DepSet())).toBe(3);
    });
});

describe("dependencies", () => {
    const batch = (changes: ChangeBatch["changes"]): ChangeBatch => ({ revision: 1, global: false, starred: false, changes });

    it("records tag, folder and this dependencies", async () => {
        const deps = new DepSet();
        await run('TABLE status FROM #project OR "notes"', makeIndex(), deps);
        expect(deps.all).toBe(false);
        expect([...deps.tags]).toEqual(["#project"]);
        expect([...deps.folders]).toEqual(["notes"]);
        expect(deps.paths.has("notes/C.md")).toBe(true);

        const change = (path: string, tags: string[] = []) => ({ kind: "page" as const, path, tags: new Set(tags), links: new Set<string>() });
        expect(isAffected(deps, batch([change("other/X.md")]))).toBe(false);
        expect(isAffected(deps, batch([change("other/X.md", ["#project"])]))).toBe(true);
        expect(isAffected(deps, batch([change("notes/new.md")]))).toBe(true);
    });

    it("queries without FROM depend on everything", async () => {
        const deps = new DepSet();
        await run("LIST", makeIndex(), deps);
        expect(deps.all).toBe(true);
    });
});
