/** View base class: scheduler registration, visibility tracking and refresh coalescing. */
import { MarkdownRenderChild } from "obsidian";
import type CfrPlugin from "../main";
import { DepSet } from "../query/deps";
import { renderError, RenderContext } from "../render/value";
import { Refreshable } from "./scheduler";

export abstract class CfrRenderChild extends MarkdownRenderChild implements Refreshable {
    deps = new DepSet();
    private visible = true;
    private stale = false;
    private running = false;
    private rerun = false;
    private frame = 0;

    constructor(readonly plugin: CfrPlugin, containerEl: HTMLElement, readonly sourcePath: string) {
        super(containerEl);
    }

    protected get rc(): RenderContext {
        return {
            app: this.plugin.app,
            settings: this.plugin.settings,
            sourcePath: this.sourcePath,
            component: this,
        };
    }

    onload(): void {
        this.plugin.scheduler.register(this);
        this.plugin.scheduler.observe(this.containerEl, this);
        void this.refresh();
    }

    onunload(): void {
        this.plugin.scheduler.unregister(this);
        this.plugin.scheduler.unobserve(this.containerEl);
        if (this.frame) window.cancelAnimationFrame(this.frame);
        this.frame = 0;
    }

    setVisible(visible: boolean): void {
        this.visible = visible;
        if (visible && this.stale) this.queue();
    }

    invalidate(): void {
        if (this.visible) this.queue();
        else this.stale = true;
    }

    private queue(): void {
        if (this.frame) return;
        this.frame = window.requestAnimationFrame(() => {
            this.frame = 0;
            void this.refresh();
        });
    }

    async refresh(): Promise<void> {
        if (this.running) {
            this.rerun = true;
            return;
        }
        this.running = true;
        this.stale = false;
        const deps = new DepSet();
        try {
            await this.render(deps);
        } catch (e) {
            this.onError(e);
        } finally {
            this.deps = deps;
            this.running = false;
            if (this.rerun) {
                this.rerun = false;
                this.queue();
            }
        }
    }

    protected onError(e: unknown): void {
        this.containerEl.empty();
        const message = e instanceof Error ? (e.name === "QueryError" ? e.message : e.stack ?? e.message) : String(e);
        renderError(this.containerEl, `cfrjs: ${message}`);
    }

    protected abstract render(deps: DepSet): Promise<void>;
}
