// Browser stub — createRequire is Node-only.
// monlite's driver factory wraps every require() in try/catch and returns null on failure,
// so stubbing it here lets the bundle succeed. The WASM driver is passed directly so
// no native driver is ever instantiated.
export function createRequire() {
  return () => null;
}
