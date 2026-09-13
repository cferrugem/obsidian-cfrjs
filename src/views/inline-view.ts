/** Inline `= expression` queries in Reading view. */
import { MarkdownPostProcessorContext } from "obsidian";
import type CfrPlugin from "../main";
import { DepSet } from "../query/deps";
import { PreparedExpression } from "../query/execute";
import { parseExpression } from "../query/parser";
import { attachLinkHandlers, renderValue } from "../render/value";
import { CfrRenderChild } from "./base-view";
import { InlineJsView } from "./js-view";

export class InlineExprView extends CfrRenderChild {
    private prepared: PreparedExpression | null = null;

    constructor(plugin: CfrPlugin, target: HTMLElement, private readonly expression: string, sourcePath: string) {
        super(plugin, target, sourcePath);
        target.addClass("cfr-inline");
    }

    onload(): void {
        attachLinkHandlers(this.containerEl, this.rc);
        super.onload();
    }

    protected async render(deps: DepSet): Promise<void> {
        if (!this.prepared) this.prepared = new PreparedExpression(parseExpression(this.expression), this.plugin.index, this.sourcePath);
        const value = this.prepared.run(deps);
        this.containerEl.empty();
        renderValue(this.containerEl, value, this.rc, true);
    }

    protected onError(e: unknown): void {
        this.containerEl.empty();
        this.containerEl.createSpan({ cls: "cfr-error-inline", text: `cfrjs: ${e instanceof Error ? e.message : e}` });
    }
}

/** Post-processor: only inspects <code> elements instead of scanning whole paragraphs/cells. */
export function processInlineQueries(plugin: CfrPlugin, el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    const settings = plugin.settings;
    if (!settings.enableInlineQueries && !settings.enableInlineJs) return;
    const codes = el.getElementsByTagName("code");
    if (codes.length === 0) return;

    const jsPrefix = settings.inlineJsQueryPrefix;
    const prefix = settings.inlineQueryPrefix;
    for (const code of Array.from(codes)) {
        if (code.parentElement?.tagName === "PRE") continue;
        const text = code.textContent ?? "";
        if (jsPrefix && text.startsWith(jsPrefix)) {
            const script = text.slice(jsPrefix.length).trim();
            if (!script || !settings.enableInlineJs) continue;
            const span = createSpan();
            code.replaceWith(span);
            ctx.addChild(new InlineJsView(plugin, span, script, ctx.sourcePath));
        } else if (prefix && text.startsWith(prefix)) {
            const expression = text.slice(prefix.length).trim();
            if (!expression || !settings.enableInlineQueries) continue;
            const span = createSpan();
            code.replaceWith(span);
            ctx.addChild(new InlineExprView(plugin, span, expression, ctx.sourcePath));
        }
    }
}
