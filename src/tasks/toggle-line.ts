/** Pure task toggling logic (no Obsidian dependency, testable). */
import { CDate } from "../values/date";

export interface CompletionSettings {
    taskCompletionTracking: boolean;
    taskCompletionUseEmoji: boolean;
    taskCompletionText: string;
    taskCompletionDateFormat: string;
}

const TASK_LINE = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)(.)(\].*)$/;
const EMOJI_COMPLETION = /\s*✅\s*\d{4}-\d{2}-\d{2}/u;

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Returns the line with the task checked/unchecked, or null if it is not a task. */
export function toggleLine(line: string, checked: boolean, settings: CompletionSettings, today: CDate = CDate.today()): string | null {
    const cr = line.endsWith("\r") ? "\r" : "";
    const body = cr ? line.slice(0, -1) : line;
    const m = TASK_LINE.exec(body);
    if (!m) return null;

    let rest = m[3];
    if (settings.taskCompletionTracking) {
        const fieldRe = new RegExp(`\\s*\\[${escapeRegex(settings.taskCompletionText)}::[^\\]]*\\]`);
        rest = rest.replace(EMOJI_COMPLETION, "").replace(fieldRe, "");
        if (checked) {
            rest = settings.taskCompletionUseEmoji
                ? `${rest.trimEnd()} ✅ ${today.format("yyyy-MM-dd")}`
                : `${rest.trimEnd()} [${settings.taskCompletionText}:: ${today.format(settings.taskCompletionDateFormat)}]`;
        }
    }
    return m[1] + (checked ? "x" : " ") + rest + cr;
}
