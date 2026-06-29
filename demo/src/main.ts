// sql.js's default build lacks FTS5 (the search uses it); fts5-sql-bundle is
// sql.js compiled WITH FTS5, same initSqlJs API. Vite bundles the WASM (?url).
import initSqlJs from "fts5-sql-bundle/dist/sql-wasm.js";
import sqlWasmUrl from "fts5-sql-bundle/dist/sql-wasm.wasm?url";
import { createDb } from "@monlite/core";
import { wasmDriver, exportDatabase } from "@monlite/wasm";
import { fts } from "@monlite/fts";
import { vector } from "@monlite/vector";
import { kv } from "@monlite/kv";
import { createQueue, type Queue } from "@monlite/queue";
import { createCron, parseCron, nextCronRun } from "@monlite/cron";

interface Memory {
  title: string;
  content: string;
  tags: string;
  embedding?: number[];
}

let db: ReturnType<typeof createDb>;
let cache: ReturnType<typeof kv>;
let memories: any;
let queue: Queue;
let cron: ReturnType<typeof createCron>;
const sqlLog: { sql: string; ms: number }[] = [];

const $ = (id: string) => document.getElementById(id)!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Init ─────────────────────────────────────────────────────────────────
async function init() {
  setLoadingText("Loading SQLite WASM (~1.2 MB)…");
  const SQL = await initSqlJs({ locateFile: () => sqlWasmUrl });

  setLoadingText("Starting database…");
  db = createDb(":memory:", {
    // onQuery lives on the wasm driver (createDb's onQuery only reaches the Node
    // drivers). This powers the live SQL log shared by every tab.
    driver: wasmDriver(SQL, {
      onQuery: (e) => addSqlLog(e.sql.trim(), e.durationMs),
    }),
    plugins: [
      fts({ memories: ["title", "content", "tags"] }),
      vector({
        memories: { field: "embedding", dimensions: 384, distance: "cosine" },
      }),
    ],
  });

  cache = kv(db);
  memories = db.collection<Memory>("memories");
  queue = createQueue(db, { maxAttempts: 3, backoff: () => 500 });
  cron = createCron(db, { checkInterval: 1000 });

  setLoadingText("Loading sample data…");
  await seed();

  setupTabs();
  setupDocs();
  setupSearch();
  setupVector();
  setupKv();
  setupQueue();
  setupCron();

  hideLoading();
}

async function seed() {
  await memories.createMany({
    data: [
      {
        title: "Black holes and dark matter",
        content:
          "Black holes form when massive stars collapse under their own gravity. Dark matter makes up ~27% of the universe, interacting only through gravity — invisible but detectable by its gravitational pull.",
        tags: "physics space cosmology",
      },
      {
        title: "Machine learning fundamentals",
        content:
          "Neural networks adjust weights through backpropagation to minimize a loss function. Transformers use self-attention to process sequences in parallel, powering models like GPT and BERT.",
        tags: "ai ml transformers",
      },
      {
        title: "Building local-first applications",
        content:
          "Local-first apps store data on-device and sync to the cloud when available. SQLite is ideal for embedded use — zero config, ACID transactions, and millions of reads per second.",
        tags: "local-first sqlite offline",
      },
      {
        title: "Vector search and RAG",
        content:
          "Retrieval-Augmented Generation finds relevant context using vector similarity search before generating a response. Embeddings map text to a space where similar passages cluster together.",
        tags: "ai embeddings rag retrieval",
      },
      {
        title: "Durable job queues",
        content:
          "Durable queues persist jobs to disk so they survive restarts. Atomic claims via database transactions prevent two workers from processing the same job — the guarantee Redis and BullMQ give you, over a file.",
        tags: "architecture queues workers",
      },
    ],
  });
}

// ── Tabs ───────────────────────────────────────────────────────────────────
function setupTabs() {
  const tabs = document.querySelectorAll<HTMLButtonElement>(".tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      document
        .querySelectorAll(".tab-panel")
        .forEach((p) => p.classList.remove("active"));
      $(`panel-${tab.dataset.tab}`).classList.add("active");
      if (tab.dataset.tab === "queue") renderJobs();
      if (tab.dataset.tab === "cron") renderCrons();
    });
  });
}

