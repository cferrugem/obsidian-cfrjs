/** Checks/unchecks tasks directly in the file, atomically (vault.process). */
import { App, Notice, TFile } from "obsidian";
import { CfrSettings } from "../settings";
import { toggleLine } from "./toggle-line";

export async function toggleTask(app: App, settings: CfrSettings, item: Record<string, any>, checked: boolean): Promise<void> {
    const file = app.vault.getAbstractFileByPath(item.path);
    if (!(file instanceof TFile)) {
        new Notice(`cfrjs: file not found: ${item.path}`);
        return;
    }
    const firstLine = String(item.text ?? "").split("\n")[0].trim();
    let applied = false;

    await app.vault.process(file, data => {
        const lines = data.split("\n");
        const line = lines[item.line];
        // Make sure the line is still the same task before editing it.
        if (line === undefined || (firstLine && !line.includes(firstLine.slice(0, 64)))) return data;
        const updated = toggleLine(line, checked, settings);
        if (updated === null) return data;
        lines[item.line] = updated;
        applied = true;
        return lines.join("\n");
    });

    if (!applied) new Notice("cfrjs: the task changed in the file; the view will refresh, please try again.");
}
