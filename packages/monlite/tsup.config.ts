import { defineConfig } from "tsup";

// The barrel only re-exports the @monlite/* packages — keep them external so the
// dist is a thin set of re-export statements, never an inlined copy of the suite.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    kv: "src/kv.ts",
    queue: "src/queue.ts",
    cron: "src/cron.ts",
    fts: "src/fts.ts",
    vector: "src/vector.ts",
    sync: "src/sync.ts",
    realtime: "src/realtime.ts",
    "realtime-client": "src/realtime-client.ts",
    wasm: "src/wasm.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  target: "node18",
  external: [/^@monlite\//],
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
});
