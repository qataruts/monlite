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
let sqlLog: { sql: string; ms: number }[] = [];

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
    driver: wasmDriver(SQL, { onQuery: (e) => addSqlLog(e.sql.trim(), e.durationMs) }),
    plugins: [
      fts({ memories: ["title", "content", "tags"] }),
      vector({ memories: { field: "embedding", dimensions: 384, distance: "cosine" } }),
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
      { title: "Black holes and dark matter", content: "Black holes form when massive stars collapse under their own gravity. Dark matter makes up ~27% of the universe, interacting only through gravity — invisible but detectable by its gravitational pull.", tags: "physics space cosmology" },
      { title: "Machine learning fundamentals", content: "Neural networks adjust weights through backpropagation to minimize a loss function. Transformers use self-attention to process sequences in parallel, powering models like GPT and BERT.", tags: "ai ml transformers" },
      { title: "Building local-first applications", content: "Local-first apps store data on-device and sync to the cloud when available. SQLite is ideal for embedded use — zero config, ACID transactions, and millions of reads per second.", tags: "local-first sqlite offline" },
      { title: "Vector search and RAG", content: "Retrieval-Augmented Generation finds relevant context using vector similarity search before generating a response. Embeddings map text to a space where similar passages cluster together.", tags: "ai embeddings rag retrieval" },
      { title: "Durable job queues", content: "Durable queues persist jobs to disk so they survive restarts. Atomic claims via database transactions prevent two workers from processing the same job — the guarantee Redis and BullMQ give you, over a file.", tags: "architecture queues workers" },
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
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      $(`panel-${tab.dataset.tab}`).classList.add("active");
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
    const tags = ($("mem-tags") as HTMLInputElement).value.trim().replace(/,/g, " ");
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
  for (const d of docs) for (const t of (d.tags || "").split(/\s+/).filter(Boolean)) freq[t] = (freq[t] || 0) + 1;
  const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 8);
  $("agg").innerHTML = top.length
    ? `<span class="agg-label">tag breakdown</span>` + top.map(([t, n]) => `<span class="tag">#${t}<b>${n}</b></span>`).join("")
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
  clear.addEventListener("click", () => { input.value = ""; clear.style.display = "none"; runSearch(""); });
  runSearch("");
}

async function runSearch(q: string) {
  q = q.trim();
  let docs: any[];
  let isSearch = false;
  if (q) {
    try { docs = await memories.search(q, { limit: 30 }); isSearch = true; }
    catch { docs = await memories.findMany({ orderBy: { created_at: "desc" } }); }
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
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => runVector(input.value), 350); });
}

