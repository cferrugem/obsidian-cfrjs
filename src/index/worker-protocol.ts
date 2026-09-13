import type { ContentData, ParseMeta } from "./parse-content";

export interface ParseJob {
    content: string;
    meta: ParseMeta;
}

export type WorkerRequest = { id: number; kind: "parse"; jobs: ParseJob[] } | { id: number; kind: "csv"; text: string };

export type WorkerResponse =
    | { id: number; kind: "parse"; results: (ContentData | null)[] }
    | { id: number; kind: "csv"; rows: string[][] }
    | { id: number; kind: "error"; message: string };
