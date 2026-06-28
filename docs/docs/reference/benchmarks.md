---
id: benchmarks
title: Benchmarks
---

# Benchmarks

Indicative numbers comparing `@monlite/core` to the raw SQLite driver and to the
closest embedded JS document stores. **Run them yourself** — results vary by
machine and Node version:

```bash
pnpm build && node bench/bench.mjs
```

All engines run **in-memory** to isolate engine overhead (no disk-I/O variance).
Workload: insert 10,000 documents, 5,000 random point lookups by id, and a
filter query (`age >= 40`, ~6,300 of 10,000 rows). Median of multiple runs.

## Results (Apple Intel, Node 22)

| Engine | Insert 10k | 5k point reads | Filter query |
| --- | --- | --- | --- |
| **monlite** (document) | 47 ms · ~214k/s | 32 ms · ~157k/s | 21 ms |
| **monlite** (structured) | 74 ms · ~135k/s | 31 ms · ~163k/s | 20 ms |
| **monlite** (node:sqlite, zero-dep) | 40 ms · ~252k/s | 36 ms · ~138k/s | 21 ms |
| raw better-sqlite3 (floor) | 23 ms · ~432k/s | 12 ms · ~426k/s | 12 ms |
| @seald-io/nedb | 97 ms · ~103k/s | 36 ms · ~138k/s | 5 ms |
| lowdb | n/a¹ | 461 ms · ~11k/s | 0.4 ms² |

¹ lowdb "insert" is a plain in-memory array assignment with no indexing, so it
isn't a comparable measurement.
² lowdb/NeDB queries return references to the in-memory objects with no
materialization, which is why broad scans look fast (see below).

## Scale (RAG-sized corpora)

Verified on a file database (run the suite with `MONLITE_SCALE=1`):

| Workload | Result |
|---|---|
| Ingest 100K documents | ~0.8s (~0.008 ms/doc), indexed query ~9ms |
| Index 50K vectors (`@monlite/vector`, vec0) | ~8s (~0.16 ms/doc), `findSimilar` ~14ms |
| Index FTS5 documents (`@monlite/fts`) | linear — flat ~0.12 ms/doc to 30K+ |

FTS5 and vector indexing are **linear** at scale (keyed `doc_id`, no O(n²) re-index),
and plugin indexing batches into one transaction — so bulk RAG ingestion of 10K–100K
documents stays fast.

## Takeaways

- **Low overhead for the ergonomics.** monlite is roughly **2× the raw driver**
  for inserts and point reads while giving you the document API, validation,
  reactivity hooks, and (optionally) sync — still **150k–250k ops/sec**.
- **It scales where JSON-file stores don't.** Point lookups use SQLite's indexed
  primary key and stay flat; **lowdb does a linear array scan — ~15× slower at
  10k docs and degrading** as data grows. monlite reads don't.
- **Faster inserts than NeDB** (~2×), the closest document-store competitor;
  read performance is comparable.
- **`node:sqlite` (zero-dependency) is competitive** with `better-sqlite3` for
  this workload — you don't pay much for dropping the native dependency.
- **Honest caveat — broad result sets.** Queries that *return many rows* pay a
  materialization cost in monlite/SQLite (parse + rebuild each document), so
  NeDB/lowdb can look faster when returning thousands of objects. If you select
  a wide set, use `select` to project fewer fields, `take`/`skip` to paginate,
  or structured columns. For selective queries and point lookups (the common
  case), monlite's indexes win decisively.

The bottom line: monlite gives you a real, indexed, ACID database with a document
API at a small, predictable overhead over raw SQLite — and pulls away from
JSON-file stores as soon as your data set is non-trivial.
