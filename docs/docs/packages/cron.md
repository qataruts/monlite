---
id: cron
title: "@monlite/cron"
---

# @monlite/cron — scheduled jobs

Persisted cron schedules over SQLite. Survives restarts; runs due jobs on a tick.

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

cron.unschedule("nightly-report"); // remove a schedule
cron.next("nightly-report"); // next run (epoch ms)
cron.stop(); // stop the scheduler (schedules stay persisted)
```

Schedules are stored in the database, so a restart resumes them. The `parseCron` and
`nextCronRun(expr, from, { tz })` helpers are exported for computing run times yourself.

## Time zones & jitter

```ts
// Evaluate the expression in a specific IANA zone (DST-aware), with a random spread
cron.schedule("billing", "0 9 * * 1", runBilling, {
  tz: "Europe/Istanbul",
  jitter: 30_000, // up to 30s of random delay per firing — spreads a thundering herd
});
```

- **`tz`** — an IANA zone (e.g. `"America/New_York"`); the cron expression is evaluated in that
  zone, DST included, instead of the server's local time. Built on `Intl` — zero new dependencies.
- **`jitter`** — adds up to `jitter` ms of random delay to each firing.

**Multi-process safe out of the box:** firing is atomic — only one process runs each occurrence,
even with many workers sharing the same `.db`. (No external lock needed.)
