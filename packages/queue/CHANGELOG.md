# @monlite/queue

## 0.1.0

- Initial release.

- Durable SQLite job queue: `add`/`process` with atomic claim (`UPDATE … RETURNING`), retries + exponential backoff, delayed/`runAt` jobs, priorities, concurrency, dead-letter, `completed`/`failed` events, `counts`, and `recover` for crashed workers. Multi-process safe; works on both drivers.
