// sql.js's default build lacks FTS5 (the demo's search uses it); fts5-sql-bundle
// is sql.js compiled WITH FTS5, same initSqlJs API. Vite bundles the WASM (?url)
// so it's version-matched and correctly prefixed under /monlite/demo/.
import initSqlJs from "fts5-sql-bundle/dist/sql-wasm.js";
import sqlWasmUrl from "fts5-sql-bundle/dist/sql-wasm.wasm?url";
import { createDb } from "@monlite/core";
import { wasmDriver, exportDatabase } from "@monlite/wasm";
import { fts } from "@monlite/fts";
import { kv } from "@monlite/kv";

// ── Types ──────────────────────────────────────────────────────────────────

interface Memory {
  title: string;
  content: string;
  tags: string;
}

// ── State ──────────────────────────────────────────────────────────────────

let db: ReturnType<typeof createDb>;
let cache: ReturnType<typeof kv>;
let memories: any; // Collection<Memory>
let sqlLog: { sql: string; ms: number }[] = [];

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
  setLoadingText("Loading SQLite WASM (~1.2 MB)…");

  const SQL = await initSqlJs({
    // Self-hosted, version-matched WASM bundled by Vite (correct under /monlite/demo/).
    locateFile: () => sqlWasmUrl,
  });

  setLoadingText("Starting database…");

  db = createDb(":memory:", {
    driver: wasmDriver(SQL),
    plugins: [
      // Full-text search on title + content + tags (SQLite FTS5, built-in).
      fts({ memories: ["title", "content", "tags"] }),
    ],
    onQuery(sql: string, _params: unknown, ms: number) {
      // Capture every SQL statement for the live log.
      addSqlLog(sql.trim(), ms);
    },
  } as any);

  cache = kv(db);
  memories = db.collection<Memory>("memories");

  setLoadingText("Loading sample data…");
  await seed();

  hideLoading();
  await render();
  setupListeners();
}

// ── Seed data ──────────────────────────────────────────────────────────────

async function seed() {
  await memories.createMany({
    data: [
      {
        title: "Black holes and dark matter",
        content:
          "Black holes form when massive stars collapse under their own gravity. Dark matter makes up ~27% of the universe, interacting only through gravity — it's invisible but detectable by its gravitational effects on surrounding matter.",
        tags: "physics space science cosmology",
      },
      {
        title: "Machine learning fundamentals",
        content:
          "Neural networks adjust weights through backpropagation to minimize a loss function. Transformers use self-attention to process sequences in parallel, enabling models like GPT and BERT that understand context across long passages.",
        tags: "ai ml neural-networks deep-learning transformers",
      },
      {
        title: "Building local-first applications",
        content:
          "Local-first apps store data on-device and sync to the cloud when available. SQLite is ideal for embedded use — zero configuration, ACID transactions, and millions of reads per second on commodity hardware.",
        tags: "local-first sqlite architecture offline-first",
      },
      {
        title: "Vector search and RAG",
        content:
          "Retrieval-Augmented Generation finds relevant context using vector similarity search before generating a response. Embeddings map text to high-dimensional space where semantically similar passages cluster together.",
        tags: "ai embeddings rag retrieval llm vector-search",
      },
      {
        title: "Durable job queues",
        content:
          "Durable queues persist jobs to disk so they survive process restarts. Atomic claims via database transactions (BEGIN IMMEDIATE) prevent two workers from processing the same job — the same guarantee Redis and BullMQ give you, over a file.",
        tags: "architecture queues distributed-systems workers durability",
      },
    ],
  });
}

// ── Rendering ──────────────────────────────────────────────────────────────

async function render(query?: string) {
  const q = query?.trim() ?? "";
  let docs: any[];
  let isSearch = false;

  if (q) {
    try {
      docs = await memories.search(q, { limit: 30 });
      isSearch = true;
    } catch {
      docs = await memories.findMany({ orderBy: { created_at: "desc" } });
    }
  } else {
    docs = await memories.findMany({ orderBy: { created_at: "desc" } });
  }

  renderCards(docs, q, isSearch);
  updateStats();
}

