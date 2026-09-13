/**
 * Web Worker pool with an O(1) queue (head index, no Array.shift) and batches of files per message.
 * If Workers are unavailable, it runs on the main thread, yielding between batches.
 */
import type { WorkerRequest, WorkerResponse } from "./worker-protocol";

type Pending = {
    msg: WorkerRequest;
    resolve: (r: WorkerResponse) => void;
    reject: (e: unknown) => void;
};

interface Slot {
    worker: Worker;
    task: Pending | null;
}

export class WorkerPool {
    private slots: Slot[] = [];
    private queue: (Pending | undefined)[] = [];
    private head = 0;
    private nextId = 1;
    private url: string | null = null;

    constructor(code: string, size: number, private readonly fallback: (msg: WorkerRequest) => WorkerResponse) {
        if (typeof Worker === "undefined" || size <= 0) return;
        try {
            this.url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
            for (let i = 0; i < size; i++) {
                const worker = new Worker(this.url, { name: `cfrjs-indexer-${i + 1}` });
                const slot: Slot = { worker, task: null };
                worker.onmessage = e => this.finish(slot, e.data as WorkerResponse);
                worker.onerror = e => {
                    const task = slot.task;
                    slot.task = null;
                    task?.reject(e.message ?? e);
                    this.dispatch();
                };
                this.slots.push(slot);
            }
        } catch (e) {
            console.warn("cfrjs: Web Workers unavailable, falling back to the main thread.", e);
            this.terminate();
        }
    }

    get size(): number {
        return this.slots.length;
    }

    run<K extends WorkerRequest["kind"]>(
        msg: K extends "parse" ? Omit<Extract<WorkerRequest, { kind: "parse" }>, "id"> : Omit<Extract<WorkerRequest, { kind: "csv" }>, "id">
    ): Promise<WorkerResponse> {
        const full = { ...msg, id: this.nextId++ };
        if (this.slots.length === 0) {
            // Yield before processing so the UI does not freeze.
            return new Promise(resolve => window.setTimeout(() => resolve(this.fallback(full)), 0));
        }
        return new Promise((resolve, reject) => {
            this.queue.push({ msg: full, resolve, reject });
            this.dispatch();
        });
    }

    private dispatch(): void {
        for (const slot of this.slots) {
            if (slot.task) continue;
            if (this.head >= this.queue.length) break;
            const task = this.queue[this.head]!;
            this.queue[this.head++] = undefined;
            if (this.head > 1024 && this.head * 2 > this.queue.length) {
                this.queue = this.queue.slice(this.head);
                this.head = 0;
            }
            slot.task = task;
            slot.worker.postMessage(task.msg);
        }
    }

    private finish(slot: Slot, response: WorkerResponse): void {
        const task = slot.task;
        slot.task = null;
        if (task) {
            if (response.kind === "error") task.reject(new Error(response.message));
            else task.resolve(response);
        }
        this.dispatch();
    }

    terminate(): void {
        for (const slot of this.slots) {
            slot.worker.terminate();
            slot.task?.reject(new Error("worker pool terminated"));
        }
        for (let i = this.head; i < this.queue.length; i++) this.queue[i]?.reject(new Error("worker pool terminated"));
        this.slots = [];
        this.queue = [];
        this.head = 0;
        if (this.url) URL.revokeObjectURL(this.url);
        this.url = null;
    }
}
