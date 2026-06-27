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

cron.schedule("nightly-report", "0 2 * * *", async () => {
  await buildReport();
});

cron.start(); // begin ticking
// cron.list(); cron.remove("nightly-report"); cron.stop();
```

Schedules are stored in the database, so a restart resumes them. The `parseCron`
and `nextCronRun` helpers are exported for computing run times yourself.

Single-instance safety: pair the tick with [`@monlite/kv`](/packages/kv)'s `setNX`
lock when running multiple processes, so only one fires each schedule.
