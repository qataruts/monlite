import type { Monlite, LocalChange } from "@monlite/core";
import type {
  SyncAdapter,
  Cursor,
  PullOptions,
  PullResult,
  PushResult,
} from "../types.js";

/**
 * Uses another sync-enabled monlite database as the remote. This makes
 * monlite-to-monlite replication possible (e.g. multi-device via a shared
 * hub database) and — being fully in-process — proves the adapter abstraction
 * end-to-end without external infrastructure.
 */
export class MonliteAdapter implements SyncAdapter {
  readonly name: string;

  constructor(
    private readonly remote: Monlite,
    opts: { name?: string } = {},
  ) {
    if (!remote.$sync) {
      throw new Error(
        "MonliteAdapter requires the remote database opened with { sync: true }",
      );
    }
    this.name = opts.name ?? "monlite";
  }

  async pull(cursor: Cursor, opts: PullOptions): Promise<PullResult> {
    const from = cursor ? Number(cursor) : 0;
    const { changes, maxSeq } = this.remote.$sync!.changesSince(
      from,
      opts.collections,
      opts.limit,
    );
    return { changes, cursor: String(maxSeq) };
  }

  async push(changes: LocalChange[]): Promise<PushResult> {
    const store = this.remote.$sync!;
    for (const c of changes) {
      store.applyRemote({
        collection: c.collection,
        _id: c._id,
        op: c.op,
        version: c.version,
        doc: c.doc,
      });
    }
    return { acked: changes };
  }
}
