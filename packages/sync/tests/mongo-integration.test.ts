import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { MongoClient } from "mongodb";
import { createDb, type Monlite } from "@monlite/core";
import { sync, MongoAdapter, type SyncEngine } from "../src/index";

/**
 * Live integration tests against a real MongoDB replica set.
 * Run with: MONGO_URL="mongodb://localhost:27018/?directConnection=true" pnpm test
 * Skipped automatically when MONGO_URL is unset.
 */
const MONGO_URL = process.env.MONGO_URL;
const run = MONGO_URL ? describe : describe.skip;

let client: MongoClient;
let counter = 0;
const freshDb = () => `monlite_it_${counter++}`;

const locals: Monlite[] = [];
const engines: SyncEngine[] = [];
const mongoDbs: string[] = [];

function local(nodeId: string): Monlite {
  const d = createDb(":memory:", { sync: true, nodeId });
  locals.push(d);
  return d;
}
function adapter(db: string) {
  return new MongoAdapter({ client, db });
}
async function waitFor(cond: () => Promise<boolean>, ms = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("waitFor timed out");
}

beforeAll(async () => {
  if (!MONGO_URL) return;
  client = new MongoClient(MONGO_URL);
  await client.connect();
});
afterAll(async () => {
  if (client) await client.close();
});
afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop();
  for (const d of locals.splice(0)) await d.$disconnect();
  for (const name of mongoDbs.splice(0)) await client.db(name).dropDatabase();
});

run("MongoAdapter — live MongoDB", () => {
  it("pushes documents with version + soft-delete metadata", async () => {
    const dbName = freshDb();
    mongoDbs.push(dbName);
    const a = local("A");
    const e = sync(a, {
      adapter: adapter(dbName),
      collections: ["users"],
      mode: "push",
    });
    engines.push(e);

    await a
      .collection("users")
      .create({ data: { _id: "u1", name: "Ali", age: 28 } });
    await e.start();

    const doc: any = await client.db(dbName).collection("users").findOne({});
    expect(doc).toMatchObject({
      name: "Ali",
      age: 28,
      _monlite_deleted: false,
    });
    expect(typeof doc._monlite_v).toBe("string");
  });

  it("round-trips A -> Mongo -> B (two clients, one cloud)", async () => {
    const dbName = freshDb();
    mongoDbs.push(dbName);
    const a = local("A");
    const b = local("B");
    const ea = sync(a, {
      adapter: adapter(dbName),
      collections: ["docs"],
      mode: "two-way",
    });
    const eb = sync(b, {
      adapter: adapter(dbName),
      collections: ["docs"],
      mode: "two-way",
    });
    engines.push(ea, eb);

    await a.collection("docs").create({ data: { _id: "d1", who: "a" } });
    await ea.start(); // push d1 -> Mongo
    await eb.start(); // pull d1 -> B
    expect(await b.collection("docs").findById("d1")).toMatchObject({
      who: "a",
    });

    await b.collection("docs").create({ data: { _id: "d2", who: "b" } });
    await eb.sync(); // push d2
    await ea.sync(); // pull d2
    expect(await a.collection("docs").findById("d2")).toMatchObject({
      who: "b",
    });
  });

  it("propagates deletes through Mongo (soft-delete tombstones)", async () => {
    const dbName = freshDb();
    mongoDbs.push(dbName);
    const a = local("A");
    const b = local("B");
    const ea = sync(a, {
      adapter: adapter(dbName),
      collections: ["docs"],
      mode: "two-way",
    });
    const eb = sync(b, {
      adapter: adapter(dbName),
      collections: ["docs"],
      mode: "two-way",
    });
    engines.push(ea, eb);

    await a.collection("docs").create({ data: { _id: "d1", n: 1 } });
    await ea.start();
    await eb.start();
    expect(await b.collection("docs").findById("d1")).toBeTruthy();

    await a.collection("docs").delete({ where: { _id: "d1" } });
    await ea.sync(); // push delete
    await eb.sync(); // pull delete
    expect(await b.collection("docs").findById("d1")).toBeNull();

    const mdoc: any = await client
      .db(dbName)
      .collection("docs")
      .findOne({ _id: "d1" as any });
    expect(mdoc?._monlite_deleted).toBe(true);
  });

  it("converges on a two-writer conflict (last-write-wins)", async () => {
    const dbName = freshDb();
    mongoDbs.push(dbName);
    const a = local("A");
    const b = local("B");
    const ea = sync(a, {
      adapter: adapter(dbName),
      collections: ["docs"],
      mode: "two-way",
    });
    const eb = sync(b, {
      adapter: adapter(dbName),
      collections: ["docs"],
      mode: "two-way",
    });
    engines.push(ea, eb);

    await a.collection("docs").create({ data: { _id: "d1", v: "a1" } });
    await ea.start();
    await eb.start();

    // Both edit the same doc, then everyone syncs a few rounds.
    await a
      .collection("docs")
      .update({ where: { _id: "d1" }, data: { v: "a2" } });
    await b
      .collection("docs")
      .update({ where: { _id: "d1" }, data: { v: "b2" } });
    for (let i = 0; i < 4; i++) {
      await ea.sync();
      await eb.sync();
    }

    const av = (await a.collection("docs").findById("d1"))!.v;
    const bv = (await b.collection("docs").findById("d1"))!.v;
    expect(av).toBe(bv); // converged to a single value
  });

  it("applies remote writes live via change streams", async () => {
    const dbName = freshDb();
    mongoDbs.push(dbName);
    const a = local("A");
    const b = local("B");
    const ea = sync(a, {
      adapter: adapter(dbName),
      collections: ["docs"],
      mode: "push",
    });
    const eb = sync(b, {
      adapter: adapter(dbName),
      collections: ["docs"],
      mode: "pull",
      live: true,
    });
    engines.push(ea, eb);

    await eb.start(); // begins watching the change stream
    await a.collection("docs").create({ data: { _id: "live1", x: 1 } });
    await ea.start(); // push -> Mongo insert -> change stream -> B applies

    await waitFor(
      async () => (await b.collection("docs").findById("live1")) != null,
    );
    expect(await b.collection("docs").findById("live1")).toMatchObject({
      x: 1,
    });
  });
});
