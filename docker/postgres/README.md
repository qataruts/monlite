# monlite/postgres (Docker image)

A **ready-to-use PostgreSQL** for the [monlite](https://qataruts.github.io/monlite) harness —
Postgres 16 + **pgvector**, with the extension enabled on first boot and `LISTEN/NOTIFY` available
out of the box. Plug it in and `@monlite/postgres` just works, no version/extension roulette.

```bash
# build
docker build -t monlite/postgres:16 docker/postgres

# run
docker run -d --name monlite-pg -e POSTGRES_PASSWORD=monlite -p 5432:5432 monlite/postgres:16
```

```ts
import { createDb } from "@monlite/postgres";
const db = createDb("postgres://postgres:monlite@localhost:5432/postgres");
await db.collection("users").create({ data: { name: "Ada", embedding: [/* … */] } });
```

## docker-compose

```yaml
services:
  db:
    image: monlite/postgres:16
    environment:
      POSTGRES_PASSWORD: monlite
      POSTGRES_DB: app
    ports: ["5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]
volumes:
  pgdata:
```

## Publish (maintainers)

```bash
docker build -t monlite/postgres:16 -t monlite/postgres:latest docker/postgres
docker push monlite/postgres:16
docker push monlite/postgres:latest
```

## What's inside

- **pgvector** — installed (base image) and `CREATE EXTENSION vector` run on first init.
- **`LISTEN/NOTIFY`** — the changefeed / `watch()` transport (avoid transaction-pooling proxies,
  which break it; the harness falls back to polling there).
- Standard PostgreSQL 16 otherwise — JSONB, `SKIP LOCKED`, `tsvector`, all native.
