// The single-page inspector UI, served as one HTML string (no build step).
export const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>monlite studio</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; color: #1c2333; background: #f6f7f9; }
  header { display: flex; align-items: baseline; gap: 12px; padding: 10px 16px; background: #11151c; color: #fff; }
  header b { font-size: 15px; } header span { color: #9aa4b2; font-size: 12px; overflow: hidden; text-overflow: ellipsis; }
  .layout { display: flex; height: calc(100vh - 44px); }
  aside { width: 240px; border-right: 1px solid #e3e6ea; overflow: auto; background: #fff; }
  aside .c { padding: 9px 16px; cursor: pointer; display: flex; justify-content: space-between; border-bottom: 1px solid #f0f1f3; }
  aside .c:hover { background: #f0f4ff; } aside .c.active { background: #e7efff; font-weight: 600; }
  aside .c .n { color: #8a93a2; font-variant-numeric: tabular-nums; }
  main { flex: 1; overflow: auto; padding: 16px; }
  .bar { display: flex; gap: 8px; margin-bottom: 12px; align-items: center; flex-wrap: wrap; }
  textarea, input { font: 13px ui-monospace, monospace; border: 1px solid #cfd4db; border-radius: 6px; padding: 6px 8px; }
  textarea { flex: 1; min-width: 240px; height: 34px; resize: vertical; }
  input.lim { width: 70px; } button { border: 0; border-radius: 6px; padding: 7px 12px; background: #2563eb; color: #fff; cursor: pointer; }
  button.ghost { background: #eef0f3; color: #1c2333; } button:hover { filter: brightness(1.05); }
  .doc { background: #fff; border: 1px solid #e3e6ea; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; position: relative; }
  .doc pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: 12.5px ui-monospace, monospace; }
  .doc .del { position: absolute; top: 8px; right: 8px; background: #fee2e2; color: #b91c1c; padding: 3px 8px; font-size: 12px; }
  .meta { color: #8a93a2; margin: 4px 0 12px; } .empty { color: #8a93a2; padding: 24px; text-align: center; }
  .err { color: #b91c1c; background: #fee2e2; padding: 8px 12px; border-radius: 6px; }
</style>
</head>
<body>
<header><b>🌙 monlite studio</b><span id="path"></span></header>
<div class="layout">
  <aside id="side"></aside>
  <main>
    <div id="head"></div>
    <div class="bar" id="bar" style="display:none">
      <textarea id="where" placeholder='filter (JSON), e.g. {"age":{"gte":18}}'></textarea>
      <input class="lim" id="limit" type="number" value="50" min="1" max="500" />
      <button id="run">Run</button>
      <button class="ghost" id="prev">‹ Prev</button>
      <button class="ghost" id="next">Next ›</button>
    </div>
    <div id="meta" class="meta"></div>
    <div id="rows"></div>
  </main>
</div>
<script>
const $ = (id) => document.getElementById(id);
let active = null, skip = 0;

async function api(url, opts) {
  const r = await fetch(url, opts);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

async function boot() {
  const meta = await api("/api/meta");
  $("path").textContent = meta.path + (meta.readonly ? " (read-only)" : "");
  $("side").innerHTML = "";
  if (!meta.collections.length) $("side").innerHTML = '<div class="empty">No collections</div>';
  for (const c of meta.collections) {
    const el = document.createElement("div");
    el.className = "c"; el.dataset.name = c.name;
    el.innerHTML = '<span>' + c.name + '</span><span class="n">' + c.count + '</span>';
    el.onclick = () => select(c.name);
    $("side").appendChild(el);
  }
}

function select(name) {
  active = name; skip = 0;
  for (const el of document.querySelectorAll("aside .c")) el.classList.toggle("active", el.dataset.name === name);
  $("head").innerHTML = "<h2 style='margin:0 0 10px'>" + name + "</h2>";
  $("bar").style.display = "flex";
  load();
}

async function load() {
  if (!active) return;
  const where = $("where").value.trim();
  const limit = $("limit").value || 50;
  let url = "/api/docs?collection=" + encodeURIComponent(active) + "&limit=" + limit + "&skip=" + skip;
  if (where) url += "&where=" + encodeURIComponent(where);
  try {
    const { results, total } = await api(url);
    $("meta").textContent = total + " document" + (total === 1 ? "" : "s") +
      (total > results.length ? "  ·  showing " + (skip + 1) + "–" + (skip + results.length) : "");
    $("rows").innerHTML = results.length ? "" : '<div class="empty">No matching documents</div>';
    for (const doc of results) {
      const d = document.createElement("div"); d.className = "doc";
      const pre = document.createElement("pre"); pre.textContent = JSON.stringify(doc, null, 2);
      d.appendChild(pre);
      const del = document.createElement("button"); del.className = "del"; del.textContent = "Delete";
      del.onclick = () => remove(doc._id);
      d.appendChild(del);
      $("rows").appendChild(d);
    }
  } catch (e) { $("rows").innerHTML = '<div class="err">' + e.message + '</div>'; $("meta").textContent = ""; }
}

async function remove(id) {
  if (!confirm("Delete " + id + "?")) return;
  await api("/api/docs?collection=" + encodeURIComponent(active) + "&id=" + encodeURIComponent(id), { method: "DELETE" });
  boot(); load();
}

$("run").onclick = () => { skip = 0; load(); };
$("next").onclick = () => { skip += Number($("limit").value || 50); load(); };
$("prev").onclick = () => { skip = Math.max(0, skip - Number($("limit").value || 50)); load(); };
$("where").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { skip = 0; load(); } });
boot();
</script>
</body>
</html>`;
