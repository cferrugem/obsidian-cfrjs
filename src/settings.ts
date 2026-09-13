export interface CfrSettings {
    /** Query code block keyword (```cfr). */
    queryKeyword: string;
    /** JavaScript code block keyword (```cfrjs). */
    jsKeyword: string;
    /** Also process ```dataview and ```dataviewjs blocks while Dataview is disabled. */
    registerDataviewAliases: boolean;

    inlineQueryPrefix: string;
    inlineJsQueryPrefix: string;
    enableInlineQueries: boolean;
    enableJs: boolean;
    enableInlineJs: boolean;
    enableLivePreviewInline: boolean;

    renderNullAs: string;
    dateFormat: string;
    dateTimeFormat: string;
    tableIdColumnName: string;
    tableGroupColumnName: string;
    showResultCount: boolean;
    warnOnEmptyResult: boolean;
    showTimings: boolean;

    refreshEnabled: boolean;
    /** Delay (ms) after changes before refreshing affected views. */
    refreshDelay: number;
    /** Rows rendered per chunk; the rest is rendered in the background. */
    renderChunkSize: number;
    /** Number of indexing workers (0 = automatic). */
    workers: number;

    taskCompletionTracking: boolean;
    taskCompletionUseEmoji: boolean;
    taskCompletionText: string;
    taskCompletionDateFormat: string;
}

export const DEFAULT_SETTINGS: CfrSettings = {
    queryKeyword: "cfr",
    jsKeyword: "cfrjs",
    registerDataviewAliases: false,

    inlineQueryPrefix: "=",
    inlineJsQueryPrefix: "$=",
    enableInlineQueries: true,
    enableJs: true,
    enableInlineJs: true,
    enableLivePreviewInline: true,

    renderNullAs: "-",
    dateFormat: "MMMM dd, yyyy",
    dateTimeFormat: "h:mm a - MMMM dd, yyyy",
    tableIdColumnName: "File",
    tableGroupColumnName: "Group",
    showResultCount: true,
    warnOnEmptyResult: true,
    showTimings: false,

    refreshEnabled: true,
    refreshDelay: 300,
    renderChunkSize: 200,
    workers: 0,

    taskCompletionTracking: false,
    taskCompletionUseEmoji: true,
    taskCompletionText: "completion",
    taskCompletionDateFormat: "yyyy-MM-dd",
};

/** Valid code block keywords. */
export const KEYWORD_RE = /^[A-Za-z0-9_-]+$/;

export function workerCount(settings: CfrSettings): number {
    if (settings.workers > 0) return Math.min(8, settings.workers);
    const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 2 : 2;
    return Math.max(1, Math.min(4, cores - 1));
}
