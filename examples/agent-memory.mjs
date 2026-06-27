// AI-agent memory: store memories with embeddings, recall by semantic similarity,
// and combine with keyword search (hybrid). Run: node agent-memory.mjs
import { createDb } from "@monlite/core";
import { fts } from "@monlite/fts";
import { vector, hybridSearch } from "@monlite/vector";

// In a real app these come from an embedding model (OpenAI, local, etc.).
// Here we hand-pick 3-dim vectors per topic so the demo is deterministic.
const topic = { space: [1, 0, 0], cooking: [0, 1, 0], finance: [0, 0, 1] };

const db = createDb(":memory:", {
  allowExtensions: true, // required to load the sqlite-vec extension
  plugins: [
    fts({ memories: ["text"] }),
    vector({ memories: { field: "embedding", dimensions: 3 } }),
  ],
});
const mem = db.collection("memories");

await mem.createMany({
  data: [
    {
      text: "the user loves black holes and astrophysics",
      embedding: topic.space,
    },
    {
      text: "user is learning to bake sourdough bread",
      embedding: topic.cooking,
    },
    { text: "user asked about index funds and ETFs", embedding: topic.finance },
  ],
});

// Semantic recall: nearest memory to a "space" query vector.
const recall = await mem.findSimilar({ vector: topic.space, topK: 1 });
console.log("🧠 semantic recall:", recall[0].text);

// Hybrid: keyword ("astrophysics") + semantic, fused by Reciprocal Rank Fusion.
const hits = await hybridSearch(mem, {
  text: "astrophysics",
  vector: topic.space,
  topK: 2,
});
console.log(
  "🔀 hybrid:",
  hits.map((m) => m.text),
);

await db.$disconnect();
