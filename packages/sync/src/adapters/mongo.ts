import { makeVersion } from "@monlite/core";
import type { RemoteChange, LocalChange } from "@monlite/core";
import type {
  SyncAdapter,
  Cursor,
  PullOptions,
  PullResult,
  PushResult,
  Unsubscribe,
} from "../types.js";

const VERSION_FIELD = "_monlite_v";
const DELETED_FIELD = "_monlite_deleted";

export interface MongoAdapterOptions {
  /** A connected `MongoClient` (from the `mongodb` peer dependency). */
  client: any;
  /** Target Mongo database name. */
  db: string;
  /** State/cursor key. Defaults to `mongo:<db>`. */
  name?: string;
  /** Map a local collection name to a Mongo collection name. */
  collectionMap?: (name: string) => string;
}

function stripId(doc: Record<string, any>): Record<string, any> {
  const { _id, ...rest } = doc;
  return rest;
}

/**
 * Replicates against MongoDB.
 *
 * - Push uses `bulkWrite` (`replaceOne` upsert + soft-delete via `_monlite_deleted`).
 * - Pull (polling) reads documents whose `_monlite_v` is greater than the cursor.
 * - Live `watch()` uses change streams (requires a replica set).
 *
 * monlite `_id`s are ObjectId-compatible, so they map 1:1 to Mongo `_id`s.
 * The version travels in `_monlite_v` so changes round-trip without echoing.
 */
export class MongoAdapter implements SyncAdapter {
  readonly name: string;
  private readonly client: any;
  private readonly dbName: string;
  private readonly map: (n: string) => string;
  private ObjectId: any;

  constructor(opts: MongoAdapterOptions) {
    this.client = opts.client;
    this.dbName = opts.db;
    this.name = opts.name ?? `mongo:${opts.db}`;
    this.map = opts.collectionMap ?? ((n) => n);
  }

  private async oid(): Promise<any> {
    if (!this.ObjectId) {
      const mod: any = await import("mongodb");
      this.ObjectId = mod.ObjectId;
    }
    return this.ObjectId;
  }

  private coll(name: string) {
    return this.client.db(this.dbName).collection(this.map(name));
  }

  private toId(id: string, ObjectId: any): any {
    return /^[0-9a-fA-F]{24}$/.test(id) ? new ObjectId(id) : id;
  }

  async push(changes: LocalChange[]): Promise<PushResult> {
    const ObjectId = await this.oid();
    const byColl = new Map<string, LocalChange[]>();
    for (const c of changes) {
      let list = byColl.get(c.collection);
      if (!list) byColl.set(c.collection, (list = []));
      list.push(c);
    }

    const acked: LocalChange[] = [];
    const rejected: Array<{ change: LocalChange; reason: string }> = [];
    for (const [collName, list] of byColl) {
      const ops = list.map((c) => {
        const _id = this.toId(c._id, ObjectId);
        if (c.op === "delete") {
          return {
            updateOne: {
              filter: { _id },
              update: {
                $set: { [DELETED_FIELD]: true, [VERSION_FIELD]: c.version },
              },
              upsert: true,
            },
          };
        }
        return {
          replaceOne: {
            filter: { _id },
            replacement: {
              ...stripId(c.doc ?? {}),
              _id,
              [VERSION_FIELD]: c.version,
              [DELETED_FIELD]: false,
            },
            upsert: true,
          },
        };
      });
      if (!ops.length) continue;
      try {
        await this.coll(collName).bulkWrite(ops, { ordered: false });
        acked.push(...list);
      } catch (err: any) {
        // Partial failure: with { ordered: false } all non-failed ops applied.
        // Ack the survivors; route only the failed indices to `rejected`.
        const failed = new Set<number>(
          (err?.writeErrors ?? []).map((w: any) => w?.index ?? w?.err?.index),
        );
        if (failed.size === 0) {
          // Unknown failure shape — reject the whole batch to be safe.
          for (const c of list) rejected.push({ change: c, reason: String(err?.message ?? err) });
        } else {
          list.forEach((c, idx) => {
            if (failed.has(idx)) rejected.push({ change: c, reason: String(err?.message ?? err) });
            else acked.push(c);
          });
        }
      }
    }
    return rejected.length ? { acked, rejected } : { acked };
  }

  async pull(cursor: Cursor, opts: PullOptions): Promise<PullResult> {
    const collections = opts.collections ?? [];
    const filter = cursor ? { [VERSION_FIELD]: { $gt: cursor } } : {};
    const changes: RemoteChange[] = [];
    let maxVersion = cursor ?? "";

    for (const collName of collections) {
      let query = this.coll(collName).find(filter).sort({ [VERSION_FIELD]: 1 });
      if (opts.limit != null && opts.limit > 0) query = query.limit(opts.limit);
      const docs: any[] = await query.toArray();
      for (const d of docs) {
        const version: string = d[VERSION_FIELD] ?? "";
        const idHex = d._id?.toString?.() ?? String(d._id);
        if (d[DELETED_FIELD]) {
          changes.push({ collection: collName, _id: idHex, op: "delete", version });
        } else {
          const { [VERSION_FIELD]: _v, [DELETED_FIELD]: _d, ...rest } = d;
          changes.push({
            collection: collName,
            _id: idHex,
            op: "upsert",
            version,
            doc: { ...stripId(rest), _id: idHex },
          });
        }
        if (version > maxVersion) maxVersion = version;
      }
    }
    return { changes, cursor: maxVersion || null };
  }

  watch(
    _cursor: Cursor,
    onChange: (change: RemoteChange) => void,
    opts: PullOptions,
  ): Unsubscribe {
    const streams: any[] = [];
    const collections = opts.collections ?? [];
    void (async () => {
      for (const collName of collections) {
        const stream = this.coll(collName).watch([], {
          fullDocument: "updateLookup",
        });
        stream.on("change", (evt: any) => {
          const idHex =
            evt.documentKey?._id?.toString?.() ?? String(evt.documentKey?._id);
          if (evt.operationType === "delete") {
            onChange({
              collection: collName,
              _id: idHex,
              op: "delete",
              version: makeVersion(Date.now(), "mongo"),
            });
            return;
          }
          const d = evt.fullDocument;
          if (!d) return;
          const version: string = d[VERSION_FIELD] ?? makeVersion(Date.now(), "mongo");
          if (d[DELETED_FIELD]) {
            onChange({ collection: collName, _id: idHex, op: "delete", version });
          } else {
            const { [VERSION_FIELD]: _v, [DELETED_FIELD]: _dd, ...rest } = d;
            onChange({
              collection: collName,
              _id: idHex,
              op: "upsert",
              version,
              doc: { ...stripId(rest), _id: idHex },
            });
          }
        });
        streams.push(stream);
      }
    })();
    return () => {
      for (const s of streams) s.close?.();
    };
  }
}
