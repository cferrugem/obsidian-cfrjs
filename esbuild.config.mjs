import esbuild from "esbuild";
import { builtinModules } from "node:module";
import process from "node:process";

const prod = process.argv[2] === "production";

/**
 * The parsing worker is bundled separately and inlined into main.js as a string
 * (Obsidian loads a single JS file per plugin). It is instantiated from a Blob at runtime.
 */
const inlineWorkerPlugin = {
    name: "inline-worker",
    setup(build) {
        build.onResolve({ filter: /^worker-code$/ }, args => ({ path: args.path, namespace: "worker-code" }));
        build.onLoad({ filter: /.*/, namespace: "worker-code" }, async () => {
            const result = await esbuild.build({
                entryPoints: ["src/index/worker.ts"],
                bundle: true,
                write: false,
                format: "iife",
                target: "es2020",
                minify: prod,
                metafile: true,
                logLevel: "silent",
            });
            return {
                contents: `export default ${JSON.stringify(result.outputFiles[0].text)};`,
                loader: "js",
                watchFiles: Object.keys(result.metafile.inputs),
            };
        });
    },
};

const context = await esbuild.context({
    entryPoints: ["src/main.ts"],
    bundle: true,
    external: [
        "obsidian",
        "electron",
        "@codemirror/autocomplete",
        "@codemirror/collab",
        "@codemirror/commands",
        "@codemirror/language",
        "@codemirror/lint",
        "@codemirror/search",
        "@codemirror/state",
        "@codemirror/view",
        "@lezer/common",
        "@lezer/highlight",
        "@lezer/lr",
        ...builtinModules,
    ],
    format: "cjs",
    target: "es2020",
    logLevel: "info",
    sourcemap: prod ? false : "inline",
    treeShaking: true,
    minify: prod,
    outfile: "main.js",
    plugins: [inlineWorkerPlugin],
});

if (prod) {
    await context.rebuild();
    await context.dispose();
} else {
    await context.watch();
}