// ── Documents (core: documents + watch + aggregation) ───────────────────────
function setupDocs() {
  // Reactive: the grid re-renders whenever the collection changes.
  memories.watch({ orderBy: { created_at: "desc" } }, ({ results }: any) => {
    renderDocsGrid(results);
    renderAgg(results);
    updateStats();
  });

  $("btn-add").addEventListener("click", async () => {
    const title = ($("mem-title") as HTMLInputElement).value.trim();
    const content = ($("mem-content") as HTMLTextAreaElement).value.trim();
    const tags = ($("mem-tags") as HTMLInputElement).value
      .trim()
      .replace(/,/g, " ");
    if (!title || !content) return shake($("btn-add"));
    await memories.create({ data: { title, content, tags } });
    ($("mem-title") as HTMLInputElement).value = "";
    ($("mem-content") as HTMLTextAreaElement).value = "";
    ($("mem-tags") as HTMLInputElement).value = "";
  });
}

function renderDocsGrid(docs: any[]) {
  $("docs-grid").innerHTML = docs.map((d) => card(d, "")).join("");
}

function renderAgg(docs: any[]) {
  const freq: Record<string, number> = {};
  for (const d of docs)
    for (const t of (d.tags || "").split(/\s+/).filter(Boolean))
      freq[t] = (freq[t] || 0) + 1;
  const top = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  $("agg").innerHTML = top.length
    ? `<span class="agg-label">tag breakdown</span>` +
      top.map(([t, n]) => `<span class="tag">#${t}<b>${n}</b></span>`).join("")
    : "";
}

// ── Full-text search (fts) ───────────────────────────────────────────────────
function setupSearch() {
  const input = $("search") as HTMLInputElement;
  const clear = $("search-clear");
  let timer: any;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    clear.style.display = input.value ? "block" : "none";
    timer = setTimeout(() => runSearch(input.value), 200);
  });
  clear.addEventListener("click", () => {
    input.value = "";
    clear.style.display = "none";
    runSearch("");
  });
  runSearch("");
}

async function runSearch(q: string) {
  q = q.trim();
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
  $("result-count").textContent = isSearch
    ? `${docs.length} result${docs.length !== 1 ? "s" : ""}`
    : `${docs.length} documents`;
  $("fts-hint").textContent = isSearch ? `FTS5: "${q}"` : "";
  $("search-grid").innerHTML = docs.length
    ? docs.map((d) => card(d, q)).join("")
    : `<div class="empty">No matches for "${escapeHtml(q)}".</div>`;
}

// ── Vector search (vector + Transformers.js) ────────────────────────────────
let embedder: any = null;

function setupVector() {
  $("btn-load-model").addEventListener("click", loadModel);
  const input = $("vec-search") as HTMLInputElement;
  let timer: any;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => runVector(input.value), 350);
  });
}

async function loadModel() {
  const btn = $("btn-load-model") as HTMLButtonElement;
  btn.disabled = true;
  try {
    setModelStatus("Downloading Transformers.js…");
    // Load from CDN (avoids bundling onnxruntime). Runs on-device.
    const TF: any = await import(
      /* @vite-ignore */ "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.2"
    );
    TF.env.allowLocalModels = false;
    setModelStatus("Downloading model — all-MiniLM-L6-v2 (~23 MB, one-time)…");
    embedder = await TF.pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2",
    );
    setModelStatus("Embedding documents…");
    const docs = await memories.findMany({});
    for (const d of docs) {
      const v = await embed(`${d.title}. ${d.content}`);
      await memories.update({ where: { _id: d._id }, data: { embedding: v } });
    }
    $("vector-setup").style.display = "none";
    $("vector-ui").style.display = "block";
    runVector("mysteries of outer space");
    ($("vec-search") as HTMLInputElement).value = "mysteries of outer space";
  } catch (e: any) {
    setModelStatus(`Failed to load model: ${e.message}`);
    btn.disabled = false;
  }
}

async function embed(text: string): Promise<number[]> {
  const out = await embedder(text, { pooling: "mean", normalize: true });
  return Array.from(out.data as Float32Array);
}

