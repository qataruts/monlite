/**
 * A single coalescing scheduler shared by every subsystem that needs a periodic
 * cross-process / time-based poll (the reactor, `@monlite/kv` pub/sub, the queue's
 * idle poll, `@monlite/cron`). Instead of each running its own `setInterval`, they
 * register a recurring task here and ONE timer is armed for the soonest-due task.
 *
 * - **One event-loop wakeup**, not N — the timer fires, runs whatever is actually
 *   due, then re-arms for the next soonest task.
 * - **Each task keeps its own cadence** (cron at 1s, realtime at 200ms) — no task
 *   is forced to the fastest rate.
 * - **Zero timers when nothing is registered** (true zero idle cost), and the timer
 *   is `unref()`'d so it never keeps the process alive.
 * - **Adaptive**: a task can change its interval (the queue's backoff just slows
 *   its own task; the hub re-coalesces).
 *
 * Same-process instant paths (queue `kick`, pub/sub immediate delivery, in-process
 * watch emits) stay OUTSIDE the heartbeat — they're synchronous, not polled.
 */
export interface HeartbeatTask {
  /** Change this task's interval; the shared timer re-coalesces. */
  setInterval(ms: number): void;
  /** Stop this task. */
  cancel(): void;
}

interface Task {
  interval: number;
  fn: () => void;
  nextAt: number;
}

export class Heartbeat {
  private readonly tasks = new Set<Task>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** Run `fn` roughly every `intervalMs`. Returns a handle to retune or cancel it. */
  every(intervalMs: number, fn: () => void): HeartbeatTask {
    const interval = Math.max(1, Math.floor(intervalMs));
    const task: Task = { interval, fn, nextAt: Date.now() + interval };
    this.tasks.add(task);
    this.reschedule();
    return {
      setInterval: (ms: number) => {
        task.interval = Math.max(1, Math.floor(ms));
        task.nextAt = Date.now() + task.interval;
        this.reschedule();
      },
      cancel: () => {
        if (this.tasks.delete(task)) this.reschedule();
      },
    };
  }

  /** Arm the single timer for the soonest-due task (or none if empty). */
  private reschedule(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    let soonest = Infinity;
    for (const t of this.tasks) if (t.nextAt < soonest) soonest = t.nextAt;
    if (soonest === Infinity) return; // no tasks → no timer
    const delay = Math.max(0, soonest - Date.now());
    this.timer = setTimeout(() => this.fire(), delay);
    this.timer.unref?.();
  }

  /** Run every task that is due, then re-arm. */
  private fire(): void {
    this.timer = undefined;
    const now = Date.now();
    // Snapshot — a task's fn may register/cancel tasks during the tick.
    for (const task of [...this.tasks]) {
      if (!this.tasks.has(task) || task.nextAt > now) continue;
      task.nextAt = now + task.interval; // reset from now (no catch-up bursts)
      try {
        task.fn();
      } catch (err) {
        // A subsystem's poll must not break sibling tasks or wedge the heartbeat.
        console.error("monlite: a heartbeat task threw —", err);
      }
    }
    this.reschedule();
  }

  /** Stop the timer and drop all tasks (called on `$disconnect`). */
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.tasks.clear();
  }

  /** @internal Number of registered tasks (for tests/diagnostics). */
  get size(): number {
    return this.tasks.size;
  }
}
