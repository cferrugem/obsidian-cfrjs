/**
 * Access to undocumented Obsidian internals, isolated in one module.
 * Every accessor is defensive: if Obsidian changes these internals, the related feature
 * degrades gracefully (for example `file.starred` becomes false) instead of throwing.
 */
import { App, EventRef } from "obsidian";

export interface BookmarkItem {
    type: string;
    path?: string;
    items?: BookmarkItem[];
}

export interface BookmarksInstance {
    items?: BookmarkItem[];
    on?(name: "changed", callback: () => void): EventRef;
}

interface AppInternals {
    appId?: string;
    plugins?: { enabledPlugins?: Set<string> };
    internalPlugins?: { plugins?: { bookmarks?: { instance?: BookmarksInstance } } };
}

function internals(app: App): AppInternals {
    return app as unknown as AppInternals;
}

/** Vault-specific identifier, used to namespace the persistent cache. */
export function getAppId(app: App): string {
    return internals(app).appId ?? "shared";
}

/** Whether a community plugin is enabled (used to avoid clashing with Dataview's code blocks). */
export function isCommunityPluginEnabled(app: App, id: string): boolean {
    return internals(app).plugins?.enabledPlugins?.has(id) ?? false;
}

/** The core Bookmarks plugin instance, if available. */
export function getBookmarks(app: App): BookmarksInstance | null {
    return internals(app).internalPlugins?.plugins?.bookmarks?.instance ?? null;
}
