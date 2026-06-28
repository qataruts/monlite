import { describe, it, expect } from "vitest";
import { ObjectId } from "mongodb";
import { MongoAdapter } from "../src/index";
import type { LocalChange } from "@monlite/core";

/**
 * The Mongo adapter is unit-tested against a fake client that records the
 * driver calls (real change-stream behavior needs a live replica set, which CI
 * can't run). This verifies the translation: ObjectId mapping, bulkWrite op
 * shapes, soft-deletes, and the pull cursor.
 */
class FakeCollection {
  ops: any[] = [];
  constructor(public docs: any[] = []) {}
  async bulkWrite(ops: any[]) {
    this.ops.push(...ops);
    return { ok: 1 };
  }
  find(filter: any) {
    const docs = this.docs;
    return {
      sort() {
        return this;
      },
      async toArray() {
        const gt = filter?._monlite_v?.$gt;
        return gt === undefined
          ? docs
          : docs.filter((d) => (d._monlite_v ?? "") > gt);
      },
    };
  }
}
class FakeClient {
  constructor(private colls: Record<string, FakeCollection>) {}
  db() {
    return {
      collection: (n: string) =>
        this.colls[n] ?? (this.colls[n] = new FakeCollection()),
    };
  }
}

const HEX1 = "0123456789abcdef01234567";
const HEX2 = "0123456789abcdef01234568";

describe("MongoAdapter translation", () => {
  it("push: upsert -> replaceOne, delete -> soft-delete updateOne", async () => {
    const users = new FakeCollection();
    const adapter = new MongoAdapter({
      client: new FakeClient({ users }) as any,
      db: "app",
    });

    const changes: LocalChange[] = [
      {
        seq: 1,
        collection: "users",
        _id: HEX1,
        op: "upsert",
        version: "v1",
        ts: 1,
        doc: { _id: HEX1, name: "Ali" },
      },
      {
        seq: 2,
        collection: "users",
        _id: HEX2,
        op: "delete",
        version: "v2",
        ts: 2,
      },
    ];
    const res = await adapter.push(changes);

    expect(res.acked).toHaveLength(2);
    expect(users.ops).toHaveLength(2);

    const [up, del] = users.ops;
    expect(up.replaceOne.upsert).toBe(true);
    expect(up.replaceOne.replacement.name).toBe("Ali");
    expect(up.replaceOne.replacement._monlite_v).toBe("v1");
    expect(up.replaceOne.filter._id).toBeInstanceOf(ObjectId);
    expect(up.replaceOne.filter._id.toString()).toBe(HEX1);

    expect(del.updateOne.update.$set._monlite_deleted).toBe(true);
    expect(del.updateOne.update.$set._monlite_v).toBe("v2");
  });

  it("pull: maps docs to changes, surfaces deletes, advances cursor", async () => {
    const users = new FakeCollection([
      {
        _id: new ObjectId(HEX1),
        name: "Ali",
        _monlite_v: "v5",
        _monlite_deleted: false,
      },
      { _id: new ObjectId(HEX2), _monlite_v: "v6", _monlite_deleted: true },
    ]);
    const adapter = new MongoAdapter({
      client: new FakeClient({ users }) as any,
      db: "app",
    });

    const res = await adapter.pull(null, { collections: ["users"] });

    expect(res.changes).toHaveLength(2);
    expect(res.changes[0]).toMatchObject({ op: "upsert", _id: HEX1 });
    expect(res.changes[0].doc).toMatchObject({ name: "Ali", _id: HEX1 });
    expect(res.changes[0].doc).not.toHaveProperty("_monlite_v");
    expect(res.changes[1]).toMatchObject({ op: "delete", _id: HEX2 });
    // Cursor is now a per-collection map (was a global scalar).
    expect(JSON.parse(res.cursor!).users).toBe("v6");
  });

  it("pull: cursor filters already-seen versions", async () => {
    const users = new FakeCollection([
      {
        _id: new ObjectId(HEX1),
        name: "old",
        _monlite_v: "v1",
        _monlite_deleted: false,
      },
      {
        _id: new ObjectId(HEX2),
        name: "new",
        _monlite_v: "v9",
        _monlite_deleted: false,
      },
    ]);
    const adapter = new MongoAdapter({
      client: new FakeClient({ users }) as any,
      db: "app",
    });

    // Legacy scalar cursor "v5" is honoured as the per-collection floor.
    const res = await adapter.pull("v5", { collections: ["users"] });
    expect(res.changes).toHaveLength(1);
    expect(res.changes[0]._id).toBe(HEX2);
    expect(JSON.parse(res.cursor!).users).toBe("v9");
  });
});
