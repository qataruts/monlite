// monlite benchmark — run with: node bench/bench.mjs
// In-memory across all engines to isolate engine overhead (no disk I/O variance).
import { performance } from "node:perf_hooks";
import { createDb } from "../dist/index.js";
import Database from "better-sqlite3";
import Datastore from "@seald-io/nedb";
import { Low, Memory } from "lowdb";

const N = 10_000; // documents
const READS = 5_000; // point lookups
const QUERY_RUNS = 5;

const data = Array.from({ length: N }, (_, i) => ({
  name: "user" + i,
  age: 18 + (i % 60),
  city: ["Riyadh", "Jeddah", "Mecca", "Medina"][i % 4],
  active: i % 2 === 0,
}));

const now = () => performance.now();
const med = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const ops = (ms, count) => Math.round((count / ms) * 1000).toLocaleString();

// ---- engines: each returns { insert, read, query } median ms over a few runs ----

async function monlite({ driver, structured }) {
  const insertRuns = [];
  let warm;
  for (let r = 0; r < 3; r++) {
    const db = createDb(":memory:", driver ? { driver } : {});
    const c = structured
      ? db.collection("u", {
          schema: { age: { type: "INTEGER", index: true }, name: "TEXT" },
        })
      : db.collection("u");
    const t = now();
    await c.createMany({ data });
    insertRuns.push(now() - t);
    if (r === 2) warm = { db, c };
    else await db.$disconnect();
  }
  const { db, c } = warm;
  const ids = (await c.findMany({ select: { _id: true } })).map((d) => d._id);

  let t = now();
  for (let i = 0; i < READS; i++) await c.findById(ids[i % ids.length]);
  const read = now() - t;

  const q = [];
  for (let r = 0; r < QUERY_RUNS; r++) {
    t = now();
    await c.findMany({ where: { age: { gte: 40 } } });
    q.push(now() - t);
  }
  await db.$disconnect();
  return { insert: med(insertRuns), read, query: med(q) };
}

function rawSqlite() {
  const insertRuns = [];
  let warm;
  for (let r = 0; r < 3; r++) {
    const db = new Database(":memory:");
    db.exec(
      "CREATE TABLE u (id INTEGER PRIMARY KEY, name TEXT, age INTEGER, city TEXT, active INTEGER)",
    );
    db.exec("CREATE INDEX idx_age ON u(age)");
    const ins = db.prepare(
      "INSERT INTO u (name,age,city,active) VALUES (?,?,?,?)",
    );
    const all = db.transaction((rows) => {
      for (const x of rows) ins.run(x.name, x.age, x.city, x.active ? 1 : 0);
    });
    const t = now();
    all(data);
    insertRuns.push(now() - t);
    if (r === 2) warm = db;
    else db.close();
  }
  const db = warm;
  const byId = db.prepare("SELECT * FROM u WHERE id = ?");
  let t = now();
  for (let i = 0; i < READS; i++) byId.get((i % N) + 1);
  const read = now() - t;
  const sel = db.prepare("SELECT * FROM u WHERE age >= ?");
  const q = [];
  for (let r = 0; r < QUERY_RUNS; r++) {
    t = now();
    sel.all(40);
    q.push(now() - t);
  }
  db.close();
  return { insert: med(insertRuns), read, query: med(q) };
}

async function nedb() {
  const insertRuns = [];
  let warm;
  for (let r = 0; r < 3; r++) {
    const db = new Datastore();
    const t = now();
    await db.insertAsync(data);
    insertRuns.push(now() - t);
    if (r === 2) warm = db;
  }
  const db = warm;
  const docs = await db.findAsync({});
  const ids = docs.map((d) => d._id);
  let t = now();
  for (let i = 0; i < READS; i++)
    await db.findOneAsync({ _id: ids[i % ids.length] });
  const read = now() - t;
  const q = [];
  for (let r = 0; r < QUERY_RUNS; r++) {
    t = now();
    await db.findAsync({ age: { $gte: 40 } });
    q.push(now() - t);
  }
  return { insert: med(insertRuns), read, query: med(q) };
}

async function lowdb() {
  const insertRuns = [];
  let warm;
  for (let r = 0; r < 3; r++) {
    const db = new Low(new Memory(), { u: [] });
    await db.read();
    const rows = data.map((d, i) => ({ _id: String(i), ...d }));
    const t = now();
    db.data.u = rows;
    await db.write();
    insertRuns.push(now() - t);
    if (r === 2) warm = db;
  }
  const db = warm;
  let t = now();
  for (let i = 0; i < READS; i++)
    db.data.u.find((x) => x._id === String(i % N));
  const read = now() - t;
  const q = [];
  for (let r = 0; r < QUERY_RUNS; r++) {
    t = now();
    db.data.u.filter((x) => x.age >= 40);
    q.push(now() - t);
  }
  return { insert: med(insertRuns), read, query: med(q) };
}

const results = [];
results.push(["monlite (document)", await monlite({ structured: false })]);
results.push(["monlite (structured)", await monlite({ structured: true })]);
results.push([
  "monlite (node:sqlite)",
  await monlite({ driver: "node:sqlite" }),
]);
results.push(["raw better-sqlite3", rawSqlite()]);
results.push(["@seald-io/nedb", await nedb()]);
results.push(["lowdb", await lowdb()]);

console.log(
  `\nN=${N} docs, ${READS} point reads, query = where age>=40 (~${Math.round(
    data.filter((d) => d.age >= 40).length,
  )} rows), median of runs. Node ${process.versions.node}.\n`,
);
const pad = (s, n) => String(s).padEnd(n);
console.log(
  pad("engine", 22),
  pad("insert 10k", 16),
  pad("5k reads", 16),
  pad("query", 16),
);
console.log("-".repeat(70));
for (const [name, r] of results) {
  console.log(
    pad(name, 22),
    pad(`${r.insert.toFixed(0)}ms (${ops(r.insert, N)}/s)`, 16),
    pad(`${r.read.toFixed(0)}ms (${ops(r.read, READS)}/s)`, 16),
    pad(`${r.query.toFixed(1)}ms`, 16),
  );
}
console.log();
