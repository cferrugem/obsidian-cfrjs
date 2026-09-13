/**
 * Central scheduler: receives change batches from the index and only marks views whose
 * dependencies were affected as dirty. Off-screen views refresh once they become visible.
 */
import { CfrSettings } from "../settings";
import { ChangeBatch, DepSet, isAffected } from "../query/deps";

export interface Refreshable {
    readonly deps: DepSet;
    /** Called when a relevant change happened. */
    invalidate(): void;
    /** Called by the IntersectionObserver. */
    setVisible?(visible: boolean): void;
}

export class Scheduler {
    private readonly views = new Set<Refreshable>();
    private readonly dirty = new Set<Refreshable>();
    private timer: number | null = null;
    private observer: IntersectionObserver | null = null;
    private readonly observed = new WeakMap<Element, Refreshable>();
    /** Diagnostic counters. */
    stats = { batches: 0, invalidations: 0, skipped: 0 };

    constructor(private readonly settings: CfrSettings) {
        if (typeof IntersectionObserver !== "undefined") {
            this.observer = new IntersectionObserver(entries => {
                for (const entry of entries) this.observed.get(entry.target)?.setVisible?.(entry.isIntersecting);
            });
        }
    }

    register(view: Refreshable): void {
        this.views.add(view);
    }

    unregister(view: Refreshable): void {
        this.views.delete(view);
        this.dirty.delete(view);
    }

    observe(el: Element, view: Refreshable): void {
        if (!this.observer) return;
        this.observed.set(el, view);
        this.observer.observe(el);
    }

    unobserve(el: Element): void {
        if (!this.observer) return;
        this.observer.unobserve(el);
        this.observed.delete(el);
    }

    onBatch(batch: ChangeBatch): void {
        this.stats.batches++;
        if (!batch.allPages && !this.settings.refreshEnabled) return;
        for (const view of this.views) {
            if (isAffected(view.deps, batch)) this.dirty.add(view);
            else this.stats.skipped++;
        }
        if (this.dirty.size === 0) return;
        if (this.timer !== null) window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => this.flush(), batch.allPages ? 0 : this.settings.refreshDelay);
    }

    private flush(): void {
        this.timer = null;
        const views = [...this.dirty];
        this.dirty.clear();
        for (const view of views) {
            if (!this.views.has(view)) continue;
            this.stats.invalidations++;
            try {
                view.invalidate();
            } catch (e) {
                console.error("cfrjs: error while refreshing a view", e);
            }
        }
    }

    destroy(): void {
        if (this.timer !== null) window.clearTimeout(this.timer);
        this.observer?.disconnect();
        this.views.clear();
        this.dirty.clear();
    }
}
