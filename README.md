# CFR Js

An Obsidian plugin inspired by [Dataview](https://github.com/blacksmithgu/obsidian-dataview), written from scratch with a focus on **performance**: `TABLE` / `LIST` / `TASK` queries, a JavaScript API, inline queries, inline fields, task toggling from views, and CSV sources.

> cfrjs is an independent project. It is not affiliated with or endorsed by Dataview or its author.

## Manual installation

```bash
npm install
npm run build        # type-checks and produces main.js
```

Copy `main.js`, `manifest.json` and `styles.css` to `<your vault>/.obsidian/plugins/cfrjs/` and enable the plugin under *Settings → Community plugins*.

Development: `npm run dev` (rebuild on change), `npm test`, `npm run bench`.

## Queries (```cfr)

````markdown
```cfr
TABLE status, priority AS "Priority", file.mtime
FROM #project AND "Work"
WHERE priority >= 3 AND !contains(file.tags, "#archived")
SORT file.mtime DESC
LIMIT 20
```
````

| Command | Example |
| --- | --- |
| `TABLE [WITHOUT ID] expr [AS name], ...` | `TABLE status, length(file.tasks) AS Tasks` |
| `LIST [WITHOUT ID] [expr]` | `LIST file.mtime` |
| `TASK` | `TASK WHERE !completed` |
| `FROM source` | `#tag`, `"folder"`, `[[note]]` (incoming links), `outgoing([[note]])`, `csv("data.csv")`, combined with `and`, `or`, `-`/`!` and parentheses |
| `WHERE expr` | `WHERE due <= date(today) + dur(7 days)` |
| `SORT expr [ASC\|DESC], ...` | `SORT priority DESC, file.name` |
| `GROUP BY expr [AS name]` | `GROUP BY status` (produces `key` and `rows`) |
| `FLATTEN expr [AS name]` | `FLATTEN file.tags` |
| `LIMIT n` | `LIMIT 10` |

**Expressions:** `+ - * / %`, `= != < <= > >=`, `and`/`or`/`!`, `field.sub`, `list[0]`, `row["field with spaces"]`, `this` (current page), links `[[Note]].field`, lists `[1, 2]`, objects `{ a: 1 }`, lambdas `(x) => x.y`, dates `date(today)`, `date(2024-05-01)` and durations `dur(1 week)`.

**Page fields:** frontmatter, inline fields (`field:: value`, `[field:: value]`, `(field:: value)`) and `file.name`, `file.path`, `file.folder`, `file.link`, `file.tags`, `file.etags`, `file.aliases`, `file.outlinks`, `file.inlinks`, `file.tasks`, `file.lists`, `file.ctime`, `file.cday`, `file.mtime`, `file.mday`, `file.size`, `file.day`, `file.frontmatter`, `file.starred`. Field names are normalized (`Due Date::` is also available as `due-date`).

**Tasks/lists:** `text`, `status`, `checked`, `completed`, `fullyCompleted`, `line`, `path`, `section`, `link`, `tags`, `outlinks`, `children`, `parent`, `due`, `created`, `start`, `scheduled`, `completion` (including emoji shorthand 📅 ✅ ⏳ 🛫 ➕) and the item's inline fields. Page fields are also visible in `TASK` queries.

**Functions:** `date`, `dur`, `number`, `string`, `link`, `embed`, `elink`, `typeof`, `object`, `list`, `meta`, `display`, `round`, `trunc`, `floor`, `ceil`, `abs`, `min`, `max`, `minby`, `maxby`, `sum`, `product`, `average`, `currencyformat`, `length`, `contains`, `icontains`, `econtains`, `containsword`, `extract`, `reverse`, `sort`, `flat`, `slice`, `unique`, `nonnull`, `firstvalue`, `filter`, `map`, `reduce`, `any`, `all`, `none`, `join`, `default`, `ldefault`, `choice`, `get`, `lower`, `upper`, `trim`, `split`, `replace`, `regextest`, `regexmatch`, `regexreplace`, `startswith`, `endswith`, `padleft`, `padright`, `substring`, `truncate`, `striptime`, `dateformat`, `durationformat`, `localtime`.

## JavaScript (```cfrjs)

````markdown
```cfrjs
const projects = cfr.pages("#project").where(p => p.status === "active");
cfr.header(3, `${projects.length} active projects`);
cfr.table(
    ["Project", "Priority", "Open"],
    projects.sort(p => p.priority, "desc").map(p => [p.file.link, p.priority, p.file.tasks.where(t => !t.completed).length])
);
```
````

`dv` also works as an alias of `cfr`, to ease migration.

| API | Description |
| --- | --- |
| `cfr.pages(source?)`, `cfr.pagePaths(source?)`, `cfr.page(path)`, `cfr.current()` | Index data |
| `cfr.query(dql)` / `cfr.tryQuery(dql)` | Run DQL and return data |
| `cfr.execute(dql)` | Render a DQL query |
| `cfr.table(headers, rows)`, `cfr.list(items)`, `cfr.taskList(tasks, groupByFile?)` | Rendering |
| `cfr.paragraph`, `cfr.header`, `cfr.span`, `cfr.el(tag, content, {cls, attr})` | Elements |
| `cfr.io.csv(path)`, `cfr.io.load(path)`, `cfr.view(path, input)` | Files |
| `cfr.date`, `cfr.duration`, `cfr.fileLink`, `cfr.sectionLink`, `cfr.blockLink`, `cfr.compare`, `cfr.equal`, `cfr.array`, `cfr.func.*`, `cfr.evaluate(expr)` | Utilities |

`DataArray` is a real `Array` subclass with `where`, `sort(key, "asc"|"desc")`, `groupBy`, `distinct`, `limit`, `first`, `last`, `to`, `into`, `pluck("file.name")`, `expand("children")`, `sum`, `avg`, `min`, `max`, `none`, `array()` and chained access to the most common fields (`pages.file.name`, `page.file.tasks.text`).

Other plugins can use `window.CfrJsAPI` (`pages`, `page`, `query`, `stats`).

## Inline

- `` `= this.status` `` — expression evaluated in Reading view and Live Preview.
- `` `$= cfr.pages("#project").length` `` — inline JavaScript.

## Commands

- **Refresh all views**
- **Rebuild index (discard cache)**
- **Show index statistics** — indexing times, cache hits, workers and how many refreshes were skipped.

## Why it is faster

**Startup and indexing**
- The persistent cache is loaded with a single IndexedDB read, and changes are written back in batched transactions.
- Frontmatter, tags and links come straight from Obsidian's metadata cache, so only files without a valid cache entry are read from disk.
- Inline fields and lists are parsed by up to 4 Web Workers (configurable), in batches of 64 files, walking each file's lines once.
- Index updates are coalesced and emitted in batches instead of one notification per file.

**Queries**
- Each page's queryable row is built once per version and shared by every query; `file.*` values are computed lazily and memoized.
- Tags, folders, incoming links and unresolved links have incremental indexes, so `FROM` never scans the whole vault.
- Expressions are compiled to JavaScript closures once and reused on every refresh.
- Sorting uses a typed comparator with fast paths; `SORT ... LIMIT` selects the top results with a heap instead of sorting everything; `GROUP BY` uses hash maps; `FLATTEN` creates shallow overlays instead of copies.
- `DataArray` is a real `Array` subclass, so indexing and iteration have native cost.

**Refreshing and rendering**
- Every view records what it depends on (tags, folders, files, links, CSV files); a change only refreshes the views it affects, and off-screen views wait until they become visible.
- Results are rendered directly to the DOM; the Markdown renderer is used only for text that actually contains Markdown.
- Unchanged rows are reused between refreshes, and large results are rendered in chunks during idle time.
- In Live Preview, only the visible part of the document is scanned, and inline results are recomputed only when their code or dependencies change.
- No runtime dependencies: the whole plugin, worker included, is about 115 KB minified.

## Differences from Dataview

- Block keywords: `cfr` and `cfrjs` (enable *Accept dataview/dataviewjs blocks* to migrate without editing notes, with Dataview disabled).
- Dates are `CDate` (not Luxon). Common methods exist: `year`, `month`, `day`, `weekday`, `toFormat()`, `toISODate()`, `toMillis()`, `plus()`, `minus()`, `startOf()`, `endOf()`. `dv.luxon` is not available.
- `DataArray.sort(key)` returns a new array; `sort((a, b) => ...)` with two arguments keeps the native (in-place) behavior.
- Page objects are shared between queries to avoid copies: **do not mutate them** in scripts (create new objects instead).
- Not implemented in this version: `CALENDAR`, pretty-rendering of inline fields in Live Preview, recursive subtask completion.

## Security

`cfrjs` code blocks and inline `$=` expressions run **JavaScript written in your notes** with the same permissions as Obsidian itself (they can read and modify files in your vault). Only open vaults and notes you trust. You can turn JavaScript off under *Settings → CFR Js → Enable JavaScript* and *Enable inline JavaScript*; `cfr` queries and inline `=` expressions never execute arbitrary code.

## Mobile

The plugin does not use Node.js or Electron APIs and falls back to the main thread when Web Workers are unavailable, so it is marked as mobile compatible. Mobile has not been extensively tested yet; please report issues.

## Credits and license

cfrjs is released under the [MIT License](LICENSE).

Its query language, API names and field names follow Dataview's conventions so existing queries keep working. The inline field parsing rules in `src/index/parse-content.ts` are adapted from [Dataview](https://github.com/blacksmithgu/obsidian-dataview) (Copyright (c) 2021 Michael Brenan, MIT License); the full notice is included in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Releasing

1. `npm version patch` (or `minor`/`major`) — updates `package.json`, `manifest.json` and `versions.json` and creates a git tag.
2. `git push --follow-tags` — the GitHub Action builds, tests and creates a draft release with `main.js`, `manifest.json` and `styles.css`.
3. Review and publish the draft release on GitHub.

## Benchmarks

`npm run bench` measures the core in Node (in-memory index with 10,000 notes). To test inside Obsidian:

```bash
node scripts/gen-vault.mjs ./test-vault 10000
```

Open `test-vault` as a vault, install the plugin and use **Show index statistics** and the **Show timings** option.