async function runVector(q: string) {
  q = q.trim();
  if (!embedder) return;
  // Empty query → show ALL the vector data (the full corpus), not nothing.
  if (!q) {
    const all = await memories.findMany({});
    $("vec-count").textContent =
      `${all.length} document${all.length === 1 ? "" : "s"}`;
    $("vector-grid").innerHTML = all.length
      ? all.map((d: any) => card(d, "", "")).join("")
      : `<div class="empty">No documents yet.</div>`;
    return;
  }
  const v = await embed(q);
  // findSimilar ranks ALL docs by similarity; keep only the relevant ones so it
  // reads as search, not a re-sorted list (there are only a handful of docs).
  const all = await memories.findSimilar({ vector: v, topK: 5 });
  const hits = all.filter((d: any) => 1 - d._distance >= 0.12);
  $("vec-count").textContent = hits.length
    ? `${hits.length} by meaning`
    : "no close matches";
  $("vector-grid").innerHTML = hits.length
    ? hits
        .map((d: any) =>
          card(d, "", `${((1 - d._distance) * 100).toFixed(0)}% match`),
        )
        .join("")
    : `<div class="empty">Nothing semantically close to "${escapeHtml(q)}". Try another phrasing.</div>`;
}

// ── Cache (kv) ───────────────────────────────────────────────────────────────
let countdownId: any;
function setupKv() {
  $("btn-set").addEventListener("click", () => {
    const key = ($("kv-key") as HTMLInputElement).value.trim();
    const val = ($("kv-value") as HTMLInputElement).value.trim();
    const ttl = parseInt(($("kv-ttl") as HTMLInputElement).value) || 0;
    if (!key || !val) return;
    cache.set(key, val, ttl ? { ttl } : undefined);
    clearInterval(countdownId);
    if (ttl) {
      const end = Date.now() + ttl;
      const res = $("kv-result");
      res.className = "kv-result success";
      countdownId = setInterval(() => {
        const left = Math.max(0, end - Date.now());
        if (left === 0) {
          clearInterval(countdownId);
          res.textContent = `⏱ "${key}" expired`;
          res.className = "kv-result error";
        } else
          res.textContent = `✓ set "${key}" → expires in ${(left / 1000).toFixed(1)}s`;
      }, 80);
    } else setKv(`✓ set "${key}" = "${val}"`, "success");
  });
  $("btn-get").addEventListener("click", () => {
    const key = ($("kv-key") as HTMLInputElement).value.trim();
    if (!key) return;
    clearInterval(countdownId);
    const value = cache.get(key);
    if (value === undefined) setKv(`✗ "${key}" not found or expired`, "error");
    else {
      const t = cache.ttl(key);
      const s = t === -1 ? "no expiry" : t === -2 ? "absent" : `${t}ms left`;
      setKv(`→ "${key}" = ${JSON.stringify(value)}  (${s})`, "success");
    }
  });
  $("btn-del").addEventListener("click", () => {
    const key = ($("kv-key") as HTMLInputElement).value.trim();
    if (!key) return;
    cache.delete(key);
    clearInterval(countdownId);
    setKv(`✓ deleted "${key}"`, "success");
  });
}
function setKv(msg: string, type: "success" | "error") {
  const el = $("kv-result");
  el.textContent = msg;
  el.className = `kv-result ${type}`;
}

