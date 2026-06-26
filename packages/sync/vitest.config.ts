import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      // Run tests against core source (no prebuild needed).
      "@monlite/core": fileURLToPath(new URL("../../src/index.ts", import.meta.url)),
    },
  },
});
