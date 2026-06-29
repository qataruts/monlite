import { describe, it, expect, afterEach } from "vitest";
import type { Server } from "node:http";
import {
  createDb,
  type Monlite,
  type MonliteOptions,
  type LiveEvent,
} from "@monlite/core";
import { realtime } from "../src/index";
import { connectRealtime } from "../src/client";

const driver = process.env.MONLITE_DRIVER as
  | MonliteOptions["driver"]
  | undefined;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function openDb(): Monlite {
  const db = createDb(":memory:", {
    changefeed: true,
    reactorPollMs: 30,
    ...(driver ? { driver } : {}),
  });
  cleanups.push(() => db.$disconnect());
  return db;
}

function listen(server: ReturnType<typeof realtime>): {
  url: string;
  http: Server;
} {
  const http = server.listen(0);
  cleanups.push(() => {
    server.close();
    http.close();
  });
  const port = (http.address() as any).port as number;
  return { url: `http://127.0.0.1:${port}`, http };
}

const waitFor = async (fn: () => boolean, ms = 3000): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("waitFor timed out");
};

describe("@monlite/realtime (SSE gateway + client)", () => {
  it("streams a live query: init snapshot, then add/remove over the wire", async () => {
    const db = openDb();
    await db
      .collection("orders")
      .create({ data: { _id: "a", status: "open" } });
    const { url } = listen(realtime({ db }));
    const client = connectRealtime(url);
    cleanups.push(() => client.close());

    const events: LiveEvent[] = [];
    client
      .collection("orders")
      .where({ status: "open" })
      .onSnapshot((e) => events.push(e));

    await waitFor(() => events.length >= 1);
    expect(events[0].type).toBe("init");
    expect(events[0].results.map((d) => d._id)).toEqual(["a"]);

    await db
      .collection("orders")
      .create({ data: { _id: "b", status: "open" } });
    await waitFor(() => events.some((e) => e.added.some((d) => d._id === "b")));

    await db
      .collection("orders")
      .update({ where: { _id: "a" }, data: { status: "closed" } });
    await waitFor(() =>
      events.some((e) => e.removed.some((d) => d._id === "a")),
    );
  });

  it("streams a single document, with null on delete", async () => {
    const db = openDb();
    await db.collection("orders").create({ data: { _id: "x", n: 1 } });
    const { url } = listen(realtime({ db }));
    const client = connectRealtime(url);
    cleanups.push(() => client.close());

    const seen: (number | null)[] = [];
    client.doc<{ n: number }>("orders", "x", (doc) =>
      seen.push(doc ? doc.n : null),
    );

    await waitFor(() => seen.length >= 1);
    expect(seen[0]).toBe(1);
    await db
      .collection("orders")
      .update({ where: { _id: "x" }, data: { $set: { n: 2 } } });
    await waitFor(() => seen.includes(2));
    await db.collection("orders").delete({ where: { _id: "x" } });
    await waitFor(() => seen.includes(null));
  });

  it("rejects unauthorized subscriptions (no events delivered)", async () => {
    const db = openDb();
    await db.collection("orders").create({ data: { _id: "a" } });
    const { url } = listen(
      realtime({
        authorize: (req) =>
          req.headers.authorization === "Bearer good" ? { db } : null,
      }),
    );

    const bad = connectRealtime(url, { token: "bad", reconnectMs: 50 });
    cleanups.push(() => bad.close());
    const got: LiveEvent[] = [];
    bad.collection("orders").onSnapshot((e) => got.push(e));
    await new Promise((r) => setTimeout(r, 250));
    expect(got).toHaveLength(0); // unauthorized → never streams

    const good = connectRealtime(url, { token: "good" });
    cleanups.push(() => good.close());
    const ok: LiveEvent[] = [];
    good.collection("orders").onSnapshot((e) => ok.push(e));
    await waitFor(() => ok.length >= 1);
    expect(ok[0].results.map((d) => d._id)).toEqual(["a"]);
  });

  it("honors a field-scoped subscription over the wire", async () => {
    const db = openDb();
    const d = await db
      .collection("t")
      .create({ data: { status: "open", note: "x" } });
    const { url } = listen(realtime({ db }));
    const client = connectRealtime(url);
    cleanups.push(() => client.close());

    const events: LiveEvent[] = [];
    client
      .collection("t")
      .fields(["status"])
      .onSnapshot((e) => events.push(e));
    await waitFor(() => events.length >= 1); // init
    const afterInit = events.length;

    await db
      .collection("t")
      .update({ where: { _id: d._id }, data: { $set: { note: "y" } } });
    await new Promise((r) => setTimeout(r, 200));
    expect(events.length).toBe(afterInit); // non-watched field → no event

    await db
      .collection("t")
      .update({ where: { _id: d._id }, data: { $set: { status: "closed" } } });
    await waitFor(() => events.length > afterInit); // watched field → event
  });
});
