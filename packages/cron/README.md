# @monlite/cron

**Cron-style scheduling** for [`@monlite/core`](https://www.npmjs.com/package/@monlite/core), backed by SQLite. Persisted schedules (survive restarts), a zero-dependency 5-field cron parser, and atomic firing so multiple processes won't double-run. Part of the [local AI-agent harness](https://github.com/qataruts/monlite#readme).

```bash
npm install @monlite/core @monlite/cron
```

## Quick start

```ts
import { createDb } from "@monlite/core";
import { createCron } from "@monlite/cron";

const db = createDb("app.db");
const cron = createCron(db);

cron.schedule("cleanup", "0 3 * * *", async () => {
  await purgeOldRows(); // runs every day at 03:00 (local time)
});

cron.on("error", (err, name) => console.warn(name, err));
```

## Durable scheduled work (compose with the queue)

A cron handler runs in-process, so for durable work, have it **enqueue** a job
into [`@monlite/queue`](https://www.npmjs.com/package/@monlite/queue) — the
schedule is persisted and the work is durable & retried:

```ts
import { createQueue } from "@monlite/queue";
const queue = createQueue(db);
queue.process("report", async (job) => generateReport(job.payload));

cron.schedule("nightly-report", "0 0 * * *", () => {
  queue.add("report", { day: new Date().toISOString() });
});
```

## Cron syntax

Standard 5 fields — `minute hour day-of-month month day-of-week`:

```
*     every value          0 9 * * 1     09:00 every Monday
*/15  every 15             */15 * * * *  every 15 minutes
1-5   range                0 9-17 * * *  hourly, 9am–5pm
1,15  list                 0 0 1,15 * *  1st and 15th at midnight
```

Day-of-week is `0–6` (0 = Sunday). Times are **local**. When both day-of-month
and day-of-week are restricted, either match fires (POSIX behavior).

## API

```ts
const cron = createCron(db, { checkInterval: 1000 }); // poll cadence (ms)
cron.schedule(name, cronExpr, handler); // register/update + start
cron.unschedule(name);                  // remove
cron.next(name);                        // next run (epoch ms) | undefined
cron.on("error", (err, name) => {});
cron.stop();                            // stop scheduling (schedules persist)

// utility:
import { nextCronRun } from "@monlite/cron";
nextCronRun("0 9 * * 1"); // → Date of the next Monday 09:00
```

Firing is **atomic** (a claim on the schedule row), so running the same schedule
in multiple processes fires each occurrence exactly once.

MIT
