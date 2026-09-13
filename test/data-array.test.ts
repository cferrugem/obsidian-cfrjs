import { describe, expect, it } from "vitest";
import { DataArray } from "../src/api/data-array";

const pages = DataArray.wrap([
    { file: { name: "B", tasks: [{ text: "t1" }, { text: "t2" }] }, n: 2, g: "x" },
    { file: { name: "A", tasks: [{ text: "t3" }] }, n: 1, g: "y" },
    { file: { name: "C", tasks: [] }, n: 3, g: "x" },
]);

describe("DataArray", () => {
    it("is a real Array", () => {
        expect(Array.isArray(pages)).toBe(true);
        expect(pages.length).toBe(3);
        expect([...pages].length).toBe(3);
        expect(pages.map(p => p.n)).toBeInstanceOf(DataArray);
    });

    it("filters, sorts and limits", () => {
        expect(pages.where(p => p.n > 1).map(p => p.file.name)).toEqual(["B", "C"]);
        expect(pages.sort(p => p.n, "desc").map(p => p.n).array()).toEqual([3, 2, 1]);
        expect(pages.sort(p => p.n).limit(1)[0].file.name).toBe("A");
        // The original order is preserved (sorting by key returns a copy).
        expect(pages[0].file.name).toBe("B");
    });

    it("keeps the native sort for two-argument comparators", () => {
        const arr = DataArray.wrap([3, 1, 2]);
        arr.sort((a: number, b: number) => a - b);
        expect(arr.array()).toEqual([1, 2, 3]);
    });

    it("groups and removes duplicates", () => {
        const groups = pages.groupBy(p => p.g);
        expect(groups.map(g => [g.key, g.rows.length]).array()).toEqual([
            ["x", 2],
            ["y", 1],
        ]);
        expect(groups.key.array()).toEqual(["x", "y"]);
        expect(pages.distinct(p => p.g).length).toBe(2);
    });

    it("supports chained field access like Dataview", () => {
        expect(pages.file.name.array()).toEqual(["B", "A", "C"]);
        expect(pages.file.tasks.text.array()).toEqual(["t1", "t2", "t3"]);
        expect(pages.pluck("file.name").join()).toBe("B, A, C");
        expect(pages.values).toEqual([...pages]);
    });

    it("aggregates", () => {
        expect(pages.to("n").sum()).toBe(6);
        expect(pages.to("n").avg()).toBe(2);
        expect(pages.to("n").max()).toBe(3);
    });

    it("expands trees", () => {
        const tree = DataArray.wrap([{ id: 1, children: [{ id: 2, children: [{ id: 3 }] }] }]);
        expect(tree.expand("children").map(t => t.id).array()).toEqual([1, 2, 3]);
    });
});
