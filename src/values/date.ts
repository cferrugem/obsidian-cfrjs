/** Lightweight epoch-based date (local time zone). Replaces Luxon's DateTime. */
import { CDuration, MS_DAY } from "./duration";

let currentLocale = "en";
const monthNames = new Map<string, { long: string[]; short: string[] }>();
const weekdayNames = new Map<string, { long: string[]; short: string[] }>();

export function setLocale(locale: string | undefined): void {
    if (locale) currentLocale = locale;
}

export function getLocale(): string {
    return currentLocale;
}

function monthsFor(locale: string) {
    let names = monthNames.get(locale);
    if (!names) {
        const long = new Intl.DateTimeFormat(locale, { month: "long" });
        const short = new Intl.DateTimeFormat(locale, { month: "short" });
        names = { long: [], short: [] };
        for (let m = 0; m < 12; m++) {
            const d = new Date(2000, m, 1);
            names.long.push(long.format(d));
            names.short.push(short.format(d));
        }
        monthNames.set(locale, names);
    }
    return names;
}

function weekdaysFor(locale: string) {
    let names = weekdayNames.get(locale);
    if (!names) {
        const long = new Intl.DateTimeFormat(locale, { weekday: "long" });
        const short = new Intl.DateTimeFormat(locale, { weekday: "short" });
        names = { long: [], short: [] };
        // 2024-01-01 is a Monday; index 0 = Monday.
        for (let i = 0; i < 7; i++) {
            const d = new Date(2024, 0, 1 + i);
            names.long.push(long.format(d));
            names.short.push(short.format(d));
        }
        weekdayNames.set(locale, names);
    }
    return names;
}

export class CDate {
    private _d?: Date;

    constructor(public readonly ms: number, public readonly hasTime: boolean = false) {}

    static fromParts(y: number, m: number, d = 1, h = 0, mi = 0, s = 0, ms = 0, hasTime?: boolean): CDate {
        const time = new Date(y, m - 1, d, h, mi, s, ms).getTime();
        return new CDate(time, hasTime ?? (h !== 0 || mi !== 0 || s !== 0 || ms !== 0));
    }

    static fromJSDate(date: Date, hasTime = true): CDate {
        return new CDate(date.getTime(), hasTime);
    }

    static now(): CDate {
        return new CDate(Date.now(), true);
    }

    static today(): CDate {
        const n = new Date();
        return CDate.fromParts(n.getFullYear(), n.getMonth() + 1, n.getDate(), 0, 0, 0, 0, false);
    }

    private get d(): Date {
        return this._d ?? (this._d = new Date(this.ms));
    }

    get year(): number {
        return this.d.getFullYear();
    }
    get month(): number {
        return this.d.getMonth() + 1;
    }
    get day(): number {
        return this.d.getDate();
    }
    get hour(): number {
        return this.d.getHours();
    }
    get minute(): number {
        return this.d.getMinutes();
    }
    get second(): number {
        return this.d.getSeconds();
    }
    get millisecond(): number {
        return this.d.getMilliseconds();
    }
    /** 1 = Monday ... 7 = Sunday (ISO). */
    get weekday(): number {
        const w = this.d.getDay();
        return w === 0 ? 7 : w;
    }
    get weekNumber(): number {
        const target = new Date(this.year, this.month - 1, this.day);
        target.setDate(target.getDate() + 4 - this.weekday);
        const yearStart = new Date(target.getFullYear(), 0, 1);
        return Math.ceil(((target.getTime() - yearStart.getTime()) / MS_DAY + 1) / 7);
    }
    get quarter(): number {
        return Math.floor((this.month - 1) / 3) + 1;
    }

    valueOf(): number {
        return this.ms;
    }
    toMillis(): number {
        return this.ms;
    }
    toJSDate(): Date {
        return new Date(this.ms);
    }

    startOfDay(): CDate {
        return CDate.fromParts(this.year, this.month, this.day, 0, 0, 0, 0, false);
    }

    startOf(unit: "day" | "week" | "month" | "year"): CDate {
        switch (unit) {
            case "day":
                return this.startOfDay();
            case "week":
                return CDate.fromParts(this.year, this.month, this.day - (this.weekday - 1), 0, 0, 0, 0, false);
            case "month":
                return CDate.fromParts(this.year, this.month, 1, 0, 0, 0, 0, false);
            case "year":
                return CDate.fromParts(this.year, 1, 1, 0, 0, 0, 0, false);
        }
    }

