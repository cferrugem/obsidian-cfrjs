/** Core benchmarks (no Obsidian): content parsing and query execution. */
import { bench, describe } from "vitest";
import { parseContent } from "../src/index/parse-content";
import { DepSet } from "../src/query/deps";
import { getParsedQuery, PreparedQuery } from "../src/query/execute";
import { fakeMetadata, MemoryIndex, NoteSpec } from "../test/memory-index";

const N = 10000;
const statuses = ["active", "paused", "done", "idea"];
const tags = ["#project", "#work", "#personal", "#reading", "#urgent"];

function note(i: number): NoteSpec {
    const tasks = Array.from({ length: i % 5 }, (_, t) => `- [${(i + t) % 2 ? "x" : " "}] task ${t} 📅 2024-0${1 + (t % 9)}-1${t}`).join("\n");
    return {
        path: `folder${i % 20}/note-${i}.md`,
        frontmatter: { status: statuses[i % 4], priority: (i * 7) % 5, date: `2024-01-${String(1 + (i % 28)).padStart(2, "0")}` },
        tags: [tags[i % 5], tags[(i * 3) % 5]],
        content: `# Note ${i}\n\nRating:: ${i % 10}\nSee [[note-${(i * 13) % N}]] and [mood:: good].\n\n## Tasks\n${tasks}\n`,
        mtime: i,
    };
}

const notes = Array.from({ length: N }, (_, i) => note(i));
const index = new MemoryIndex(notes);
const docs = notes.slice(0, 1000).map(n => ({ content: n.content!, meta: fakeMetadata(n.content!).meta }));

// Warm up the rows (like the plugin, they are built once per page version).
for (const page of index.pages.values()) void page.row;

function prepared(text: string) {
    return new PreparedQuery(getParsedQuery(text), index, "folder0/note-0.md", { tableIdColumnName: "File", tableGroupColumnName: "Group" });
}

const byTag = prepared("TABLE status, priority FROM #project WHERE priority >= 2 SORT date DESC");
const topK = prepared("TABLE status FROM #project SORT priority DESC, file.name LIMIT 20");
const grouped = prepared('TABLE length(rows) AS n FROM "folder3" OR #urgent GROUP BY status');
const all = prepared('LIST WHERE rating > 5 AND mood = "good"');
const tasks = prepared("TASK WHERE !completed AND due < date(2024-05-01)");
const flatten = prepared("TABLE file.tags FROM #reading FLATTEN file.tags");

describe(`queries over ${N} notes`, () => {
    bench("FROM #tag WHERE SORT", async () => void (await byTag.run(new DepSet())));
    bench("SORT + LIMIT 20 (top-k)", async () => void (await topK.run(new DepSet())));
    bench("GROUP BY with an OR source", async () => void (await grouped.run(new DepSet())));
    bench("no FROM, WHERE on inline fields", async () => void (await all.run(new DepSet())));
    bench("TASK with WHERE", async () => void (await tasks.run(new DepSet())));
    bench("FLATTEN file.tags", async () => void (await flatten.run(new DepSet())));
    bench("parse + compile a new query", () => {
        new PreparedQuery(getParsedQuery(`TABLE a, b FROM #x WHERE c > ${Math.random()} SORT d`), index, "", {
            tableIdColumnName: "File",
            tableGroupColumnName: "Group",
        });
    });
});

describe("indexing", () => {
    bench("parseContent for 1000 notes", () => {
        for (const d of docs) parseContent(d.content, d.meta);
    });
});
