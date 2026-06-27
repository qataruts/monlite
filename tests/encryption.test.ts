import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, MonliteEncryptionError, MonliteError } from "../src/index";

// Encryption always uses the better-sqlite3 (multiple-ciphers) backend, so these
// tests don't go through the MONLITE_DRIVER helper.
const dir = mkdtempSync(join(tmpdir(), "monlite-enc-"));
let counter = 0;
const tmpFile = () => join(dir, `db${counter++}.db`);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("encryption at rest", () => {
  it("round-trips encrypted data across reopen with the right key", async () => {
    const f = tmpFile();
    const key = "correct horse battery staple";
    const db = createDb(f, { encryption: { key } });
    await db.collection("secrets").create({ data: { _id: "s1", pin: 1234 } });
    await db.$disconnect();

    const reopened = createDb(f, { encryption: { key } });
    expect((await reopened.collection("secrets").findById("s1"))?.pin).toBe(
      1234,
    );
    await reopened.$disconnect();
  });

  it("writes a non-plaintext file to disk", async () => {
    const f = tmpFile();
    const db = createDb(f, { encryption: { key: "k" }, wal: false });
    await db.collection("c").create({ data: { secretWord: "hunter2" } });
    await db.$disconnect();

    const bytes = readFileSync(f);
    // Plain SQLite files begin with "SQLite format 3\0"; encrypted ones don't.
    expect(bytes.subarray(0, 15).toString("utf8")).not.toBe("SQLite format 3");
    expect(bytes.includes(Buffer.from("hunter2"))).toBe(false);
  });

  it("rejects a wrong key with MonliteEncryptionError", async () => {
    const f = tmpFile();
    const db = createDb(f, { encryption: { key: "right" } });
    await db.collection("c").create({ data: { x: 1 } });
    await db.$disconnect();

    expect(() => createDb(f, { encryption: { key: "wrong" } })).toThrow(
      MonliteEncryptionError,
    );
  });

  it("rotates the key with rekey()", async () => {
    const f = tmpFile();
    const db = createDb(f, { encryption: { key: "old" } });
    await db.collection("c").create({ data: { _id: "x", v: 9 } });
    db.rekey("new");
    await db.$disconnect();

    expect(() => createDb(f, { encryption: { key: "old" } })).toThrow(
      MonliteEncryptionError,
    );
    const db2 = createDb(f, { encryption: { key: "new" } });
    expect((await db2.collection("c").findById("x"))?.v).toBe(9);
    await db2.$disconnect();
  });

  it("rekey() throws on a database opened without encryption", () => {
    const db = createDb(":memory:");
    expect(() => db.rekey("x")).toThrow(MonliteError);
  });

  it("refuses encryption on the node:sqlite backend", () => {
    expect(() =>
      createDb(tmpFile(), { driver: "node:sqlite", encryption: { key: "k" } }),
    ).toThrow(/node:sqlite/);
  });
});
