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

export function makeVersion(ts: number, nodeId: string): Version {
  return String(ts).padStart(TS_WIDTH, "0") + ":" + nodeId;
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
