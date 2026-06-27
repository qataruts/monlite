"""Cross-language interop: a .db written by the @monlite/core (Node) round-trips
through the Python package and back. This is the whole point of the file format.

Skipped automatically when Node or the built JS core (dist/index.js) isn't present.
"""
import json
import os
import subprocess
import tempfile
import unittest

from monlite import create_db

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DIST = os.path.join(REPO, "dist", "index.js")


def _have_node():
    if not os.path.exists(DIST):
        return False
    try:
        subprocess.run(["node", "--version"], capture_output=True, check=True)
        return True
    except Exception:
        return False


def _node(script):
    return subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True)


@unittest.skipUnless(_have_node(), "node + dist/index.js required")
class TestInterop(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="monlite-interop-")
        self.dbpath = os.path.join(self.dir, "shared.db")

    def test_node_writes_python_reads(self):
        _node(
            f"(async()=>{{const{{createDb}}=require({json.dumps(DIST)});"
            f"const db=createDb({json.dumps(self.dbpath)});"
            "await db.collection('users').create({data:{_id:'u1',name:'Ali',age:30,tags:['admin'],profile:{city:'Doha'}}});"
            "await db.$disconnect();})()"
        )
        db = create_db(self.dbpath)
        try:
            doc = db.collection("users").find_by_id("u1")
            self.assertIsNotNone(doc)
            self.assertEqual(doc["name"], "Ali")
            self.assertEqual(doc["age"], 30)
            self.assertEqual(doc["tags"], ["admin"])
            self.assertEqual(doc["profile"]["city"], "Doha")
            # Python query over a Node-written collection
            hits = db.collection("users").find_many(where={"age": {"gte": 18}})
            self.assertEqual(len(hits), 1)
        finally:
            db.close()

    def test_python_writes_node_reads(self):
        db = create_db(self.dbpath)
        db.collection("notes").create({"_id": "p1", "text": "from python", "n": 7})
        db.close()
        out = _node(
            f"(async()=>{{const{{createDb}}=require({json.dumps(DIST)});"
            f"const db=createDb({json.dumps(self.dbpath)});"
            "const d=await db.collection('notes').findById('p1');"
            "process.stdout.write(JSON.stringify({text:d&&d.text,n:d&&d.n}));"
            "await db.$disconnect();})()"
        )
        got = json.loads(out.stdout)
        self.assertEqual(got["text"], "from python")
        self.assertEqual(got["n"], 7)

    def test_kv_shared_between_node_and_python(self):
        from monlite import kv

        db = create_db(self.dbpath)
        kv(db).set("config:model", "claude-opus", ttl=60_000)
        db.close()
        out = _node(
            f"(async()=>{{const{{createDb}}=require({json.dumps(DIST)});"
            "const {kv}=require(" + json.dumps(os.path.join(REPO, "packages", "kv", "dist", "index.js")) + ");"
            f"const db=createDb({json.dumps(self.dbpath)});"
            "process.stdout.write(String(kv(db).get('config:model')));"
            "await db.$disconnect();})()"
        )
        self.assertEqual(out.stdout.strip(), "claude-opus")


if __name__ == "__main__":
    unittest.main()
