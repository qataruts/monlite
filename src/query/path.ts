/** Deep get/set/unset on plain objects using dot-notation paths. */

export function getPath(obj: any, path: string): any {
  let cur = obj;
  for (const seg of path.split(".")) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

export function setPath(obj: any, path: string, value: any): void {
  const segs = path.split(".");
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!;
    if (cur[seg] == null || typeof cur[seg] !== "object") cur[seg] = {};
    cur = cur[seg];
  }
  cur[segs[segs.length - 1]!] = value;
}

export function unsetPath(obj: any, path: string): void {
  const segs = path.split(".");
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!;
    if (cur[seg] == null || typeof cur[seg] !== "object") return;
    cur = cur[seg];
  }
  delete cur[segs[segs.length - 1]!];
}
