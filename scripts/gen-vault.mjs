// Generates a synthetic vault for performance testing.
// Usage: node scripts/gen-vault.mjs <folder> [count=10000]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const target = process.argv[2];
const count = parseInt(process.argv[3] ?? "10000", 10);
if (!target) {
    console.error("Usage: node scripts/gen-vault.mjs <folder> [count]");
    process.exit(1);
}

const folders = ["projects", "journal", "people", "reading", "archive/2023", "archive/2024"];
const statuses = ["active", "paused", "done", "idea"];
const tags = ["project", "work", "personal", "reading", "urgent", "health/exercise", "health/sleep"];

let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = arr => arr[Math.floor(rand() * arr.length)];

for (const f of folders) mkdirSync(join(target, f), { recursive: true });

for (let i = 0; i < count; i++) {
    const folder = pick(folders);
    const day = new Date(2023, 0, 1 + (i % 700)).toISOString().slice(0, 10);
    const noteTags = [pick(tags), pick(tags)];
    const links = Array.from({ length: 3 }, () => `[[note-${Math.floor(rand() * count)}]]`).join(" ");
    const tasks = Array.from({ length: Math.floor(rand() * 5) }, (_, t) => {
        const done = rand() > 0.5;
        const due = new Date(2024, Math.floor(rand() * 12), 1 + Math.floor(rand() * 27)).toISOString().slice(0, 10);
        return `- [${done ? "x" : " "}] task ${t} of note ${i} 📅 ${due}${rand() > 0.7 ? `\n    - [ ] subtask [priority:: ${Math.ceil(rand() * 3)}]` : ""}`;
    }).join("\n");

    const content = `---
status: ${pick(statuses)}
priority: ${Math.ceil(rand() * 5)}
date: ${day}
tags: [${noteTags.join(", ")}]
---
# Note ${i}

Rating:: ${Math.ceil(rand() * 10)}
Related: ${links}

Sample text with [mood:: ${pick(["good", "ok", "bad"])}] and #${pick(tags)} in the body.

## Tasks
${tasks}
`;
    writeFileSync(join(target, folder, `note-${i}.md`), content);
}

writeFileSync(
    join(target, "Queries.md"),
    `# Test queries

\`\`\`cfr
TABLE status, priority, date FROM #project WHERE priority >= 4 SORT date DESC LIMIT 50
\`\`\`

\`\`\`cfr
TABLE length(rows) AS Count FROM "projects" GROUP BY status
\`\`\`

\`\`\`cfr
TASK FROM "projects" WHERE !completed AND due < date(2024-03-01) LIMIT 100
\`\`\`

\`\`\`cfrjs
const pages = cfr.pages("#urgent").where(p => p.rating > 7);
cfr.paragraph(\`\${pages.length} highly rated urgent notes\`);
cfr.table(["Note", "Status"], pages.sort(p => p.file.name).limit(20).map(p => [p.file.link, p.status]));
\`\`\`

Outgoing links: \`= length(this.file.outlinks)\`
`
);

console.log(`Generated a vault with ${count} notes in ${target}`);
