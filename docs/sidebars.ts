import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  docs: [
    {
      type: "category",
      label: "Getting started",
      collapsed: false,
      items: ["intro", "getting-started"],
    },
    {
      type: "category",
      label: "Core",
      collapsed: false,
      items: [
        "core/documents",
        "core/queries",
        "core/aggregation",
        "core/structured",
        "core/transactions",
        "core/realtime",
        "core/durability",
      ],
    },
    {
      type: "category",
      label: "Packages",
      items: [
        "packages/sync",
        "packages/realtime",
        "packages/fts",
        "packages/vector",
        "packages/kv",
        "packages/queue",
        "packages/cron",
        "packages/wasm",
      ],
    },
    {
      type: "category",
      label: "Guides",
      items: [
        "guides/production",
        "guides/migrations",
        "guides/v2-migration",
        "guides/custom-adapter",
        "guides/ai-agent-backend",
      ],
    },
    {
      type: "category",
      label: "Reference",
      items: [
        "reference/file-format",
        "reference/benchmarks",
        "reference/python",
      ],
    },
  ],
};

export default sidebars;
