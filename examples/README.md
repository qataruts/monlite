# monlite examples

Small, self-contained, runnable demos.

```bash
cd examples
npm install
node notes.mjs
node agent-memory.mjs
node sync.mjs
```

They run on the built-in `node:sqlite` backend (Node 22.5+), so no native
`better-sqlite3` build is needed.

| Example | Shows |
| --- | --- |
| [`notes.mjs`](./notes.mjs) | Document CRUD, **full-text search** (`@monlite/fts`), and a **live/reactive query** (`collection.watch`). |
| [`agent-memory.mjs`](./agent-memory.mjs) | **Vector / semantic recall** and **hybrid search** (`@monlite/vector`) — the building block for RAG and AI-agent memory. |
| [`sync.mjs`](./sync.mjs) | **Local-first sync** (`@monlite/sync`) — two devices converging through a shared hub. |

Each file is heavily commented; copy one and start hacking.
