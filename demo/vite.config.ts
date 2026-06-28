import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  // Served under /demo on the docs site (monlite.dev/demo) via GitHub Pages.
  base: "/demo/",
  resolve: {
    alias: {
      // Polyfill Node built-ins so @monlite/core (built for Node) runs in the browser.
      // The WASM driver is passed directly, so no native DB driver is ever instantiated.
      "node:module": resolve("./src/mocks/node-module.js"),
      module: resolve("./src/mocks/node-module.js"),
      "node:crypto": resolve("./src/mocks/crypto.js"),
      crypto: resolve("./src/mocks/crypto.js"),
      // Route `buffer` imports to the npm `buffer` polyfill package.
      "node:buffer": "buffer",
    },
  },
  define: {
    // Make Buffer available as a global (the compiled dist uses it without importing).
    global: "globalThis",
  },
  optimizeDeps: {
    // sql.js ships its own WASM loader — don't pre-bundle it.
    exclude: ["sql.js"],
    // Force Vite to pre-bundle the monlite workspace packages so alias resolution
    // for the mocks is applied consistently within the demo's dependency graph.
    include: [
      "@monlite/core",
      "@monlite/wasm",
      "@monlite/fts",
      "@monlite/kv",
      "buffer",
    ],
  },
  build: {
    outDir: "dist",
    target: "es2022",
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },
  server: {
    // Allow Vite to resolve workspace packages from the monorepo root.
    fs: { allow: [".."] },
    headers: {
      // Required for SharedArrayBuffer (sql.js WASM threading).
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