    endOf(unit: "day" | "week" | "month" | "year"): CDate {
        switch (unit) {
            case "day":
                return CDate.fromParts(this.year, this.month, this.day, 23, 59, 59, 999, true);
            case "week":
                return CDate.fromParts(this.year, this.month, this.day + (7 - this.weekday), 23, 59, 59, 999, true);
            case "month":
                return CDate.fromParts(this.year, this.month + 1, 0, 23, 59, 59, 999, true);
            case "year":
                return CDate.fromParts(this.year, 12, 31, 23, 59, 59, 999, true);
        }
    }

    plus(dur: CDuration): CDate {
        let ms = this.ms;
        if (dur.months !== 0) {
            const d = new Date(ms);
            const day = d.getDate();
            d.setDate(1);
            d.setMonth(d.getMonth() + dur.months);
            const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
            d.setDate(Math.min(day, lastDay));
            ms = d.getTime();
        }
        ms += dur.ms;
        // Adding whole days keeps date-only values without a time.
        const keepsDate = !this.hasTime && dur.ms % MS_DAY === 0;
        if (keepsDate) {
            const d = new Date(ms);
            // Compensate for daylight saving time shifts.
            const fixed = new Date(d.getFullYear(), d.getMonth(), d.getDate() + (d.getHours() > 12 ? 1 : 0));
            return new CDate(fixed.getTime(), false);
        }
        return new CDate(ms, true);
    }

    minus(dur: CDuration): CDate {
        return this.plus(dur.negate());
    }

    /** Difference this - other as an exact duration. */
    diff(other: CDate): CDuration {
        return new CDuration(0, this.ms - other.ms);
    }

    toISODate(): string {
        return `${pad(this.year, 4)}-${pad(this.month, 2)}-${pad(this.day, 2)}`;
    }

    toISO(): string {
        if (!this.hasTime) return this.toISODate();
        return `${this.toISODate()}T${pad(this.hour, 2)}:${pad(this.minute, 2)}:${pad(this.second, 2)}`;
    }

    format(fmt: string, locale: string = currentLocale): string {
        return compileFormat(fmt)(this, locale);
    }

    /** Luxon-compatible alias. */
    toFormat(fmt: string): string {
        return this.format(fmt);
    }

    toString(): string {
        return this.toISO();
    }
}

function pad(n: number, width: number): string {
    const s = String(Math.abs(n));
    return (n < 0 ? "-" : "") + (s.length >= width ? s : "0".repeat(width - s.length) + s);
}

type FormatPart = (d: CDate, locale: string) => string;
const formatCache = new Map<string, (d: CDate, locale: string) => string>();
const FORMAT_TOKENS =
    /'([^']*)'|yyyy|yy|y|MMMM|MMM|MM|M|dd|d|EEEE|EEE|E|HH|H|hh|h|mm|m|ss|s|SSS|a|kkkk|WW|W|q/g;

/** Compiles a Luxon-style format once and reuses it (avoids re-parsing per cell). */
function compileFormat(fmt: string): (d: CDate, locale: string) => string {
    let cached = formatCache.get(fmt);
    if (cached) return cached;

    const parts: (FormatPart | string)[] = [];
    let last = 0;
    FORMAT_TOKENS.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FORMAT_TOKENS.exec(fmt))) {
        if (m.index > last) parts.push(fmt.slice(last, m.index));
        last = FORMAT_TOKENS.lastIndex;
        if (m[1] !== undefined) {
            parts.push(m[1]);
            continue;
        }
        parts.push(tokenFn(m[0]));
    }
    if (last < fmt.length) parts.push(fmt.slice(last));

    cached = (d, locale) => {
        let out = "";
        for (const p of parts) out += typeof p === "string" ? p : p(d, locale);
        return out;
    };
    if (formatCache.size > 200) formatCache.clear();
    formatCache.set(fmt, cached);
    return cached;
}

function tokenFn(token: string): FormatPart {
    switch (token) {
        case "yyyy":
            return d => pad(d.year, 4);
        case "yy":
            return d => pad(d.year % 100, 2);
        case "y":
            return d => String(d.year);
        case "MMMM":
            return (d, l) => monthsFor(l).long[d.month - 1];
        case "MMM":
            return (d, l) => monthsFor(l).short[d.month - 1];
        case "MM":
            return d => pad(d.month, 2);
        case "M":
            return d => String(d.month);
        case "dd":
            return d => pad(d.day, 2);
        case "d":
            return d => String(d.day);
        case "EEEE":
            return (d, l) => weekdaysFor(l).long[d.weekday - 1];
        case "EEE":
            return (d, l) => weekdaysFor(l).short[d.weekday - 1];
        case "E":
            return d => String(d.weekday);
        case "HH":
            return d => pad(d.hour, 2);
        case "H":
            return d => String(d.hour);
        case "hh":
            return d => pad(d.hour % 12 || 12, 2);
        case "h":
            return d => String(d.hour % 12 || 12);
        case "mm":
            return d => pad(d.minute, 2);
        case "m":
            return d => String(d.minute);
        case "ss":
            return d => pad(d.second, 2);
        case "s":
            return d => String(d.second);
        case "SSS":
            return d => pad(d.millisecond, 3);
        case "a":
            return d => (d.hour < 12 ? "AM" : "PM");
        case "kkkk":
            return d => pad(d.year, 4);
        case "WW":
            return d => pad(d.weekNumber, 2);
        case "W":
            return d => String(d.weekNumber);
        case "q":
            return d => String(d.quarter);
        default:
            return () => token;
    }
}

