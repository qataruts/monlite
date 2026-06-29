"""Cross-language interop for the newer features: the change feed and kv sorted sets.

A .db is shared between the Node (@monlite/*) packages and this Python port; each side
writes, the other reads, proving the on-disk format matches. Skipped when Node or the
built JS bundles aren't present.
"""
import json
import os
import subprocess
import tempfile
import unittest

from monlite import create_db, kv

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DIST = os.path.join(REPO, "dist", "index.js")
KV_DIST = os.path.join(REPO, "packages", "kv", "dist", "index.js")
QUEUE_DIST = os.path.join(REPO, "packages", "queue", "dist", "index.js")


def _have_node():
    if not (os.path.exists(DIST) and os.path.exists(KV_DIST)):
        return False
    try:
        subprocess.run(["node", "--version"], capture_output=True, check=True)
        return True
    except Exception:
        return False


def _node(script):
    return subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True)


@unittest.skipUnless(_have_node(), "node + built JS bundles required")
class TestChangeFeedInterop(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="monlite-feed-")
        self.dbpath = os.path.join(self.dir, "shared.db")

    def test_node_writes_feed_python_reads(self):
        # Node records a feed (changefeed on); Python reads it via db.changes().
        _node(
            f"(async()=>{{const{{createDb}}=require({json.dumps(DIST)});"
            f"const db=createDb({json.dumps(self.dbpath)},{{changefeed:true}});"
            "const c=db.collection('orders');"
            "await c.create({data:{_id:'a',status:'open'}});"
            "await c.update({where:{_id:'a'},data:{status:'closed'}});"
            "await c.delete({where:{_id:'a'}});"
            "await db.$disconnect();})()"
        )
        db = create_db(self.dbpath, changefeed=True)
        try:
            changes = db.changes(coll="orders")
            self.assertEqual([c["op"] for c in changes], ["upsert", "upsert", "delete"])
            # version is the TS layout <padded-ms>:<nodeId>:<padded-seq>
            v = changes[0]["version"]
            self.assertEqual(v.count(":"), 2)
            self.assertEqual(len(v.split(":")[0]), 15)
        finally:
            db.close()

    def test_python_writes_feed_node_reads(self):
        db = create_db(self.dbpath, changefeed=True)
        c = db.collection("tasks")
        c.create({"_id": "t1", "done": False})
        c.update({"_id": "t1"}, {"$set": {"done": True}})
        db.close()
        out = _node(
            f"(async()=>{{const{{createDb}}=require({json.dumps(DIST)});"
            f"const db=createDb({json.dumps(self.dbpath)},{{changefeed:true}});"
            "process.stdout.write(String(db.currentSeq()));"
            "await db.$disconnect();})()"
        )
        # Node sees both of Python's feed rows.
        self.assertEqual(out.stdout.strip(), "2")


@unittest.skipUnless(_have_node(), "node + built JS bundles required")
class TestZSetInterop(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="monlite-zset-")
        self.dbpath = os.path.join(self.dir, "shared.db")

    def test_python_zadd_node_zrange(self):
        db = create_db(self.dbpath)
        c = kv(db)
        c.zadd("board", 100, "ada")
        c.zadd("board", 60, "bo")
        c.zadd("board", 80, "cy")
        db.close()
        out = _node(
            "const {kv}=require(" + json.dumps(KV_DIST) + ");"
            f"const{{createDb}}=require({json.dumps(DIST)});"
            f"const db=createDb({json.dumps(self.dbpath)});"
            "process.stdout.write(JSON.stringify(kv(db).zrange('board',0,-1)));"
            "db.$disconnect&&db.$disconnect();"
        )
        self.assertEqual(json.loads(out.stdout), ["bo", "cy", "ada"])

    def test_node_zadd_python_zrange(self):
        _node(
            "const {kv}=require(" + json.dumps(KV_DIST) + ");"
            f"const{{createDb}}=require({json.dumps(DIST)});"
            f"const db=createDb({json.dumps(self.dbpath)});"
            "const c=kv(db);c.zadd('lb',5,'x');c.zadd('lb',9,'y');c.zadd('lb',1,'z');"
            "db.$disconnect&&db.$disconnect();"
        )
        db = create_db(self.dbpath)
        try:
            self.assertEqual(kv(db).zrange("lb", 0, -1), ["z", "x", "y"])
            self.assertEqual(kv(db).zscore("lb", "y"), 9)
        finally:
            db.close()


@unittest.skipUnless(_have_node() and os.path.exists(QUEUE_DIST), "node + queue bundle required")
class TestQueueInterop(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="monlite-queue-")
        self.dbpath = os.path.join(self.dir, "shared.db")

    def test_node_enqueues_python_claims(self):
        # Node enqueues; a Python worker claims + completes (the "Node serves, Python works" split).
        _node(
            "const {createQueue}=require(" + json.dumps(QUEUE_DIST) + ");"
            f"const{{createDb}}=require({json.dumps(DIST)});"
            f"const db=createDb({json.dumps(self.dbpath)});"
            "const q=createQueue(db);q.add('emails',{to:'a@b.c'});q.add('emails',{to:'d@e.f'});"
            "db.$disconnect&&db.$disconnect();"
        )
        from monlite.queue import create_queue

        db = create_db(self.dbpath)
        try:
            q = create_queue(db)
            job = q.claim("emails")
            self.assertIsNotNone(job)
            self.assertEqual(job["payload"], {"to": "a@b.c"})
            q.complete(job)
            self.assertEqual(q.size("pending", "emails"), 1)  # one still waiting
        finally:
            db.close()

    def test_python_enqueues_node_counts(self):
        from monlite.queue import create_queue

        db = create_db(self.dbpath)
        create_queue(db).add("sms", {"to": "x"})
        db.close()
        out = _node(
            "const {createQueue}=require(" + json.dumps(QUEUE_DIST) + ");"
            f"const{{createDb}}=require({json.dumps(DIST)});"
            f"const db=createDb({json.dumps(self.dbpath)});"
            "process.stdout.write(String(createQueue(db).counts('sms').pending));"
            "db.$disconnect&&db.$disconnect();"
        )
        self.assertEqual(out.stdout.strip(), "1")


if __name__ == "__main__":
    unittest.main()
