# @monlite/cron

## 0.3.0 — Postgres engine support (PgCron)

The scheduler now runs on the [`@monlite/postgres`](https://www.npmjs.com/package/@monlite/postgres)
engine via an async `PgCron` (`createPgCron(db)` / `new PgCron(db)`) — same model as the sync
`Cron`: a persisted `_schedules` table with an atomic cross-process claim, so exactly one process
fires each tick. Methods are async (`await cron.schedule(...)`). The sync SQLite `Cron` is
unchanged; `new Cron(pgDb)` throws a clear redirect. Requires `@monlite/core` ≥ 2.9.0 for the
Postgres path.

## 0.2.1 — fast `nextCronRun` (no event-loop freeze)

Bug fix from an internal audit. **No API or behavior change** — the computed next-run is identical;
it's just computed without scanning minute-by-minute.

- **`nextCronRun` no longer freezes the event loop on sparse or `tz` schedules.** It now skips whole
  non-matching days and hours instead of iterating every minute across the (up to 5-year) search
  window. A `tz` leap-day schedule (`0 0 29 2 *`) or an impossible date (`0 0 31 2 *`) previously
  did ~2.6M `Intl` calls (multi-second block); both now resolve (or throw) in a few hundred
  iterations. The local path uses DST-safe `Date` arithmetic; the `tz` path self-corrects coarse
  jumps by re-reading the zone's wall clock each step.

## 0.2.0 — time zones + jitter

- **Per-schedule time zones**: `schedule(name, expr, fn, { tz: "Europe/Istanbul" })` evaluates the
  cron expression in that IANA zone (DST included) instead of the server's local time.
  `nextCronRun(expr, from, { tz })` gains the same option. Built on `Intl` — zero new dependencies.
- **Jitter**: `{ jitter: ms }` adds a random delay of up to `ms` to each firing, to spread a
  thundering herd of schedules that would otherwise fire at the same instant.
- Both are additive — existing `schedule()` / `nextCronRun()` calls are unchanged.

## 0.1.3 — tick on the shared heartbeat

- The scheduler tick now registers on the database's shared `Heartbeat` (`@monlite/core` ≥ 2.8.0)
  instead of its own `setInterval`, coalescing with the reactor, kv pub/sub and queue into one
  timer. No behavior change.

## 0.1.2 — correctness fixes (bug hunt)

- **`N/step` expands correctly.** `5/15` now means "from 5 to max, every 15" (→ 5, 20, 35, 50)
  instead of just `{5}`. A bare `N` still means exactly `{N}`.
- **Leap-day-only schedules resolve.** `nextCronRun("0 0 29 2 *", …)` now searches up to ~5
  years, so a `Feb 29` schedule finds the next leap year instead of throwing "could not compute
  next run".
- **Changing a schedule's expression takes effect immediately.** `schedule(name, newExpr, …)`
  now recomputes `next_run` when the expression changes (it previously kept the stale time and
  fired on the old cadence until the old `next_run` elapsed). Re-registering the *same*
  expression still preserves timing across restarts.

## 0.1.1

- Allow `@monlite/core` 2.0 (dependency range `^2.0.0`). No API changes.

## 0.1.0

- Initial release.

- Persisted cron scheduler over SQLite: zero-dependency 5-field parser (`*`, `*/n`, ranges, lists), `schedule`/`unschedule`/`next`, `nextCronRun` utility, atomic firing (exactly-once across processes), survives restarts. Works on both drivers.
