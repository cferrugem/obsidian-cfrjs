/** TABLE, LIST and TASK renderers with row reuse. */
import { Component } from "obsidian";
import { ITEM_PAGE } from "../index/page";
import { valueKey } from "../values/types";
import { createKeyedState, KeyedState, renderKeyed, resetKeyed, rowComponent } from "./keyed";
import { needsMarkdown, renderMarkdown, renderValue, RenderContext } from "./value";

export interface ResultState {
    kind?: string;
    root?: HTMLElement;
    body?: HTMLElement;
    headerKey?: string;
    count?: HTMLElement;
    empty?: HTMLElement;
    keyed: KeyedState;
}

export function createResultState(): ResultState {
    return { keyed: createKeyedState() };
}

function rowContext(base: RenderContext, get: () => Component): RenderContext {
    return {
        app: base.app,
        settings: base.settings,
        sourcePath: base.sourcePath,
        get component() {
            return get();
        },
    };
}

function setEmpty(container: HTMLElement, state: ResultState, rc: RenderContext, isEmpty: boolean, message: string): void {
    if (isEmpty && rc.settings.warnOnEmptyResult) {
        if (!state.empty) state.empty = container.createDiv({ cls: "cfr-empty", text: message });
    } else if (state.empty) {
        state.empty.remove();
        state.empty = undefined;
    }
}

// ---------------------------------------------------------------------------
// TABLE
// ---------------------------------------------------------------------------

export function renderTable(
    container: HTMLElement,
    headers: string[],
    rows: unknown[][],
    rc: RenderContext,
    state: ResultState,
    owner: Component
): void {
    const headerKey = "table" + headers.join("");
    if (state.kind !== "table" || state.headerKey !== headerKey || !state.root?.isConnected) {
        resetKeyed(state.keyed, owner);
        container.empty();
        state.empty = undefined;
        state.kind = "table";
        state.headerKey = headerKey;
        const wrapper = container.createDiv({ cls: "cfr-table-wrapper" });
        const table = wrapper.createEl("table", { cls: "cfr cfr-table" });
        const tr = table.createEl("thead").createEl("tr");
        headers.forEach((h, i) => {
            const th = tr.createEl("th");
            if (needsMarkdown(h)) void renderMarkdown(th.createSpan(), h, rc);
            else th.appendText(h);
            if (i === 0 && rc.settings.showResultCount) state.count = th.createSpan({ cls: "cfr-count" });
        });
        state.root = wrapper;
        state.body = table.createEl("tbody");
    }

    if (state.count) state.count.setText(String(rows.length));
    const keys = rows.map(r => valueKey(r));
    renderKeyed(
        state.body!,
        rows,
        keys,
        cells => {
            const tr = document.createElement("tr");
            const rrc = rowContext(rc, rowComponent(state.keyed, owner, tr));
            for (const cell of cells) renderValue(tr.createEl("td"), cell, rrc, false);
            return tr;
        },
        state.keyed,
        owner,
        rc.settings.renderChunkSize
    );
    setEmpty(container, state, rc, rows.length === 0, "No results for this query.");
}

// ---------------------------------------------------------------------------
// LIST
// ---------------------------------------------------------------------------

export function renderList(container: HTMLElement, items: unknown[], rc: RenderContext, state: ResultState, owner: Component): void {
    if (state.kind !== "list" || !state.root?.isConnected) {
        resetKeyed(state.keyed, owner);
        container.empty();
        state.empty = undefined;
        state.kind = "list";
        state.headerKey = undefined;
        state.count = undefined;
        state.root = state.body = container.createEl("ul", { cls: "cfr cfr-list-view" });
    }
    renderKeyed(
        state.body!,
        items,
        items.map(i => valueKey(i)),
        item => {
            const li = document.createElement("li");
            renderValue(li, item, rowContext(rc, rowComponent(state.keyed, owner, li)), true);
            return li;
        },
        state.keyed,
        owner,
        rc.settings.renderChunkSize
    );
    setEmpty(container, state, rc, items.length === 0, "No results for this query.");
}

// ---------------------------------------------------------------------------
// TASK
// ---------------------------------------------------------------------------

export type TaskToggle = (item: Record<string, any>, checked: boolean) => Promise<void>;

interface TaskGroup {
    key: unknown;
    rows: Record<string, any>[];
}

function isGroup(row: any): row is TaskGroup {
    return row && row.task === undefined && Array.isArray(row.rows) && "key" in row;
}

