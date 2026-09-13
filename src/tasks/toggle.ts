/** Checks/unchecks tasks directly in the file, atomically (vault.process). */
import { App, Notice, TFile } from "obsidian";
import { CfrSettings } from "../settings";
import { Row } from "../values/types";
import { toggleLine } from "./toggle-line";

export async function toggleTask(app: App, settings: CfrSettings, item: Row, checked: boolean): Promise<void> {
    const path = typeof item.path === "string" ? item.path : "";
    const lineNumber = typeof item.line === "number" ? item.line : -1;
    const file = app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
        new Notice(`cfrjs: file not found: ${path}`);
        return;
    }
    const firstLine = (typeof item.text === "string" ? item.text : "").split("\n")[0].trim();
    let applied = false;

    await app.vault.process(file, data => {
        const lines = data.split("\n");
        const line = lineNumber >= 0 ? lines[lineNumber] : undefined;
        // Make sure the line is still the same task before editing it.
        if (line === undefined || (firstLine && !line.includes(firstLine.slice(0, 64)))) return data;
        const updated = toggleLine(line, checked, settings);
        if (updated === null) return data;
        lines[lineNumber] = updated;
        applied = true;
        return lines.join("\n");
    });

    if (!applied) new Notice("The task changed in the file; the view will refresh, please try again.");
}
