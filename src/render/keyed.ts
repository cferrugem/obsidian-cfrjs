/**
 * Keyed row reconciliation + chunked rendering.
 * Rows whose content did not change are reused (zero DOM/Markdown work);
 * new rows are created in chunks, the first synchronously and the rest during idle time.
 */
import { Component } from "obsidian";

export interface KeyedState {
    rows: Map<string, HTMLElement[]>;
    components: WeakMap<HTMLElement, Component>;
    generation: number;
}

export function createKeyedState(): KeyedState {
    return { rows: new Map(), components: new WeakMap(), generation: 0 };
}

export function idle(cb: () => void): void {
    if (window.requestIdleCallback) window.requestIdleCallback(cb, { timeout: 120 });
    else window.setTimeout(cb, 16);
}

/** Releases every row's components (when the structure changes). */
export function resetKeyed(state: KeyedState, owner: Component): void {
    for (const list of state.rows.values()) for (const el of list) releaseRow(state, owner, el);
    state.rows = new Map();
    state.generation++;
}

function releaseRow(state: KeyedState, owner: Component, el: HTMLElement): void {
    const comp = state.components.get(el);
    if (comp) {
        owner.removeChild(comp);
        state.components.delete(el);
    }
}

/** Lazy per-row component: only created if the row needs the MarkdownRenderer. */
export function rowComponent(state: KeyedState, owner: Component, el: HTMLElement): () => Component {
    return () => {
        let comp = state.components.get(el);
        if (!comp) {
            comp = owner.addChild(new Component());
            state.components.set(el, comp);
        }
        return comp;
    };
}

export function renderKeyed<T>(
    parent: HTMLElement,
    items: T[],
    keys: string[],
    create: (item: T, index: number) => HTMLElement,
    state: KeyedState,
    owner: Component,
    chunkSize: number,
    onDone?: () => void
): void {
    const generation = ++state.generation;
    const previous = state.rows;
    const next = new Map<string, HTMLElement[]>();
    const elements = Array<HTMLElement | null>(items.length).fill(null);

    for (let i = 0; i < items.length; i++) {
        const pool = previous.get(keys[i]);
        const reused = pool && pool.length ? pool.pop()! : null;
        elements[i] = reused;
        if (reused) {
            const list = next.get(keys[i]);
            if (list) list.push(reused);
            else next.set(keys[i], [reused]);
        }
    }
    for (const pool of previous.values()) for (const el of pool) releaseRow(state, owner, el);
    state.rows = next;

    const materialize = (from: number, to: number): HTMLElement[] => {
        const out: HTMLElement[] = [];
        for (let i = from; i < to; i++) {
            let el = elements[i];
            if (!el) {
                el = elements[i] = create(items[i], i);
                const list = next.get(keys[i]);
                if (list) list.push(el);
                else next.set(keys[i], [el]);
            }
            out.push(el);
        }
        return out;
    };

    const size = Math.max(10, chunkSize);
    const first = Math.min(items.length, size);
    parent.replaceChildren(...materialize(0, first));

    let offset = first;
    const step = () => {
        if (state.generation !== generation) return;
        if (offset >= items.length) {
            onDone?.();
            return;
        }
        const end = Math.min(items.length, offset + size);
        parent.append(...materialize(offset, end));
        offset = end;
        idle(step);
    };
    if (offset < items.length) idle(step);
    else onDone?.();
}
