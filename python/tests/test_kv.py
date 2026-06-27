import time
import unittest

from monlite import create_db, kv


class TestKV(unittest.TestCase):
    def setUp(self):
        self.db = create_db(":memory:")
        self.cache = kv(self.db)

    def tearDown(self):
        self.db.close()

    def test_set_get_delete(self):
        self.cache.set("a", {"x": 1})
        self.assertEqual(self.cache.get("a"), {"x": 1})
        self.assertTrue(self.cache.has("a"))
        self.assertTrue(self.cache.delete("a"))
        self.assertIsNone(self.cache.get("a"))

    def test_ttl_expiry(self):
        self.cache.set("t", 1, ttl=20)
        self.assertEqual(self.cache.get("t"), 1)
        time.sleep(0.04)
        self.assertIsNone(self.cache.get("t"))
        self.assertEqual(self.cache.ttl("missing"), -2)

    def test_set_nx_lock(self):
        self.assertTrue(self.cache.set_nx("lock", 1, ttl=1000))
        self.assertFalse(self.cache.set_nx("lock", 1))

    def test_incr_and_keys(self):
        self.assertEqual(self.cache.incr("hits"), 1)
        self.assertEqual(self.cache.incr("hits", 5), 6)
        self.cache.set("a:1", 1)
        self.cache.set("a:2", 2)
        self.cache.set("b:1", 3)
        self.assertEqual(sorted(self.cache.keys("a:")), ["a:1", "a:2"])

    def test_namespaces_isolated(self):
        sessions = kv(self.db, namespace="sessions")
        sessions.set("x", 1)
        self.assertEqual(sessions.get("x"), 1)
        self.assertIsNone(self.cache.get("x"))  # default namespace doesn't see it


if __name__ == "__main__":
    unittest.main()
