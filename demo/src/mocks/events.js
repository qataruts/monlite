// Minimal browser EventEmitter shim for @monlite/queue & @monlite/cron, which
// extend Node's `events`. Covers the subset they use (on/once/off/emit).
export class EventEmitter {
  constructor() {
    this._l = new Map();
  }
  on(e, fn) {
    if (!this._l.has(e)) this._l.set(e, []);
    this._l.get(e).push(fn);
    return this;
  }
  once(e, fn) {
    const w = (...a) => {
      this.off(e, w);
      fn(...a);
    };
    return this.on(e, w);
  }
  off(e, fn) {
    const a = this._l.get(e);
    if (a) this._l.set(e, a.filter((f) => f !== fn));
    return this;
  }
  removeListener(e, fn) {
    return this.off(e, fn);
  }
  removeAllListeners(e) {
    if (e) this._l.delete(e);
    else this._l.clear();
    return this;
  }
  emit(e, ...a) {
    const l = this._l.get(e);
    if (l) for (const fn of [...l]) fn(...a);
    return !!(l && l.length);
  }
  listenerCount(e) {
    return this._l.get(e)?.length ?? 0;
  }
}
export default EventEmitter;
