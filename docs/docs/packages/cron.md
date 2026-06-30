---
id: cron
title: "@monlite/cron"
---

# @monlite/cron — persisted scheduled jobs

A cron server in a file: persisted schedules over SQLite that **survive restarts**
(the next run is stored), with **atomic firing** so multiple processes sharing one
`.db` never double-run an occurrence. On the SQLite engine it's `createCron(db)`
(synchronous); on the [Postgres engine](/packages/postgres) it's
[`createPgCron(db)`](#postgres-engine-createpgcron) (async, same model).

```bash
npm install @monlite/cron
```

```ts
import { createDb } from "@monlite/core";
import { createCron } from "@monlite/cron";

const db = createDb("app.db");
const cron = createCron(db);

// Runs at 02:00 every day, server local time. The scheduler starts on the first schedule().
cron.schedule("nightly-report", "0 2 * * *", async () => {
  await buildReport();
});

cron.next("nightly-report"); // next run (epoch ms)
cron.unschedule("nightly-report"); // remove a schedule
cron.stop(); // stop the scheduler (schedules stay persisted)
```

Schedules are stored in the database, so a restart resumes them with their timing
intact. If you re-`schedule()` a name with the **same** expression the stored next
run is kept; change the expression and it's recomputed so the new schedule takes
effect immediately.

| Method | Description |
|---|---|
| `schedule(name, expr, handler, opts?)` | register (or update) a named schedule and start the scheduler |
| `unschedule(name)` | remove a schedule (from memory and the `_schedules` table) |
| `next(name)` | the next scheduled run for a registered schedule (epoch ms), or `undefined` |
| `stop()` | stop the scheduler; persisted schedules remain and resume when scheduling restarts |

The scheduler is an `EventEmitter`: it emits `"error"` `(err, name)` if a handler
throws, so a failing job never crashes the process.

```ts
cron.on("error", (err, name) => console.warn("cron job failed", name, err));
```

## Cron expression syntax

A standard 5-field expression: `minute hour day-of-month month day-of-week`.

```
┌───────────── minute        (0-59)
│ ┌─────────── hour          (0-23)
│ │ ┌───────── day of month  (1-31)
│ │ │ ┌─────── month         (1-12)
│ │ │ │ ┌───── day of week   (0-6, Sunday = 0)
│ │ │ │ │
* * * * *
```

Each field supports `*` (all), lists (`1,15,30`), ranges (`9-17`), and steps
(`*/15`, or `5/15` meaning "from 5 to the max, every 15" → `5,20,35,50`). Examples:

```ts
cron.schedule("every-minute", "* * * * *", fn);
cron.schedule("hourly", "0 * * * *", fn); // top of every hour
cron.schedule("nightly", "0 2 * * *", fn); // 02:00 daily
cron.schedule("weekdays-9am", "0 9 * * 1-5", fn); // 09:00 Mon–Fri
cron.schedule("every-15-min", "*/15 * * * *", fn); // :00, :15, :30, :45
cron.schedule("monday-billing", "0 9 * * 1", fn); // 09:00 every Monday
```

Day-of-month and day-of-week follow POSIX: when **both** are restricted (neither is
`*`), a match on *either* fires. An invalid field (out of range, bad step, wrong
field count) throws from `schedule()`/`parseCron()` with a clear message.

## Time zones & jitter

```ts
// Evaluate the expression in a specific IANA zone (DST-aware), with a random spread
cron.schedule("billing", "0 9 * * 1", runBilling, {
  tz: "Europe/Istanbul",
  jitter: 30_000, // up to 30s of random delay per firing — spreads a thundering herd
});
```

| `ScheduleOptions` | Description |
|---|---|
| `tz` | an IANA zone (e.g. `"America/New_York"`); the expression is evaluated in that zone, DST included, instead of the server's local time. Built on `Intl` — zero new dependencies |
| `jitter` | add up to this many ms of random delay to each firing. Default `0` |

`jitter` matters when many schedules would otherwise fire at the same instant (e.g.
`0 * * * *` across hundreds of tenants) — it spreads the load.

## Multi-process firing & composing with a queue

**Multi-process safe out of the box:** firing is an atomic claim — only the process
that flips a schedule's `next_run` runs that occurrence, even with many workers
sharing the same `.db`. No external lock needed.

A cron handler should be **short**. For real work, fire-and-enqueue onto
[`@monlite/queue`](/packages/queue) so the job gets durability, retries, and
concurrency — and the cron tick stays instant:

```ts
import { createQueue } from "@monlite/queue";

const queue = createQueue(db, { maxAttempts: 3 });
queue.process("send-report", async (job) => buildAndEmail(job.payload));

// Exactly one process claims the tick; it just enqueues durable work.
cron.schedule("nightly-report", "0 2 * * *", () => {
  queue.add("send-report", { day: new Date().toISOString() });
});
```

The scheduler's poll shares the database's **single coalesced heartbeat** with the
reactor, kv pub/sub, and queue workers — one event-loop wakeup, not one per
subsystem. Tune how often it checks for due jobs with `createCron(db, { checkInterval })`
(default `1000` ms).

## Helpers: `parseCron` / `nextCronRun`

Both are exported for computing run times yourself, independent of a scheduler:

```ts
import { parseCron, nextCronRun } from "@monlite/cron";

const parsed = parseCron("0 9 * * 1-5"); // → ParsedCron (throws on an invalid expr)

nextCronRun("0 9 * * 1-5"); // next 09:00 weekday, local time → Date
nextCronRun("0 9 * * 1-5", new Date("2026-06-30T00:00:00Z")); // strictly after `from`
nextCronRun(parsed, new Date(), { tz: "Asia/Tokyo" }); // evaluated in an IANA zone (DST-aware)
```

`nextCronRun(expr, from?, { tz? })` returns the next `Date` strictly after `from`
(default now), evaluated in local time or `opts.tz`. It accepts either an
expression string or a pre-parsed `ParsedCron`.

## Postgres engine: `createPgCron`

On the [Postgres engine](/packages/postgres), `createPgCron(db)` runs the identical
model — a persisted `_schedules` table, an atomic cross-process claim so exactly one
process fires each tick — with an **async** API. `await` the methods that touch the
database:

```ts
import { createDb } from "@monlite/postgres";
import { createPgCron } from "@monlite/cron";

const db = createDb("postgres://user@host/db");
const cron = createPgCron(db);

await cron.schedule("nightly-report", "0 2 * * *", async () => {
  await buildReport();
});

await cron.next("nightly-report"); // next run (epoch ms)
await cron.unschedule("nightly-report");
cron.stop(); // synchronous, like SQLite

cron.on("error", (err, name) => console.warn("cron job failed", name, err));
```

`schedule`, `unschedule`, and `next` return Promises; `stop` and the
`EventEmitter` API stay synchronous. The cron expression syntax, `ScheduleOptions`
(`tz`, `jitter`), the atomic single-fire guarantee, and the `parseCron` /
`nextCronRun` helpers are all the same. Calling `createCron()`/`new Cron()` on a
Postgres database (or `createPgCron()`/`new PgCron()` on SQLite) throws with a
pointer to the right factory.
