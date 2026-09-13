/** Link to a note, heading or block. Lightweight and immutable. */
export type LinkType = "file" | "header" | "block";

export class Link {
    constructor(
        public readonly path: string,
        public readonly embed: boolean = false,
        public readonly display?: string,
        public readonly subpath?: string,
        public readonly type: LinkType = "file"
    ) {}

    static file(path: string, embed = false, display?: string): Link {
        return new Link(path, embed, display);
    }

    static header(path: string, header: string, embed = false, display?: string): Link {
        return new Link(path, embed, display, header, "header");
    }

    static block(path: string, blockId: string, embed = false, display?: string): Link {
        return new Link(path, embed, display, blockId, "block");
    }

    /** Parses the inner text of `[[Note#Heading|Text]]` into a Link (without resolving the path). */
    static parseInner(inner: string, embed = false): Link {
        let display: string | undefined;
        const bar = inner.indexOf("|");
        if (bar >= 0) {
            display = inner.slice(bar + 1).trim();
            inner = inner.slice(0, bar);
        }

        const hash = inner.indexOf("#");
        if (hash < 0) return new Link(inner.trim(), embed, display);

        const path = inner.slice(0, hash).trim();
        const sub = inner.slice(hash + 1).trim();
        if (sub.startsWith("^")) return new Link(path, embed, display, sub.slice(1), "block");
        return new Link(path, embed, display, sub, "header");
    }

    withPath(path: string): Link {
        return path === this.path ? this : new Link(path, this.embed, this.display, this.subpath, this.type);
    }

    withDisplay(display?: string): Link {
        return new Link(this.path, this.embed, display, this.subpath, this.type);
    }

    withEmbed(embed: boolean): Link {
        return new Link(this.path, embed, this.display, this.subpath, this.type);
    }

    toFile(): Link {
        return this.type === "file" ? this : new Link(this.path, this.embed, this.display);
    }

    equals(other: Link): boolean {
        return this.path === other.path && this.type === other.type && this.subpath === other.subpath;
    }

    /** Text used inside `[[...]]`. */
    obsidianLink(): string {
        if (this.type === "header") return `${this.path}#${this.subpath}`;
        if (this.type === "block") return `${this.path}#^${this.subpath}`;
        return this.path;
    }

    fileName(): string {
        let name = this.path;
        const slash = name.lastIndexOf("/");
        if (slash >= 0) name = name.slice(slash + 1);
        if (name.endsWith(".md")) name = name.slice(0, -3);
        return name;
    }

    displayText(): string {
        if (this.display) return this.display;
        if (this.type === "file") return this.fileName();
        return this.subpath ?? this.fileName();
    }

    markdown(): string {
        return `${this.embed ? "!" : ""}[[${this.obsidianLink()}${this.display ? "|" + this.display : ""}]]`;
    }

    toString(): string {
        return this.markdown();
    }

    toObject(): Record<string, unknown> {
        return { path: this.path, embed: this.embed, display: this.display, subpath: this.subpath, type: this.type };
    }
}
