/** ```cfr code block with TABLE / LIST / TASK. */
import type CfrPlugin from "../main";
import { DepSet } from "../query/deps";
import { getParsedQuery, PreparedQuery, QueryResult } from "../query/execute";
import { createResultState, renderList, renderTable, renderTasks, ResultState } from "../render/results";
import { attachLinkHandlers } from "../render/value";
import { toggleTask } from "../tasks/toggle";
import { CfrRenderChild } from "./base-view";

export class QueryView extends CfrRenderChild {
    private prepared: PreparedQuery | null = null;
    private state: ResultState = createResultState();
    private content: HTMLElement;
    private timings: HTMLElement | null = null;

    constructor(plugin: CfrPlugin, containerEl: HTMLElement, private readonly source: string, sourcePath: string) {
        super(plugin, containerEl, sourcePath);
        containerEl.addClass("cfr-view");
        this.content = containerEl.createDiv();
    }

    onload(): void {
        attachLinkHandlers(this.containerEl, this.rc);
        super.onload();
    }

    protected async render(deps: DepSet): Promise<void> {
        const { plugin } = this;
        if (!this.prepared) {
            this.prepared = new PreparedQuery(getParsedQuery(this.source), plugin.index, this.sourcePath, plugin.settings);
        }
        const result = await this.prepared.run(deps);
        if (!this.content.isConnected) {
            this.containerEl.empty();
            this.content = this.containerEl.createDiv();
            this.state = createResultState();
        }
        this.draw(result);
    }

    private draw(result: QueryResult): void {
        const start = performance.now();
        const rc = this.rc;
        switch (result.type) {
            case "table":
                renderTable(this.content, result.headers, result.rows, rc, this.state, this);
                break;
            case "list":
                renderList(this.content, result.items, rc, this.state, this);
                break;
            case "task":
                renderTasks(this.content, result.groups, result.count, rc, this.state, this, (item, checked) =>
                    toggleTask(this.plugin.app, this.plugin.settings, item, checked)
                );
                break;
        }

        if (this.plugin.settings.showTimings) {
            if (!this.timings || !this.timings.isConnected) this.timings = this.containerEl.createDiv({ cls: "cfr-timings" });
            this.timings.setText(`query ${result.timeMs.toFixed(1)}ms · render ${(performance.now() - start).toFixed(1)}ms`);
        } else if (this.timings) {
            this.timings.remove();
            this.timings = null;
        }
    }

    protected onError(e: unknown): void {
        this.state = createResultState();
        this.timings = null;
        super.onError(e);
        this.content = this.containerEl.createDiv();
    }
}
