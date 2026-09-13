import { describe, expect, it } from "vitest";
import { toggleLine } from "../src/tasks/toggle-line";
import { CDate } from "../src/values/date";

const base = { taskCompletionTracking: false, taskCompletionUseEmoji: true, taskCompletionText: "completion", taskCompletionDateFormat: "yyyy-MM-dd" };
const today = CDate.fromParts(2024, 5, 6);

describe("toggleLine", () => {
    it("checks and unchecks while preserving indentation and CRLF", () => {
        expect(toggleLine("    - [ ] do it\r", true, base)).toBe("    - [x] do it\r");
        expect(toggleLine("> 1. [x] done", false, base)).toBe("> 1. [ ] done");
        expect(toggleLine("- not a task", true, base)).toBeNull();
    });

    it("adds and removes the completion date", () => {
        const emoji = { ...base, taskCompletionTracking: true };
        expect(toggleLine("- [ ] a", true, emoji, today)).toBe("- [x] a ✅ 2024-05-06");
        expect(toggleLine("- [x] a ✅ 2024-05-06", false, emoji, today)).toBe("- [ ] a");
        const field = { ...emoji, taskCompletionUseEmoji: false };
        expect(toggleLine("- [ ] a", true, field, today)).toBe("- [x] a [completion:: 2024-05-06]");
        expect(toggleLine("- [x] a [completion:: 2024-05-06]", false, field, today)).toBe("- [ ] a");
    });
});