// ── Queue (queue) ────────────────────────────────────────────────────────────
let jobSeq = 0;
let jobFilter = "all";
// The worker runs ONLY while there are pending/active jobs, then stops — so it
// never idle-polls or re-renders in a loop (which looked like the app hung).
let worker: { stop(): Promise<void> } | null = null;
let renderTimer: any = null;
function startWorker() {
  if (!worker) {
    worker = queue.process(
      "tasks",
      async (job: any) => {
        await sleep(500 + Math.random() * 500);
        if (job.attempts < 2 && Math.random() < 0.33)
          throw new Error("transient failure");
        return "ok";
      },
      { concurrency: 2, pollInterval: 500 },
    );
  }
  if (!renderTimer) renderTimer = setInterval(renderJobs, 350); // show active states
}
function stopWorker() {
  if (worker) {
    worker.stop();
    worker = null;
  }
  if (renderTimer) {
    clearInterval(renderTimer);
    renderTimer = null;
  }
  renderJobs();
}
function onJobSettled() {
  const c = queue.counts("tasks");
  if (c.pending === 0 && c.active === 0)
    stopWorker(); // queue drained → idle
  else renderJobs();
}
function setupQueue() {
  queue.on("completed", onJobSettled);
  queue.on("failed", onJobSettled);
  $("btn-add-job").addEventListener("click", () => addJob(1));
  $("btn-add-5").addEventListener("click", () => addJob(5));
  $("btn-clear-done").addEventListener("click", () => {
    db.sqlite
      .prepare(
        "DELETE FROM _jobs WHERE queue='tasks' AND status IN ('done','failed')",
      )
      .run();
    renderJobs();
  });
  $("btn-clear-all").addEventListener("click", () => {
    db.sqlite.prepare("DELETE FROM _jobs WHERE queue='tasks'").run();
    renderJobs();
  });
  renderJobs();
}
function addJob(n: number) {
  for (let i = 0; i < n; i++)
    queue.add("tasks", { label: `task #${++jobSeq}` });
  startWorker(); // process now, auto-stops when the queue drains
  renderJobs();
}
function renderJobs() {
  const c = queue.counts("tasks");
  const total = c.pending + c.active + c.done + c.failed;
  const chips: [string, number][] = [
    ["all", total],
    ["pending", c.pending],
    ["active", c.active],
    ["done", c.done],
    ["failed", c.failed],
  ];
  $("job-counts").innerHTML = chips
    .map(
      ([f, n]) =>
        `<button class="count count-${f} ${jobFilter === f ? "on" : ""}" data-f="${f}">${n} ${f}</button>`,
    )
    .join("");
  $("job-counts")
    .querySelectorAll<HTMLElement>(".count")
    .forEach((el) =>
      el.addEventListener("click", () => {
        jobFilter = el.dataset.f!;
        renderJobs();
      }),
    );
  const where = jobFilter === "all" ? "" : ` AND status='${jobFilter}'`;
  const rows = db.sqlite
    .prepare(
      `SELECT id, status, attempts, max_attempts, payload FROM _jobs WHERE queue='tasks'${where} ORDER BY id DESC LIMIT 40`,
    )
    .all() as any[];
  $("job-list").innerHTML = rows.length
    ? rows
        .map((j) => {
          const label = JSON.parse(j.payload || "{}")?.label ?? `job ${j.id}`;
          return `<div class="job"><span class="job-status status-${j.status}">${j.status}</span><span class="job-label">${escapeHtml(label)}</span><span class="job-meta">attempt ${j.attempts}/${j.max_attempts}</span><button class="btn-delete" title="delete" onclick="window.__delJob(${j.id})">×</button></div>`;
        })
        .join("")
    : `<div class="empty">${jobFilter === "all" ? "No jobs yet — enqueue one." : `No ${jobFilter} jobs.`}</div>`;
}
(window as any).__delJob = (id: number) => {
  db.sqlite.prepare("DELETE FROM _jobs WHERE id=?").run(id);
  renderJobs();
};

// ── Cron (cron) ──────────────────────────────────────────────────────────────
let cronSeq = 0;
const cronFires: Record<string, number> = {};
function setupCron() {
  $("btn-cron").addEventListener("click", addCron);
  setInterval(() => {
    if ($("panel-cron").classList.contains("active")) renderCrons();
  }, 1000);
  renderCrons();
}
function addCron() {
  const nameRaw = ($("cron-name") as HTMLInputElement).value.trim();
  const name =
    (nameRaw || `job-${++cronSeq}`)
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 24) || `job-${++cronSeq}`;
  const expr = ($("cron-expr") as HTMLInputElement).value.trim();
  let parsed;
  try {
    parsed = parseCron(expr);
  } catch (e: any) {
    return flashCronErr(`Invalid "${expr}": ${e.message}`);
  }
  void parsed;
  cronFires[name] = cronFires[name] ?? 0;
  cron.schedule(name, expr, () => {
    cronFires[name] = (cronFires[name] ?? 0) + 1;
    renderCrons();
  });
  ($("cron-name") as HTMLInputElement).value = "";
  renderCrons();
}
function flashCronErr(msg: string) {
  const el = $("cron-err");
  el.textContent = msg;
  setTimeout(() => {
    if (el.textContent === msg) el.textContent = "";
  }, 4000);
}
function renderCrons() {
  const rows = db.sqlite
    .prepare(
      "SELECT name, cron, next_run, last_run FROM _schedules ORDER BY name",
    )
    .all() as any[];
  $("cron-list").innerHTML = rows.length
    ? rows
        .map((r) => {
          let next3 = "";
          try {
            const p = parseCron(r.cron);
            let f = new Date();
            const out: Date[] = [];
            for (let i = 0; i < 3; i++) {
              const n = nextCronRun(p, f);
              out.push(n);
              f = new Date(n.getTime() + 1000);
            }
            next3 = out
              .map(
                (d) =>
                  `<span class="cron-pill">${d.toLocaleTimeString()}</span>`,
              )
              .join("");
          } catch {}
          const inS = Math.max(0, Math.round((r.next_run - Date.now()) / 1000));
          const fired = cronFires[r.name] ?? 0;
          return `<div class="cron-card">
          <div class="cron-row"><b>${escapeHtml(r.name)}</b><code>${escapeHtml(r.cron)}</code><button class="btn-delete" title="remove" style="margin-left:auto" onclick="window.__delCron('${escapeHtml(r.name)}')">×</button></div>
          <div class="cron-row"><span class="cron-k">next run</span><b>in ${inS}s</b> · ${new Date(r.next_run).toLocaleTimeString()}</div>
          <div class="cron-row"><span class="cron-k">fired</span><b>${fired}×</b>${r.last_run ? ` · last ${new Date(r.last_run).toLocaleTimeString()}` : ""}</div>
          <div class="cron-runs">${next3}</div>
        </div>`;
        })
        .join("")
    : `<div class="empty">No schedules yet — add one above.</div>`;
}
(window as any).__delCron = (name: string) => {
  try {
    cron.unschedule(name);
  } catch {}
  delete cronFires[name];
  renderCrons();
};

