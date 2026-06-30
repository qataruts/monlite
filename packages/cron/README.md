# @monlite/cron

Cron-style scheduling for monlite. Persisted schedules survive restarts, a zero-dependency 5-field
cron parser, and atomic firing so multiple processes won't double-run the same occurrence.

- **SQLite** ([`@monlite/core`](https://www.npmjs.com/package/@monlite/core)) — `createCron(db)`, a
  synchronous API.
- **Postgres** ([`@monlite/postgres`](https://www.npmjs.com/package/@monlite/postgres)) —
  `createPgCron(db)`, same model with an **async** API (`await cron.schedule(...)`).

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
  await purgeOldRows(); // runs every day at 03:00 local time
});

cron.on("error", (err, name) => console.warn(name, err));
```

## Cron syntax

Standard 5-field format: `minute hour day-of-month month day-of-week`

| Pattern | Meaning |
|---|---|
| `* * * * *` | Every minute |
| `*/15 * * * *` | Every 15 minutes |
| `0 9 * * 1` | Monday 09:00 |
| `0 9-17 * * *` | Hourly, 9am–5pm |
| `0 0 1,15 * *` | 1st and 15th at midnight |

Day-of-week is `0–6` (0 = Sunday). Times are **local**. When both day-of-month and day-of-week
are restricted, either match fires (POSIX behavior).

## API

```ts
const cron = createCron(db, {
  checkInterval: 1000, // poll cadence in ms (default: 1000)
});

cron.schedule(name, cronExpr, handler); // register or update a schedule, start firing
cron.unschedule(name);                  // remove a schedule
cron.next(name);                        // next run as epoch ms, or undefined
cron.on("error", (err, name) => {});
cron.stop();                            // stop firing (schedules remain in the db)

// Utility
import { nextCronRun } from "@monlite/cron";
nextCronRun("0 9 * * 1"); // → Date of the next Monday 09:00
```

Firing is **atomic** — each occurrence is claimed from the schedule row, so running the same
schedule in multiple processes fires each occurrence exactly once.

## Composing with `@monlite/queue`

A cron handler runs in-process. For durable work that survives crashes and gets retried, have the
handler enqueue a job into [`@monlite/queue`](https://www.npmjs.com/package/@monlite/queue)
instead of doing the work directly:

```ts
import { createQueue } from "@monlite/queue";

const queue = createQueue(db);
queue.process("report", async (job) => generateReport(job.payload));

cron.schedule("nightly-report", "0 0 * * *", () => {
  queue.add("report", { day: new Date().toISOString() });
});
```

The schedule is persisted; the work is durable and retried.

## License

MIT
