import { createDb, type Monlite } from "@monlite/core";

/** Open an in-memory, sync-enabled database with a fixed node id. */
export function openSyncDb(nodeId: string): Monlite {
  const driver = (process.env.MONLITE_DRIVER as any) || undefined;
  return createDb(":memory:", {
    sync: true,
    nodeId,
    ...(driver ? { driver } : {}),
  });
}
