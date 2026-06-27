# @monlite/studio

## 0.1.1

- Allow `@monlite/core` 2.0 (dependency range `^2.0.0`). No API changes.

## 0.1.0

- Initial release. A local web inspector: `npx @monlite/studio app.db` opens a
  browser UI to list collections (with counts), browse documents, filter with a
  JSON `where` clause, paginate, and delete records. Zero build step (single-file
  vanilla UI over a node:http API), binds to 127.0.0.1, `--readonly` and `--port`
  options, plus a programmatic `createStudioServer()`.
