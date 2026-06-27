# @monlite/cron

## 0.1.1

- Allow `@monlite/core` 2.0 (dependency range `^2.0.0`). No API changes.

## 0.1.0

- Initial release.

- Persisted cron scheduler over SQLite: zero-dependency 5-field parser (`*`, `*/n`, ranges, lists), `schedule`/`unschedule`/`next`, `nextCronRun` utility, atomic firing (exactly-once across processes), survives restarts. Works on both drivers.
