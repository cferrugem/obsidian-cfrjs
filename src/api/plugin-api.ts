/** Global API (window.CfrJsAPI) for other plugins and the developer console. */
import type CfrPlugin from "../main";
import { Row } from "../index/page";
import { DepSet } from "../query/deps";
import { getParsedQuery, PreparedQuery, QueryResult, resolveSourcePaths } from "../query/execute";
import { parseSource } from "../query/parser";
import { CDate, parseISODate } from "../values/date";
import { CDuration, parseDuration } from "../values/duration";
import { Link } from "../values/link";
import { DataArray } from "./data-array";

export class CfrApi {
    readonly DataArray = DataArray;
    readonly Link = Link;
    readonly CDate = CDate;
    readonly CDuration = CDuration;

    constructor(private readonly plugin: CfrPlugin) {}

    get ready(): boolean {
        return this.plugin.index.ready;
    }

    pages(source = "", originFile = ""): DataArray<Row> {
        const index = this.plugin.index;
        const out = new DataArray<Row>();
        for (const p of resolveSourcePaths(parseSource(source), index, originFile, new DepSet())) {
            const row = index.pageRow(p);
            if (row) out.push(row);
        }
        return out;
    }

    page(path: string | Link, originFile = ""): Row | undefined {
        const raw = path instanceof Link ? path.path : path;
        return this.plugin.index.pageRow(this.plugin.index.resolveLinkPath(raw, originFile) ?? raw);
    }

    async query(text: string, originFile = ""): Promise<QueryResult> {
        return new PreparedQuery(getParsedQuery(text), this.plugin.index, originFile, this.plugin.settings).run(new DepSet());
    }

    date(text: string): CDate | null {
        return parseISODate(text);
    }

    duration(text: string): CDuration | null {
        return parseDuration(text);
    }

    stats() {
        return { ...this.plugin.index.stats, pages: this.plugin.index.pages.size, revision: this.plugin.index.revision, scheduler: this.plugin.scheduler.stats };
    }
}