function taskKey(item: Record<string, any>): string {
    let key = `${item.path}:${item.line}:${item.status}:${item.text}`;
    for (const child of item.children ?? []) key += "" + taskKey(child);
    return key;
}

function renderItem(parent: HTMLElement, item: Record<string, any>, rc: RenderContext, onToggle: TaskToggle, depth = 0): void {
    const li = parent.createEl("li", { cls: item.task ? "task-list-item" : "cfr-list-item" });
    if (item.task) {
        li.setAttr("data-task", item.status);
        if (item.checked) li.addClass("is-checked");
        const box = li.createEl("input", { cls: "task-list-item-checkbox", type: "checkbox" });
        box.checked = !!item.checked;
        box.addEventListener("click", evt => {
            evt.stopPropagation();
            box.disabled = true;
            onToggle(item, box.checked).finally(() => (box.disabled = false));
        });
    }
    const text = li.createSpan({ cls: "cfr-task-text" });
    if (needsMarkdown(item.text)) void renderMarkdown(text, item.text, rc);
    else text.setText(item.text);

    const children: Record<string, any>[] = item.children ?? [];
    if (children.length > 0 && depth < 20) {
        const ul = li.createEl("ul", { cls: "contains-task-list" });
        for (const child of children) renderItem(ul, child, rc, onToggle, depth + 1);
    }
}

function renderTaskRows(parent: HTMLElement, rows: Record<string, any>[], rc: RenderContext, onToggle: TaskToggle): void {
    // Skip items that already appear as children of another item in the result.
    const selected = new Set(rows.filter(r => !isGroup(r)).map(r => `${r.path}:${r.line}`));
    const ul = parent.createEl("ul", { cls: "contains-task-list" });
    for (const row of rows) {
        if (isGroup(row)) {
            renderGroup(parent, row, rc, onToggle);
            continue;
        }
        if (row.parent !== undefined && hasSelectedAncestor(row, selected)) continue;
        renderItem(ul, row, rc, onToggle);
    }
    if (!ul.hasChildNodes()) ul.remove();
}

function hasSelectedAncestor(row: Record<string, any>, selected: Set<string>): boolean {
    const byLine = new Map<number, Record<string, any>>();
    for (const t of (row as any)[ITEM_PAGE]?.lists ?? []) byLine.set(t.line, t);
    let parent = row.parent;
    const guard = new Set<number>();
    while (parent !== undefined && !guard.has(parent)) {
        guard.add(parent);
        if (selected.has(`${row.path}:${parent}`)) return true;
        parent = byLine.get(parent)?.parent;
    }
    return false;
}

function renderGroup(parent: HTMLElement, group: TaskGroup, rc: RenderContext, onToggle: TaskToggle): void {
    const section = parent.createDiv({ cls: "cfr-task-group" });
    const title = section.createEl("h4", { cls: "cfr-task-group-title" });
    renderValue(title, group.key, rc);
    renderTaskRows(section, group.rows, rc, onToggle);
}

export function renderTasks(
    container: HTMLElement,
    groups: TaskGroup[],
    count: number,
    rc: RenderContext,
    state: ResultState,
    owner: Component,
    onToggle: TaskToggle
): void {
    if (state.kind !== "task" || !state.root?.isConnected) {
        resetKeyed(state.keyed, owner);
        container.empty();
        state.empty = undefined;
        state.kind = "task";
        state.headerKey = undefined;
        state.root = container.createDiv({ cls: "cfr cfr-task-view" });
        state.count = rc.settings.showResultCount ? state.root.createDiv({ cls: "cfr-count cfr-task-count" }) : undefined;
        state.body = state.root.createDiv();
    }
    if (state.count) state.count.setText(`${count} ${count === 1 ? "task" : "tasks"}`);

    const keys = groups.map(g => valueKey(g.key) + "" + g.rows.map(r => (isGroup(r) ? valueKey(r.key) : taskKey(r))).join(""));
    renderKeyed(
        state.body!,
        groups,
        keys,
        group => {
            const div = document.createElement("div");
            const grc = rowContext(rc, rowComponent(state.keyed, owner, div));
            renderGroup(div, group, grc, onToggle);
            return div;
        },
        state.keyed,
        owner,
        Math.max(1, Math.floor(rc.settings.renderChunkSize / 20))
    );
    setEmpty(container, state, rc, count === 0, "No tasks found.");
}
