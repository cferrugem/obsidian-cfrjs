/**
 * Renders values directly into the DOM. The (async, expensive) MarkdownRenderer is only used
 * when the text actually contains Markdown syntax.
 */
import { App, Component, Keymap, MarkdownRenderer } from "obsidian";
import { CfrSettings } from "../settings";
import { CDate } from "../values/date";
import { CDuration } from "../values/duration";
import { Link } from "../values/link";
import { formatDate, hasCustomToString, isWidget } from "../values/types";

export interface RenderContext {
    app: App;
    settings: CfrSettings;
    sourcePath: string;
    /** Owner of the components created by the MarkdownRenderer (accessed only when needed). */
    readonly component: Component;
}

const MARKDOWN_HINT = /[*_`~=[\]<>#$\\|!^]|https?:|www\.|^\s*(?:[-+>]|\d+[.)])\s|\n/;
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "avif", "tif", "tiff"]);
const MAX_DEPTH = 6;

export function needsMarkdown(text: string): boolean {
    return MARKDOWN_HINT.test(text);
}

export async function renderMarkdown(el: HTMLElement, markdown: string, rc: RenderContext, inline = true): Promise<void> {
    await MarkdownRenderer.render(rc.app, markdown, el, rc.sourcePath, rc.component);
    if (!inline) return;
    // Unwrap the <p> the renderer creates for inline content.
    if (el.childElementCount === 1 && el.firstElementChild!.tagName === "P") {
        const p = el.firstElementChild!;
        p.replaceWith(...Array.from(p.childNodes));
    }
}

function renderText(parent: HTMLElement, text: string, rc: RenderContext): void {
    if (needsMarkdown(text)) {
        const span = parent.createSpan({ cls: "cfr-md" });
        void renderMarkdown(span, text, rc);
    } else {
        parent.appendText(text);
    }
}

export function renderLink(parent: HTMLElement, link: Link, rc: RenderContext): void {
    if (link.embed) {
        const ext = link.path.slice(link.path.lastIndexOf(".") + 1).toLowerCase();
        const file = rc.app.metadataCache.getFirstLinkpathDest(link.path, rc.sourcePath);
        if (file && IMAGE_EXT.has(ext)) {
            const img = parent.createEl("img", { attr: { src: rc.app.vault.getResourcePath(file), alt: link.path } });
            const size = /^(\d+)(?:x(\d+))?$/.exec(link.display ?? "");
            if (size) {
                img.setAttr("width", size[1]);
                if (size[2]) img.setAttr("height", size[2]);
            }
            return;
        }
        const span = parent.createSpan({ cls: "cfr-md" });
        void renderMarkdown(span, link.markdown(), rc, false);
        return;
    }

    const target = link.obsidianLink();
    const a = parent.createEl("a", {
        cls: "internal-link",
        text: link.displayText(),
        attr: { "data-href": target, href: target, target: "_blank", rel: "noopener" },
    });
    if (!rc.app.metadataCache.getFirstLinkpathDest(link.path, rc.sourcePath)) a.addClass("is-unresolved");
}

export function renderValue(parent: HTMLElement, value: unknown, rc: RenderContext, inline = true, depth = 0): void {
    if (value === null || value === undefined) {
        renderText(parent, rc.settings.renderNullAs, rc);
        return;
    }
    switch (typeof value) {
        case "string":
            renderText(parent, value, rc);
            return;
        case "number":
        case "boolean":
        case "bigint":
            parent.appendText(String(value));
            return;
        case "function":
            parent.appendText("<function>");
            return;
    }

    if (depth > MAX_DEPTH) {
        parent.appendText("…");
        return;
    }
    if (value instanceof Link) return renderLink(parent, value, rc);
    if (value instanceof CDate) {
        parent.appendText(formatDate(value));
        return;
    }
    if (value instanceof CDuration) {
        parent.appendText(value.toHuman());
        return;
    }
    if (value instanceof HTMLElement) {
        parent.appendChild(value);
        return;
    }

    if (Array.isArray(value)) {
        if (value.length === 0) {
            if (!inline) parent.appendText(rc.settings.renderNullAs);
            return;
        }
        if (inline || value.length === 1) {
            const span = parent.createSpan({ cls: "cfr-list-inline" });
            value.forEach((v, i) => {
                if (i > 0) span.appendText(", ");
                renderValue(span, v, rc, true, depth + 1);
            });
            return;
        }
        const ul = parent.createEl("ul", { cls: "cfr-list" });
        for (const v of value) renderValue(ul.createEl("li"), v, rc, true, depth + 1);
        return;
    }

    if (isWidget(value)) {
        if (value.$widget === "listpair") {
            renderValue(parent, value.key, rc, true, depth + 1);
            parent.appendText(": ");
            renderValue(parent, value.value, rc, true, depth + 1);
        } else {
            parent.createEl("a", { cls: "external-link", text: value.display ?? value.url, attr: { href: value.url, rel: "noopener", target: "_blank" } });
        }
        return;
    }

    const obj = value as Record<string, unknown>;
    if (hasCustomToString(obj)) {
        const link = (obj as any).link;
        if (link instanceof Link) renderLink(parent, link, rc);
        else parent.appendText(String(obj));
        return;
    }

    const entries = Object.entries(obj);
    if (entries.length === 0) return;
    if (inline) {
        entries.forEach(([k, v], i) => {
            if (i > 0) parent.appendText(", ");
            parent.appendText(k + ": ");
            renderValue(parent, v, rc, true, depth + 1);
        });
        return;
    }
    const ul = parent.createEl("ul", { cls: "cfr-object" });
    for (const [k, v] of entries) {
        const li = ul.createEl("li");
        li.appendText(k + ": ");
        renderValue(li, v, rc, true, depth + 1);
    }
}

/** A single listener per container for link clicks and hovers (event delegation). */
export function attachLinkHandlers(container: HTMLElement, rc: Omit<RenderContext, "component">): void {
    const hoverParent = { hoverPopover: null };
    const findLink = (evt: Event): HTMLAnchorElement | null => {
        const target = evt.target as HTMLElement | null;
        const a = target?.closest?.("a.internal-link") as HTMLAnchorElement | null;
        return a && container.contains(a) ? a : null;
    };
    const open = (evt: MouseEvent, newLeaf: boolean) => {
        const a = findLink(evt);
        if (!a) return;
        evt.preventDefault();
        evt.stopPropagation();
        const href = a.dataset.href ?? a.getAttribute("href") ?? "";
        void rc.app.workspace.openLinkText(href, rc.sourcePath, newLeaf || Keymap.isModEvent(evt));
    };
    container.addEventListener("click", evt => open(evt, false));
    container.addEventListener("auxclick", evt => {
        if (evt.button === 1) open(evt, true);
    });
    container.addEventListener("mouseover", evt => {
        const a = findLink(evt);
        if (!a) return;
        rc.app.workspace.trigger("hover-link", {
            event: evt,
            source: "preview",
            hoverParent,
            targetEl: a,
            linktext: a.dataset.href ?? a.getAttribute("href") ?? "",
            sourcePath: rc.sourcePath,
        });
    });
}

export function renderError(container: HTMLElement, message: string): void {
    container.createEl("pre", { cls: "cfr-error", text: message });
}
