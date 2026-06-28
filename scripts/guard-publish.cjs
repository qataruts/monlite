#!/usr/bin/env node
// Block `npm publish`. npm does NOT rewrite pnpm's `workspace:` protocol, so every
// package that depends on `@monlite/core` would ship an uninstallable
// `"@monlite/core": "workspace:^"`. `pnpm publish` resolves it to `^2.6.x`.
// Always release with `pnpm -r publish` (root `pnpm run release`).
const ua = process.env.npm_config_user_agent || "";
if (!ua.startsWith("pnpm")) {
  console.error(
    "\n✖ Refusing to publish via npm.\n" +
      "  Use `pnpm publish` / `pnpm run release` — npm does not resolve the\n" +
      "  workspace: protocol and would ship a broken @monlite/core dependency.\n",
  );
  process.exit(1);
}
