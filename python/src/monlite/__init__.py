"""monlite — the local-first database for Python (the Python port of monlite).

Documents + cache + queue + cron + full-text search over **one SQLite file**, byte-compatible
with the TypeScript ``@monlite/*`` packages: a ``.db`` written by Node round-trips here and back,
including the change feed, the ``_kv``/sorted-set/pub-sub tables, the durable ``_jobs`` queue, the
``_schedules`` cron table, and the FTS5 index. Pure standard library — no dependencies required.

    from monlite import create_db, kv, create_queue, create_cron, fts

    db = create_db("app.db", changefeed=True)
    db.collection("users").create({"name": "Ada", "age": 30})
    for change in db.changes():        # sees Node's writes too
        ...
"""
from .core import Collection, Database, create_db, make_version
from .kv import KV, kv
from .queue import Handler, Job, Queue, create_queue
from .cron import Cron, ParsedCron, create_cron, next_cron_run, parse_cron
from .fts import (
    DynamicSearchIndex,
    SearchIndex,
    create_dynamic_search_index,
    create_search_index,
    fts,
)
from .vector import VectorStore, hybrid_search, vector

__all__ = [
    # core (documents, transactions, change feed)
    "create_db",
    "Database",
    "Collection",
    "make_version",
    # kv — cache, locks, pub/sub, sorted sets
    "kv",
    "KV",
    # queue — durable jobs
    "create_queue",
    "Queue",
    "Job",
    "Handler",
    # cron — persisted schedules
    "create_cron",
    "Cron",
    "ParsedCron",
    "parse_cron",
    "next_cron_run",
    # full-text search (FTS5)
    "fts",
    "create_search_index",
    "SearchIndex",
    "create_dynamic_search_index",
    "DynamicSearchIndex",
    # vector / semantic search ([vector] extra for native sqlite-vec; JS-style fallback otherwise)
    "vector",
    "VectorStore",
    "hybrid_search",
]

__version__ = "0.2.0"
