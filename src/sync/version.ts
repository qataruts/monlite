/**
 * Versions are LWW (last-write-wins) tokens of the form
 * `<zero-padded-ms>:<nodeId>` so that plain string comparison yields the
 * correct ordering: newer wall-clock time wins, ties broken by node id.
 *
 * (The design reserves room to swap this for a hybrid logical clock later;
 * the on-disk column is a plain string, so the format can evolve.)
 */

export type Version = string;

const TS_WIDTH = 15; // fits ms timestamps well past the year 5000
const SEQ_WIDTH = 12; // per-node monotonic tiebreaker

/**
 * Build a version token. The optional `seq` is a per-node monotonic counter
 * that makes versions unique even within the same millisecond — important so
 * that cursor-based pulls (`> version`) never skip a same-timestamp change.
 */
export function makeVersion(ts: number, nodeId: string, seq?: number): Version {
  const base = String(ts).padStart(TS_WIDTH, "0") + ":" + nodeId;
  return seq === undefined
    ? base
    : base + ":" + String(seq).padStart(SEQ_WIDTH, "0");
}

export function compareVersions(a: Version, b: Version): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function versionTs(v: Version): number {
  const i = v.indexOf(":");
  return Number(i === -1 ? v : v.slice(0, i));
}

export function versionNode(v: Version): string {
  const i = v.indexOf(":");
  return i === -1 ? "" : v.slice(i + 1);
}
