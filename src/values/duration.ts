/** Lightweight duration: calendar months + exact milliseconds. Replaces Luxon's Duration. */
export const MS_SECOND = 1000;
export const MS_MINUTE = 60 * MS_SECOND;
export const MS_HOUR = 60 * MS_MINUTE;
export const MS_DAY = 24 * MS_HOUR;
export const MS_WEEK = 7 * MS_DAY;
/** Approximation used only to compare/convert months into exact units. */
export const MS_MONTH_APPROX = 30 * MS_DAY;

export type DurationUnit =
    | "years"
    | "months"
    | "weeks"
    | "days"
    | "hours"
    | "minutes"
    | "seconds"
    | "milliseconds";

export class CDuration {
    constructor(public readonly months: number, public readonly ms: number) {}

    static of(parts: Partial<Record<DurationUnit, number>>): CDuration {
        const months = (parts.years ?? 0) * 12 + (parts.months ?? 0);
        const ms =
            (parts.weeks ?? 0) * MS_WEEK +
            (parts.days ?? 0) * MS_DAY +
            (parts.hours ?? 0) * MS_HOUR +
            (parts.minutes ?? 0) * MS_MINUTE +
            (parts.seconds ?? 0) * MS_SECOND +
            (parts.milliseconds ?? 0);
        return new CDuration(months, ms);
    }

    /** Approximate total in milliseconds (a month counts as 30 days). */
    approxMs(): number {
        return this.months * MS_MONTH_APPROX + this.ms;
    }

    valueOf(): number {
        return this.approxMs();
    }

    plus(other: CDuration): CDuration {
        return new CDuration(this.months + other.months, this.ms + other.ms);
    }

    minus(other: CDuration): CDuration {
        return new CDuration(this.months - other.months, this.ms - other.ms);
    }

    times(factor: number): CDuration {
        return new CDuration(this.months * factor, this.ms * factor);
    }

    negate(): CDuration {
        return new CDuration(-this.months, -this.ms);
    }

    /** Total in the requested unit (equivalent to Luxon's `shiftTo(unit)`). */
    as(unit: string): number | null {
        switch (unit) {
            case "year":
            case "years":
                return this.months / 12 + this.ms / (365 * MS_DAY);
            case "month":
            case "months":
                return this.months + this.ms / MS_MONTH_APPROX;
            case "week":
            case "weeks":
                return this.approxMs() / MS_WEEK;
            case "day":
            case "days":
                return this.approxMs() / MS_DAY;
            case "hour":
            case "hours":
                return this.approxMs() / MS_HOUR;
            case "minute":
            case "minutes":
                return this.approxMs() / MS_MINUTE;
            case "second":
            case "seconds":
                return this.approxMs() / MS_SECOND;
            case "millisecond":
            case "milliseconds":
                return this.approxMs();
            default:
                return null;
        }
    }

    // Getters compatible with common Luxon usage in scripts (dur.days etc.).
    get years(): number {
        return this.as("years")!;
    }
    get days(): number {
        return this.as("days")!;
    }
    get hours(): number {
        return this.as("hours")!;
    }
    get minutes(): number {
        return this.as("minutes")!;
    }
    get seconds(): number {
        return this.as("seconds")!;
    }

    toMillis(): number {
        return this.approxMs();
    }

    /** Human-readable format: "1 year, 2 months, 3 days". */
    toHuman(): string {
        const parts: string[] = [];
        const sign = this.approxMs() < 0 ? "-" : "";
        let months = Math.abs(this.months);
        let ms = Math.abs(this.ms);

        const years = Math.floor(months / 12);
        months -= years * 12;
        const days = Math.floor(ms / MS_DAY);
        ms -= days * MS_DAY;
        const hours = Math.floor(ms / MS_HOUR);
        ms -= hours * MS_HOUR;
        const minutes = Math.floor(ms / MS_MINUTE);
        ms -= minutes * MS_MINUTE;
        const seconds = Math.floor(ms / MS_SECOND);
        ms -= seconds * MS_SECOND;

        const push = (n: number, unit: string) => {
            if (n) parts.push(`${n} ${unit}${n === 1 ? "" : "s"}`);
        };
        push(years, "year");
        push(months, "month");
        push(days, "day");
        push(hours, "hour");
        push(minutes, "minute");
        push(seconds, "second");
        if (parts.length === 0) return ms ? `${sign}${Math.round(ms)} milliseconds` : "0 seconds";
        return sign + parts.join(", ");
    }

