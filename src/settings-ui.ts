/**
 * Turns setting definitions into DOM.
 *
 * Two independent concerns live here so `settings-tab.ts` stays a list of settings:
 * builders for rich descriptions, and a renderer for Obsidian versions older than
 * 1.13, which cannot render `getSettingDefinitions()` on their own.
 */
import { Setting, SettingDefinition, SettingDefinitionItem } from "obsidian";

/** A piece of a description: plain text, or an element built by one of the helpers below. */
export type DescPart = string | ((parent: DocumentFragment | HTMLElement) => void);

/** Inline code, for keywords, prefixes and snippets (`cfr`, `$=`, `✅ 2026-09-20`). */
export function code(text: string): DescPart {
    return parent => parent.createEl("code", { text, cls: "cfr-setting-code" });
}

/** Emphasised text, used for the live previews next to format settings. */
export function strong(text: string): DescPart {
    return parent => parent.createEl("strong", { text });
}

/** External link. */
export function link(text: string, href: string): DescPart {
    return parent => parent.createEl("a", { text, href });
}

/** A line break inside a description. */
export function br(): DescPart {
    return parent => parent.createEl("br");
}

/** Builds a description fragment. Plain strings are inserted as text, never as HTML. */
export function desc(...parts: DescPart[]): DocumentFragment {
    return createFragment(frag => {
        for (const part of parts) {
            if (typeof part === "string") frag.appendText(part);
            else part(frag);
        }
    });
}

/**
 * The part of a setting tab this module needs: value access and a way to re-render.
 * `CfrSettingTab` implements all three regardless of the Obsidian version, which keeps
 * the legacy renderer working where `SettingTab` itself has none of them.
 */
export interface DefinitionHost {
    getControlValue(key: string): unknown;
    setControlValue(key: string, value: unknown): void | Promise<void>;
    display(): void;
}

/** `SettingTab` members added in Obsidian 1.13 and absent on the versions this module serves. */
interface ModernSettingTab {
    update(): void;
    refreshDomState(): void;
}

/**
 * Calls a setting tab method that only exists on Obsidian 1.13 and later.
 * Returns false when the running version does not provide it, so the caller can fall back.
 */
export function callIfSupported(tab: unknown, method: keyof ModernSettingTab): boolean {
    const fn = (tab as Partial<ModernSettingTab>)[method];
    if (typeof fn !== "function") return false;
    fn.call(tab);
    return true;
}

/** Stringifies a stored control value, ignoring shapes a text input cannot represent. */
function str(value: unknown, fallback = ""): string {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return value.toString();
    return fallback;
}

function resolve(value: boolean | (() => boolean) | undefined, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    return typeof value === "function" ? value() : value;
}

/**
 * Renders setting definitions imperatively, for Obsidian < 1.13 where
 * `getSettingDefinitions()` is ignored and `display()` is the only entry point.
 *
 * Definitions stay the single source of truth: values are read and written through the
 * tab's own `getControlValue`/`setControlValue`, so both paths persist identically.
 * `visible` and `disabled` are evaluated once per render; toggling a checkbox re-renders
 * the tab so dependent rows update (a toggle holds no text cursor, so nothing is lost).
 */
export function renderDefinitions(containerEl: HTMLElement, items: SettingDefinitionItem[], tab: DefinitionHost): void {
    for (const item of items) {
        if (!resolve((item as { visible?: boolean | (() => boolean) }).visible, true)) continue;

        if ("type" in item && (item.type === "group" || item.type === "list")) {
            if (item.heading) new Setting(containerEl).setName(item.heading).setHeading();
            renderDefinitions(containerEl, item.items ?? [], tab);
            continue;
        }
        if ("type" in item && item.type === "page") {
            if (item.name) new Setting(containerEl).setName(item.name).setHeading();
            renderDefinitions(containerEl, item.items ?? [], tab);
            continue;
        }
        renderSetting(containerEl, item as SettingDefinition, tab);
    }
}

function renderSetting(containerEl: HTMLElement, def: SettingDefinition, tab: DefinitionHost): void {
    const setting = new Setting(containerEl).setName(def.name);
    if (def.desc) setting.setDesc(def.desc);

    const disabled = resolve("disabled" in def ? def.disabled : undefined, false);
    const rerender = () => tab.display();
    const save = (key: string, value: unknown) => void tab.setControlValue(key, value);

    if (def.render) {
        def.render(setting, undefined as never);
        return;
    }
    if (def.action) {
        const action = def.action;
        setting.addButton(b => b.setButtonText(def.name).setDisabled(disabled).onClick(() => action(setting.settingEl, 0)));
        return;
    }
    if (!def.control) return;

    const control = def.control;
    const current = tab.getControlValue(control.key) ?? control.defaultValue;

    switch (control.type) {
        case "toggle":
            setting.addToggle(t =>
                t
                    .setValue(current as boolean)
                    .setDisabled(disabled)
                    .onChange(v => {
                        save(control.key, v);
                        rerender();
                    })
            );
            break;
        case "dropdown":
            setting.addDropdown(d =>
                d
                    .addOptions(control.options)
                    .setValue(str(current))
                    .setDisabled(disabled)
                    .onChange(v => save(control.key, v))
            );
            break;
        case "slider":
            setting.addSlider(s =>
                s
                    .setLimits(control.min, control.max, control.step)
                    .setValue(Number(str(current, String(control.min))))
                    .setDisabled(disabled)
                    .onChange(v => save(control.key, v))
            );
            break;
        case "number":
            setting.addText(t =>
                t
                    .setPlaceholder(control.placeholder ?? str(control.defaultValue))
                    .setValue(str(current))
                    .setDisabled(disabled)
                    .onChange(v => {
                        const n = Number.parseInt(v, 10);
                        if (Number.isNaN(n)) return;
                        const min = control.min ?? Number.NEGATIVE_INFINITY;
                        const max = control.max ?? Number.POSITIVE_INFINITY;
                        save(control.key, Math.min(max, Math.max(min, n)));
                    })
            );
            break;
        case "textarea":
            setting.addTextArea(t =>
                t
                    .setPlaceholder(control.placeholder ?? "")
                    .setValue(str(current))
                    .setDisabled(disabled)
                    .onChange(v => saveValidated(control, v, save, setting, def))
            );
            break;
        default:
            setting.addText(t =>
                t
                    .setPlaceholder(("placeholder" in control ? control.placeholder : undefined) ?? str(control.defaultValue))
                    .setValue(str(current))
                    .setDisabled(disabled)
                    .onChange(v => saveValidated(control, v, save, setting, def))
            );
    }
}

/** Runs a text control's `validate` and shows the message inline instead of saving. */
function saveValidated(
    control: { key: string; validate?: (value: never) => string | void | Promise<string | void> },
    value: string,
    save: (key: string, value: unknown) => void,
    setting: Setting,
    def: SettingDefinition
): void {
    const error = control.validate?.(value as never);
    if (error instanceof Promise) {
        void error.then(message => applyValidation(message, setting, def, () => save(control.key, value)));
        return;
    }
    applyValidation(error, setting, def, () => save(control.key, value));
}

function applyValidation(message: string | void, setting: Setting, def: SettingDefinition, save: () => void): void {
    if (message) {
        setting.setDesc(`⚠ ${message} (not saved)`);
        return;
    }
    setting.setDesc(def.desc ?? "");
    save();
}
