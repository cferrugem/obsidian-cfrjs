/** Web Worker entry point: receives batches of files and returns the parsed content data. */
import { parseCsvText } from "./csv";
import { parseContent } from "./parse-content";
import type { WorkerRequest, WorkerResponse } from "./worker-protocol";

export function handleRequest(msg: WorkerRequest): WorkerResponse {
    try {
        if (msg.kind === "csv") return { id: msg.id, kind: "csv", rows: parseCsvText(msg.text) };
        const results = msg.jobs.map(job => {
            try {
                return parseContent(job.content, job.meta);
            } catch {
                return null;
            }
        });
        return { id: msg.id, kind: "parse", results };
    } catch (e) {
        return { id: msg.id, kind: "error", message: String(e) };
    }
}

declare const self: { onmessage: ((e: MessageEvent) => void) | null; postMessage(msg: unknown): void } | undefined;

if (typeof self !== "undefined" && typeof (globalThis as any).document === "undefined") {
    self.onmessage = (e: MessageEvent) => self.postMessage(handleRequest(e.data as WorkerRequest));
}
