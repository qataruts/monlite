import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@monlite/core": fileURLToPath(
        new URL("../../src/index.ts", import.meta.url),
      ),
    },
  },
});
