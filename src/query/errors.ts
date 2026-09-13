export class QueryError extends Error {
    constructor(message: string, public readonly pos?: number) {
        super(message);
        this.name = "QueryError";
    }
}

/** Converts an absolute position into "line X, column Y". */
export function describePosition(source: string, pos: number): string {
    let line = 1;
    let col = 1;
    for (let i = 0; i < pos && i < source.length; i++) {
        if (source.charCodeAt(i) === 10) {
            line++;
            col = 1;
        } else col++;
    }
    return `line ${line}, column ${col}`;
}

/** Message of an unknown thrown value. */
export function errorMessage(e: unknown): string {
    if (e instanceof Error) return e.message;
    return typeof e === "string" ? e : JSON.stringify(e) ?? "Unknown error";
}