const ISO_RE =
    /^(\d{4})-(\d{2})(?:-(\d{2}))?(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?$/;

/** Fast ISO date parsing ("2024-05-01", "2024-05", "2024-05-01T10:30", optional time zone). */
export function parseISODate(text: string): CDate | null {
    const s = text.length > 40 ? "" : text.trim();
    if (s.length < 7) return null;
    const c = s.charCodeAt(0);
    if (c < 48 || c > 57) return null;

    const m = ISO_RE.exec(s);
    if (!m) return null;
    const year = +m[1];
    const month = +m[2];
    const day = m[3] ? +m[3] : 1;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    if (!m[4]) {
        const date = new Date(year, month - 1, day);
        if (date.getMonth() !== month - 1) return null;
        return new CDate(date.getTime(), false);
    }

    const hour = +m[4];
    const minute = +m[5];
    const second = m[6] ? +m[6] : 0;
    const millis = m[7] ? +m[7].slice(0, 3).padEnd(3, "0") : 0;
    if (hour > 23 || minute > 59 || second > 59) return null;

    const zone = m[8];
    if (!zone) return new CDate(new Date(year, month - 1, day, hour, minute, second, millis).getTime(), true);

    let offsetMin = 0;
    if (zone !== "Z") {
        const sign = zone[0] === "-" ? -1 : 1;
        const digits = zone.slice(1).replace(":", "");
        offsetMin = sign * (+digits.slice(0, 2) * 60 + (digits.length > 2 ? +digits.slice(2, 4) : 0));
    }
    return new CDate(Date.UTC(year, month - 1, day, hour, minute, second, millis) - offsetMin * 60000, true);
}

/** Keywords accepted by `date(...)`. */
export function parseDateKeyword(text: string): CDate | null {
    switch (text.trim().toLowerCase()) {
        case "today":
            return CDate.today();
        case "now":
            return CDate.now();
        case "tomorrow":
            return CDate.today().plus(new CDuration(0, MS_DAY));
        case "yesterday":
            return CDate.today().minus(new CDuration(0, MS_DAY));
        case "sow":
            return CDate.today().startOf("week");
        case "eow":
            return CDate.today().endOf("week");
        case "som":
            return CDate.today().startOf("month");
        case "eom":
            return CDate.today().endOf("month");
        case "soy":
            return CDate.today().startOf("year");
        case "eoy":
            return CDate.today().endOf("year");
        default:
            return null;
    }
}

const FILENAME_DATE_RE = /(\d{4})-(\d{2})-(\d{2})|(?:^|\D)(\d{4})(\d{2})(\d{2})(?:\D|$)/;

/** Extracts a date from a file name or text ("2024-05-01 Meeting", "20240501"). */
export function extractDate(text: string): CDate | null {
    const m = FILENAME_DATE_RE.exec(text);
    if (!m) return null;
    const y = +(m[1] ?? m[4]);
    const mo = +(m[2] ?? m[5]);
    const d = +(m[3] ?? m[6]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return CDate.fromParts(y, mo, d, 0, 0, 0, 0, false);
}

/** Parses with an explicit format (tokens yyyy, MM, dd, HH, mm, ss). */
export function parseDateWithFormat(text: string, fmt: string): CDate | null {
    const order: string[] = [];
    const pattern = fmt.replace(/'([^']*)'|yyyy|MM|M|dd|d|HH|H|mm|m|ss|s|[.*+?^${}()|[\]\\]/g, (tok: string, literal: string | undefined): string => {
        if (literal !== undefined) return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (tok.length === 1 && /[.*+?^${}()|[\]\\]/.test(tok)) return "\\" + tok;
        order.push(tok[0]);
        return tok === "yyyy" ? "(\\d{4})" : "(\\d{1,2})";
    });
    const m = new RegExp("^" + pattern + "$").exec(text.trim());
    if (!m) return null;
    const v: Record<string, number> = { y: 1970, M: 1, d: 1, H: 0, m: 0, s: 0 };
    order.forEach((k, i) => (v[k] = +m[i + 1]));
    return CDate.fromParts(v.y, v.M, v.d, v.H, v.m, v.s, 0, order.includes("H"));
}
