// A tiny notes app: document CRUD + full-text search + a live (reactive) query.
// Run: node notes.mjs
import { createDb } from "@monlite/core";
import { fts } from "@monlite/fts";

const db = createDb(":memory:", {
  plugins: [fts({ notes: ["title", "body"] })],
});
const notes = db.collection("notes");

// A live query: the callback fires now (init) and again whenever a *pinned*
// note changes — row-level, so unrelated writes don't recompute it.
const live = notes.watch(
  { where: { pinned: true }, orderBy: { title: "asc" } },
  (e) =>
    console.log(
      "📌 pinned:",
      e.results.map((n) => n.title),
    ),
);

await notes.create({
  data: { title: "Groceries", body: "milk, eggs, bread", pinned: true },
});
await notes.create({
  data: { title: "Ideas", body: "build a local-first db", pinned: false },
});
await notes.create({
  data: { title: "Trip", body: "flights to Riyadh in May", pinned: true },
});

await new Promise((r) => setTimeout(r, 10)); // let the reactive flush run

// Full-text search across title + body.
const hits = await notes.search("riyadh");
console.log(
  "🔎 search 'riyadh':",
  hits.map((n) => n.title),
);

live.stop();
await db.$disconnect();