function renderCards(docs: any[], query: string, isSearch: boolean) {
  const grid = document.getElementById("memory-grid")!;
  const countEl = document.getElementById("result-count")!;
  const hintEl = document.getElementById("fts-hint")!;

  if (isSearch) {
    countEl.textContent = `${docs.length} result${docs.length !== 1 ? "s" : ""}`;
    hintEl.textContent = `FTS5: "${query}"`;
  } else {
    countEl.textContent = `${docs.length} memor${docs.length !== 1 ? "ies" : "y"}`;
    hintEl.textContent = "";
  }

  if (docs.length === 0) {
    grid.innerHTML = `<div class="empty">No memories found${isSearch ? ` for "${query}"` : ""}.</div>`;
    return;
  }

  grid.innerHTML = docs
    .map(
      (doc) => `
    <div class="memory-card" data-id="${doc._id}">
      <div class="memory-title">${hl(doc.title, query)}</div>
      <div class="memory-content">${hl(doc.content, query)}</div>
      <div class="memory-footer">
        <div class="memory-tags">${formatTags(doc.tags)}</div>
        ${isSearch && doc._score != null ? `<span class="score">${doc._score.toFixed(1)}</span>` : ""}
        <button class="btn-delete" onclick="window.__deleteMemory('${doc._id}')">×</button>
      </div>
    </div>
  `
    )
    .join("");
}

function hl(text: string, query: string): string {
  if (!query) return text;
  const terms = query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 1);
  let out = text;
  for (const t of terms) {
    out = out.replace(new RegExp(`(${t})`, "gi"), "<mark>$1</mark>");
  }
  return out;
}

function formatTags(tags: string): string {
  if (!tags) return "";
  return tags
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `<span class="tag">#${t}</span>`)
    .join("");
}

function updateStats() {
  const bytes = exportDatabase(db).byteLength;
  document.getElementById("stat-size")!.textContent = `${(bytes / 1024).toFixed(0)} KB`;
  memories
    .count()
    .then((n: number) => {
      document.getElementById("stat-docs")!.textContent = `${n} memor${n !== 1 ? "ies" : "y"}`;
    });
}

// ── SQL log ────────────────────────────────────────────────────────────────

function addSqlLog(sql: string, ms: number) {
  // Truncate very long SQL (parameterized values are already stripped).
  const short = sql.length > 120 ? sql.slice(0, 120) + "…" : sql;
  sqlLog.unshift({ sql: short, ms });
  if (sqlLog.length > 40) sqlLog.pop();
  renderSqlLog();
}

function renderSqlLog() {
  const el = document.getElementById("sql-log")!;
  el.innerHTML = sqlLog
    .slice(0, 12)
    .map(
      (e) => `
    <div class="sql-entry">
      <span class="sql-text">${e.sql}</span>
      <span class="sql-time">${e.ms}ms</span>
    </div>
  `
    )
    .join("");
}

// ── Event listeners ────────────────────────────────────────────────────────

