/** Bidirectional key <-> paths index, updated by diff (no set copies on reads). */

export const EMPTY_SET: ReadonlySet<string> = Object.freeze(new Set<string>()) as ReadonlySet<string>;

export class SetIndex {
    /** path -> keys */
    private forward = new Map<string, ReadonlySet<string>>();
    /** key -> paths */
    private inverse = new Map<string, Set<string>>();

    get(path: string): ReadonlySet<string> {
        return this.forward.get(path) ?? EMPTY_SET;
    }

    /** Paths associated with the key. Do not mutate the returned set. */
    getInverse(key: string): ReadonlySet<string> {
        return this.inverse.get(key) ?? EMPTY_SET;
    }

    /** Sets the path's keys; returns true if anything changed. */
    set(path: string, keys: ReadonlySet<string>): boolean {
        const old = this.forward.get(path);
        if (old && old.size === keys.size) {
            let same = true;
            for (const k of keys) {
                if (!old.has(k)) {
                    same = false;
                    break;
                }
            }
            if (same) return false;
        }
        if (old) {
            for (const k of old) {
                if (keys.has(k)) continue;
                const set = this.inverse.get(k);
                if (set) {
                    set.delete(path);
                    if (set.size === 0) this.inverse.delete(k);
                }
            }
        }
        for (const k of keys) {
            if (old?.has(k)) continue;
            let set = this.inverse.get(k);
            if (!set) this.inverse.set(k, (set = new Set()));
            set.add(path);
        }
        if (keys.size === 0) this.forward.delete(path);
        else this.forward.set(path, keys);
        return true;
    }

    delete(path: string): boolean {
        if (!this.forward.has(path)) return false;
        this.set(path, EMPTY_SET);
        return true;
    }

    rename(oldPath: string, newPath: string): void {
        const keys = this.forward.get(oldPath);
        if (!keys) return;
        this.delete(oldPath);
        this.set(newPath, keys);
    }

    clear(): void {
        this.forward.clear();
        this.inverse.clear();
    }
}