    /** Formats with the tokens y M w d h m s S, with literals in single quotes. */
    format(fmt: string): string {
        let months = this.months;
        let ms = this.ms;
        const has = (t: string) => fmt.includes(t);
        const vals: Record<string, number> = {};

        if (has("y")) {
            vals.y = Math.trunc(months / 12);
            months -= vals.y * 12;
        }
        if (has("M")) {
            vals.M = months;
            months = 0;
        }
        ms += months * MS_MONTH_APPROX;
        for (const [tok, size] of [
            ["w", MS_WEEK],
            ["d", MS_DAY],
            ["h", MS_HOUR],
            ["m", MS_MINUTE],
            ["s", MS_SECOND],
        ] as [string, number][]) {
            if (has(tok)) {
                vals[tok] = Math.trunc(ms / size);
                ms -= vals[tok] * size;
            }
        }
        vals.S = ms;

        return fmt.replace(/'([^']*)'|y+|M+|w+|d+|h+|m+|s+|S+/g, (match: string, literal: string | undefined): string => {
            if (literal !== undefined) return literal;
            const v = vals[match[0]] ?? 0;
            return String(v).padStart(match.length, "0");
        });
    }

    toString(): string {
        return this.toHuman();
    }
}

const UNIT_MAP: Record<string, DurationUnit> = {
    y: "years",
    yr: "years",
    yrs: "years",
    year: "years",
    years: "years",
    mo: "months",
    month: "months",
    months: "months",
    w: "weeks",
    wk: "weeks",
    wks: "weeks",
    week: "weeks",
    weeks: "weeks",
    d: "days",
    day: "days",
    days: "days",
    h: "hours",
    hr: "hours",
    hrs: "hours",
    hour: "hours",
    hours: "hours",
    m: "minutes",
    min: "minutes",
    mins: "minutes",
    minute: "minutes",
    minutes: "minutes",
    s: "seconds",
    sec: "seconds",
    secs: "seconds",
    second: "seconds",
    seconds: "seconds",
    ms: "milliseconds",
    millisecond: "milliseconds",
    milliseconds: "milliseconds",
};

const DURATION_PART = /\s*(-?\d+(?:\.\d+)?)\s*([a-zA-Z]+)\s*(?:,|and)?/y;

/** Parses "1 day", "2h 30m", "1 year, 2 months" into a CDuration. Returns null if the text is not a duration. */
export function parseDuration(text: string): CDuration | null {
    const trimmed = text.trim();
    if (trimmed.length === 0) return null;
    const c = trimmed.charCodeAt(0);
    // Must start with a digit or a sign.
    if (!((c >= 48 && c <= 57) || c === 45)) return null;

    const parts: Partial<Record<DurationUnit, number>> = {};
    DURATION_PART.lastIndex = 0;
    let pos = 0;
    let matched = false;
    while (pos < trimmed.length) {
        DURATION_PART.lastIndex = pos;
        const m = DURATION_PART.exec(trimmed);
        if (!m) return null;
        const unit = UNIT_MAP[m[2].toLowerCase()];
        if (!unit) return null;
        parts[unit] = (parts[unit] ?? 0) + parseFloat(m[1]);
        pos = DURATION_PART.lastIndex;
        matched = true;
    }
    return matched ? CDuration.of(parts) : null;
}