// ── Shared rendering ─────────────────────────────────────────────────────────
function card(d: any, q: string, badge?: string): string {
  return `<div class="memory-card">
    <div class="memory-title">${hl(d.title, q)}</div>
    <div class="memory-content">${hl(d.content, q)}</div>
    <div class="memory-footer">
      <div class="memory-tags">${formatTags(d.tags)}</div>
      ${badge ? `<span class="score">${badge}</span>` : ""}
      <button class="btn-delete" onclick="window.__del('${d._id}')">×</button>
    </div>
  </div>`;
}
function hl(text: string, q: string): string {
  const safe = escapeHtml(text || "");
  if (!q) return safe;
  let out = safe;
  for (const t of q
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 1))
    out = out.replace(
      new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"),
      "<mark>$1</mark>",
    );
  return out;
}
function formatTags(tags: string): string {
  return (tags || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `<span class="tag">#${escapeHtml(t)}</span>`)
    .join("");
}
function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

function updateStats() {
  $("stat-size").textContent =
    `${(exportDatabase(db).byteLength / 1024).toFixed(0)} KB`;
  memories.count().then((n: number) => {
    $("stat-docs").textContent = `${n} docs`;
  });
}

// ── SQL log ─────────────────────────────────────────────────────────────────
// Show only the useful "action" queries — the writes you trigger (on real tables)
// and searches (FTS5 / vec0 use MATCH). Drop the noise: polling reads (queue status,
// cron ticks, list re-renders) AND the plugin/sync plumbing that fires on every write
// (`_monlite_*` change feed + vec state, and the `*_vec` / `*_fts` index shadows).
function isActionSql(sql: string): boolean {
  const s = sql.trim();
  if (/\bMATCH\b/i.test(s)) return true; // a search
  if (!/^(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(s)) return false; // not a write → polling/DDL
  if (/_monlite_\w+|\b\w+_vec\b|\b\w+_fts\b/i.test(s)) return false; // internal index/sync plumbing
  return true; // a real write (memories, _jobs, _schedules, _kv)
}
function addSqlLog(sql: string, ms: number) {
  if (!isActionSql(sql)) return;
  sqlLog.unshift({ sql: sql.length > 120 ? sql.slice(0, 120) + "…" : sql, ms });
  if (sqlLog.length > 40) sqlLog.pop();
  $("sql-log").innerHTML = sqlLog
    .map(
      (e) =>
        `<div class="sql-entry"><span class="sql-text">${escapeHtml(e.sql)}</span><span class="sql-time">${e.ms.toFixed(1)}ms</span></div>`,
    )
    .join("");
}

function setModelStatus(s: string) {
  $("model-status").textContent = s;
}
function shake(el: HTMLElement) {
  el.style.animation = "none";
  el.getBoundingClientRect();
  el.style.animation = "shake .3s";
}
function setLoadingText(s: string) {
  $("loading-text").textContent = s;
}
function hideLoading() {
  const el = $("loading");
  el.classList.add("hidden");
  setTimeout(() => el.remove(), 400);
}

(window as any).__del = async (id: string) => {
  await memories.delete({ where: { _id: id } });
};

init().catch((err) => {
  console.error(err);
  setLoadingText(`Error: ${err.message}`);
});