function setupListeners() {
  // ── Search ──
  const searchEl = document.getElementById("search") as HTMLInputElement;
  const clearEl = document.getElementById("search-clear")!;
  let searchTimer: ReturnType<typeof setTimeout>;

  searchEl.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = searchEl.value;
    clearEl.style.display = q ? "block" : "none";
    searchTimer = setTimeout(() => render(q), 220);
  });
  clearEl.addEventListener("click", () => {
    searchEl.value = "";
    clearEl.style.display = "none";
    render();
  });

  // ── Add memory ──
  document.getElementById("btn-add")!.addEventListener("click", async () => {
    const title = (document.getElementById("mem-title") as HTMLInputElement).value.trim();
    const content = (document.getElementById("mem-content") as HTMLTextAreaElement).value.trim();
    const tags = (document.getElementById("mem-tags") as HTMLInputElement).value.trim().replace(/,/g, " ");

    if (!title || !content) {
      shakeEl(document.getElementById("btn-add")!);
      return;
    }

    await memories.create({ data: { title, content, tags } });

    (document.getElementById("mem-title") as HTMLInputElement).value = "";
    (document.getElementById("mem-content") as HTMLTextAreaElement).value = "";
    (document.getElementById("mem-tags") as HTMLInputElement).value = "";

    await render(searchEl.value);
  });

  // ── KV cache ──
  let countdownId: ReturnType<typeof setInterval>;

  document.getElementById("btn-set")!.addEventListener("click", () => {
    const key = (document.getElementById("kv-key") as HTMLInputElement).value.trim();
    const val = (document.getElementById("kv-value") as HTMLInputElement).value.trim();
    const ttlRaw = parseInt((document.getElementById("kv-ttl") as HTMLInputElement).value) || 0;

    if (!key || !val) return;

    cache.set(key, val, ttlRaw ? { ttl: ttlRaw } : undefined);

    if (ttlRaw) {
      clearInterval(countdownId);
      const end = Date.now() + ttlRaw;
      const res = document.getElementById("kv-result")!;
      res.className = "kv-result success";

      countdownId = setInterval(() => {
        const left = Math.max(0, end - Date.now());
        if (left === 0) {
          clearInterval(countdownId);
          res.textContent = `⏱ "${key}" expired`;
          res.className = "kv-result error";
        } else {
          res.textContent = `✓ set "${key}" → expires in ${(left / 1000).toFixed(1)}s`;
        }
      }, 80);
    } else {
      setKvResult(`✓ set "${key}" = "${val}"`, "success");
    }
  });

  document.getElementById("btn-get")!.addEventListener("click", () => {
    const key = (document.getElementById("kv-key") as HTMLInputElement).value.trim();
    if (!key) return;

    const value = cache.get(key);
    const ttlLeft = cache.ttl(key);

    if (value === undefined) {
      setKvResult(`✗ "${key}" not found or expired`, "error");
    } else {
      const ttlStr =
        ttlLeft === -1 ? "no expiry" : ttlLeft === -2 ? "absent" : `${ttlLeft}ms left`;
      setKvResult(`→ "${key}" = ${JSON.stringify(value)}  (${ttlStr})`, "success");
    }
  });

  document.getElementById("btn-del")!.addEventListener("click", () => {
    const key = (document.getElementById("kv-key") as HTMLInputElement).value.trim();
    if (!key) return;
    cache.delete(key);
    clearInterval(countdownId);
    setKvResult(`✓ deleted "${key}"`, "success");
  });
}

function setKvResult(msg: string, type: "success" | "error") {
  const el = document.getElementById("kv-result")!;
  el.textContent = msg;
  el.className = `kv-result ${type}`;
}

function shakeEl(el: HTMLElement) {
  el.style.animation = "none";
  el.getBoundingClientRect(); // reflow
  el.style.animation = "";
}

// ── Globals (for inline onclick) ──────────────────────────────────────────

(window as any).__deleteMemory = async (id: string) => {
  await memories.delete({ where: { _id: id } });
  const q = (document.getElementById("search") as HTMLInputElement).value;
  await render(q);
};

// ── Loading helpers ────────────────────────────────────────────────────────

function setLoadingText(msg: string) {
  document.getElementById("loading-text")!.textContent = msg;
}

function hideLoading() {
  const el = document.getElementById("loading")!;
  el.classList.add("hidden");
  setTimeout(() => el.remove(), 400);
}

// ── Start ─────────────────────────────────────────────────────────────────

init().catch((err) => {
  console.error(err);
  setLoadingText(`Error: ${err.message}`);
});
