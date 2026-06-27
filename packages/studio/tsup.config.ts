import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", cli: "src/cli.ts" },
  format: ["esm"],
  dts: { entry: "src/index.ts" },
  clean: true,
  external: ["@monlite/core"],
  banner: { js: "#!/usr/bin/env node" },
});
