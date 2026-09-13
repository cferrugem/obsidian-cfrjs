/** Small, fast CSV parser (quotes, CRLF, comma/semicolon/tab detection). */

function detectDelimiter(text: string): string {
    const end = text.indexOf("\n");
    const header = end >= 0 ? text.slice(0, end) : text;
    let best = ",";
    let bestCount = 0;
    for (const d of [",", ";", "\t"]) {
        const count = header.split(d).length - 1;
        if (count > bestCount) {
            best = d;
            bestCount = count;
        }
    }
    return best;
}

export function parseCsvText(text: string): string[][] {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const delim = detectDelimiter(text);
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;
    const n = text.length;

    for (let i = 0; i < n; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i++;
                } else inQuotes = false;
            } else field += c;
            continue;
        }
        if (c === '"' && field.length === 0) inQuotes = true;
        else if (c === delim) {
            row.push(field);
            field = "";
        } else if (c === "\n" || c === "\r") {
            if (c === "\r" && text[i + 1] === "\n") i++;
            row.push(field);
            field = "";
            if (row.length > 1 || row[0] !== "") rows.push(row);
            row = [];
        } else field += c;
    }
    if (field.length > 0 || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}
