// Browser stub for the native `sqlite-vec` module. getLoadablePath throws, so
// @monlite/vector catches it during init and uses its brute-force JS fallback
// (cosine/L2 in JS over a plain table) — real vector search, no native vec0.
export function getLoadablePath() {
  throw new Error("sqlite-vec native extension is unavailable in the browser");
}
export default { getLoadablePath };
