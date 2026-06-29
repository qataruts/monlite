import { themes as prismThemes } from "prism-react-renderer";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

const config: Config = {
  title: "monlite",
  tagline:
    "The local-first database for TypeScript — documents, vectors, cache, queue, cron, in one .db",
  favicon: "img/favicon.svg",

  url: "https://qataruts.github.io",
  baseUrl: "/monlite/",
  organizationName: "qataruts",
  projectName: "monlite",

  onBrokenLinks: "warn",
  markdown: { hooks: { onBrokenMarkdownLinks: "warn" } },

  i18n: { defaultLocale: "en", locales: ["en"] },

  presets: [
    [
      "classic",
      {
        docs: {
          routeBasePath: "/", // docs are the site
          sidebarPath: "./sidebars.ts",
          editUrl: "https://github.com/qataruts/monlite/edit/main/docs/",
        },
        blog: false,
        theme: { customCss: "./src/css/custom.css" },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: "img/social-card.png",
    colorMode: { defaultMode: "dark", respectPrefersColorScheme: true },
    navbar: {
      title: "monlite",
      logo: { alt: "monlite", src: "img/favicon.svg" },
      items: [
        {
          type: "docSidebar",
          sidebarId: "docs",
          position: "left",
          label: "Docs",
        },
        { to: "/packages/vector", label: "Packages", position: "left" },
        { to: "/guides/production", label: "Guides", position: "left" },
        {
          href: "https://www.npmjs.com/package/@monlite/core",
          label: "npm",
          position: "right",
        },
        {
          href: "https://github.com/qataruts/monlite",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Docs",
          items: [
            { label: "Getting started", to: "/getting-started" },
            { label: "Core", to: "/core/documents" },
            { label: "Guides", to: "/guides/production" },
          ],
        },
        {
          title: "Packages",
          items: [
            { label: "@monlite/sync", to: "/packages/sync" },
            { label: "@monlite/vector", to: "/packages/vector" },
            { label: "@monlite/queue", to: "/packages/queue" },
          ],
        },
        {
          title: "More",
          items: [
            { label: "File format", to: "/reference/file-format" },
            { label: "Python / interop", to: "/reference/python" },
            { label: "GitHub", href: "https://github.com/qataruts/monlite" },
          ],
        },
      ],
      copyright: `monlite 🌙 — local-first for TypeScript. MIT.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ["bash", "json", "python"],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