async function loadModel() {
  const btn = $("btn-load-model") as HTMLButtonElement;
  btn.disabled = true;
  try {
    setModelStatus("Downloading Transformers.js…");
    // Load from CDN (avoids bundling onnxruntime). Runs on-device.
    const TF: any = await import(/* @vite-ignore */ "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.2");
    TF.env.allowLocalModels = false;
    setModelStatus("Downloading model — all-MiniLM-L6-v2 (~23 MB, one-time)…");
    embedder = await TF.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
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
  if (!q || !embedder) return;
  const v = await embed(q);
  const hits = await memories.findSimilar({ vector: v, topK: 5 });
  $("vec-count").textContent = `${hits.length} by meaning`;
  $("vector-grid").innerHTML = hits
    .map((d: any) => card(d, "", `${((1 - d._distance) * 100).toFixed(0)}% match`))
    .join("");
}

// ── Cache (kv) ───────────────────────────────────────────────────────────────
let countdownId: any;
function setupKv() {
  $("btn-set").addEventListener("click", () => {
    const key = (($("kv-key") as HTMLInputElement).value).trim();
    const val = (($("kv-value") as HTMLInputElement).value).trim();
    const ttl = parseInt(($("kv-ttl") as HTMLInputElement).value) || 0;
    if (!key || !val) return;
    cache.set(key, val, ttl ? { ttl } : undefined);
    clearInterval(countdownId);
    if (ttl) {
      const end = Date.now() + ttl;
      const res = $("kv-result"); res.className = "kv-result success";
      countdownId = setInterval(() => {
        const left = Math.max(0, end - Date.now());
        if (left === 0) { clearInterval(countdownId); res.textContent = `⏱ "${key}" expired`; res.className = "kv-result error"; }
        else res.textContent = `✓ set "${key}" → expires in ${(left / 1000).toFixed(1)}s`;
      }, 80);
    } else setKv(`✓ set "${key}" = "${val}"`, "success");
  });
  $("btn-get").addEventListener("click", () => {
    const key = (($("kv-key") as HTMLInputElement).value).trim(); if (!key) return;
    clearInterval(countdownId);
    const value = cache.get(key);
    if (value === undefined) setKv(`✗ "${key}" not found or expired`, "error");
    else { const t = cache.ttl(key); const s = t === -1 ? "no expiry" : t === -2 ? "absent" : `${t}ms left`; setKv(`→ "${key}" = ${JSON.stringify(value)}  (${s})`, "success"); }
  });
  $("btn-del").addEventListener("click", () => {
    const key = (($("kv-key") as HTMLInputElement).value).trim(); if (!key) return;
    cache.delete(key); clearInterval(countdownId); setKv(`✓ deleted "${key}"`, "success");
  });
}
function setKv(msg: string, type: "success" | "error") { const el = $("kv-result"); el.textContent = msg; el.className = `kv-result ${type}`; }

// ── Queue (queue) ────────────────────────────────────────────────────────────
let jobIds: number[] = [];
let jobSeq = 0;
function setupQueue() {
  queue.process("tasks", async (job: any) => {
    await sleep(500 + Math.random() * 500);
    if (job.attempts < 2 && Math.random() < 0.33) throw new Error("transient failure");
    return "ok";
  }, { concurrency: 2, pollInterval: 300 });
  queue.on("completed", renderJobs);
  queue.on("failed", renderJobs);
  $("btn-add-job").addEventListener("click", () => addJob());
  $("btn-add-5").addEventListener("click", () => { for (let i = 0; i < 5; i++) addJob(); });
  setInterval(() => { if ($("panel-queue").classList.contains("active")) renderJobs(); }, 500);
  renderJobs();
}
function addJob() {
  const job = queue.add("tasks", { label: `task #${++jobSeq}` });
  jobIds.unshift(job.id); jobIds = jobIds.slice(0, 12); renderJobs();
}
function renderJobs() {
  const c = queue.counts("tasks");
  $("job-counts").innerHTML = (["pending", "active", "done", "failed"] as const)
    .map((s) => `<span class="count count-${s}">${c[s] || 0} ${s}</span>`).join("");
  $("job-list").innerHTML = jobIds.length
    ? jobIds.map((id) => {
        const j: any = queue.getJob(id); if (!j) return "";
        const label = j.payload?.label ?? `job ${id}`;
        return `<div class="job"><span class="job-status status-${j.status}">${j.status}</span><span class="job-label">${escapeHtml(label)}</span><span class="job-meta">attempt ${j.attempts}/${j.maxAttempts ?? 3}</span></div>`;
      }).join("")
    : `<div class="empty">No jobs yet — enqueue one.</div>`;
}

// ── Cron (cron) ──────────────────────────────────────────────────────────────
let cronFires = 0;
let lastFire: number | null = null;
function setupCron() {
  $("btn-cron").addEventListener("click", scheduleCron);
  setInterval(() => { if ($("panel-cron").classList.contains("active")) renderCron(); }, 1000);
}
function scheduleCron() {
  const expr = ($("cron-expr") as HTMLInputElement).value.trim();
  try { parseCron(expr); } catch (e: any) { $("cron-out").innerHTML = `<div class="cron-err">Invalid: ${escapeHtml(e.message)}</div>`; return; }
  cronFires = 0; lastFire = null;
  try { cron.unschedule("demo"); } catch {}
  cron.schedule("demo", expr, () => { cronFires++; lastFire = Date.now(); renderCron(); });
  renderCron();
}
function renderCron() {
  const expr = ($("cron-expr") as HTMLInputElement).value.trim();
  let parsed; try { parsed = parseCron(expr); } catch { return; }
  const runs: Date[] = []; let from = new Date();
  for (let i = 0; i < 3; i++) { const n = nextCronRun(parsed, from); runs.push(n); from = new Date(n.getTime() + 1000); }
  const next = runs[0]; const inS = Math.max(0, Math.round((next.getTime() - Date.now()) / 1000));
  $("cron-out").innerHTML = `
    <div class="cron-card">
      <div class="cron-row"><span class="cron-k">scheduled</span><code>${escapeHtml(expr)}</code></div>
      <div class="cron-row"><span class="cron-k">fired</span><b>${cronFires}×</b>${lastFire ? ` · last ${new Date(lastFire).toLocaleTimeString()}` : ""}</div>
      <div class="cron-row"><span class="cron-k">next run</span><b>in ${inS}s</b> · ${next.toLocaleTimeString()}</div>
      <div class="cron-runs">${runs.map((r) => `<span class="cron-pill">${r.toLocaleTimeString()}</span>`).join("")}</div>
    </div>`;
}

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
  for (const t of q.trim().split(/\s+/).filter((t) => t.length > 1))
    out = out.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "<mark>$1</mark>");
  return out;
}
function formatTags(tags: string): string {
  return (tags || "").split(/\s+/).filter(Boolean).map((t) => `<span class="tag">#${escapeHtml(t)}</span>`).join("");
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function updateStats() {
  $("stat-size").textContent = `${(exportDatabase(db).byteLength / 1024).toFixed(0)} KB`;
  memories.count().then((n: number) => { $("stat-docs").textContent = `${n} docs`; });
}

// ── SQL log ─────────────────────────────────────────────────────────────────
function addSqlLog(sql: string, ms: number) {
  sqlLog.unshift({ sql: sql.length > 120 ? sql.slice(0, 120) + "…" : sql, ms });
  if (sqlLog.length > 40) sqlLog.pop();
  $("sql-log").innerHTML = sqlLog.slice(0, 14).map((e) =>
    `<div class="sql-entry"><span class="sql-text">${escapeHtml(e.sql)}</span><span class="sql-time">${e.ms.toFixed(1)}ms</span></div>`).join("");
}

function setModelStatus(s: string) { $("model-status").textContent = s; }
function shake(el: HTMLElement) { el.style.animation = "none"; el.getBoundingClientRect(); el.style.animation = "shake .3s"; }
function setLoadingText(s: string) { $("loading-text").textContent = s; }
function hideLoading() { const el = $("loading"); el.classList.add("hidden"); setTimeout(() => el.remove(), 400); }

(window as any).__del = async (id: string) => { await memories.delete({ where: { _id: id } }); };

init().catch((err) => { console.error(err); setLoadingText(`Error: ${err.message}`); });
