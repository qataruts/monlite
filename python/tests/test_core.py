import unittest

from monlite import create_db


class TestCore(unittest.TestCase):
    def setUp(self):
        self.db = create_db(":memory:")
        self.users = self.db.collection("users")

    def tearDown(self):
        self.db.close()

    def test_create_and_read(self):
        u = self.users.create({"name": "Ali", "age": 30, "tags": ["admin"]})
        self.assertIn("_id", u)
        self.assertEqual(u["name"], "Ali")
        got = self.users.find_by_id(u["_id"])
        self.assertEqual(got["age"], 30)
        self.assertEqual(got["tags"], ["admin"])

    def test_queries(self):
        self.users.create_many([
            {"name": "Ali", "age": 30, "role": "admin"},
            {"name": "Sara", "age": 25, "role": "user"},
            {"name": "Omar", "age": 40, "role": "admin"},
        ])
        adults = self.users.find_many(where={"age": {"gte": 30}}, order_by={"age": "asc"})
        self.assertEqual([u["name"] for u in adults], ["Ali", "Omar"])

        admins = self.users.find_many(where={"role": "admin"})
        self.assertEqual(len(admins), 2)

        either = self.users.find_many(where={"OR": [{"name": "Sara"}, {"age": {"gte": 40}}]})
        self.assertEqual({u["name"] for u in either}, {"Sara", "Omar"})

        self.assertEqual(self.users.count(where={"role": "admin"}), 2)
        self.assertTrue(self.users.exists(where={"name": "Ali"}))

    def test_string_and_array_ops(self):
        self.users.create({"name": "Alice", "tags": ["x", "y"]})
        self.assertTrue(self.users.find_first(where={"name": {"contains": "lic"}}))
        self.assertTrue(self.users.find_first(where={"name": {"startswith": "Al"}}))
        self.assertTrue(self.users.find_first(where={"name": {"contains": "ALICE", "mode": "insensitive"}}))
        self.assertTrue(self.users.find_first(where={"tags": {"has": "y"}}))

    def test_update_operators(self):
        u = self.users.create({"_id": "u1", "n": 1, "tags": []})
        self.users.update({"_id": "u1"}, {"$inc": {"n": 5}, "$push": {"tags": "a"}})
        got = self.users.find_by_id("u1")
        self.assertEqual(got["n"], 6)
        self.assertEqual(got["tags"], ["a"])
        self.users.update({"_id": "u1"}, {"$set": {"nested": {"x": 1}}, "$unset": {"n": True}})
        got = self.users.find_by_id("u1")
        self.assertEqual(got["nested"], {"x": 1})
        self.assertNotIn("n", got)

    def test_upsert_and_delete(self):
        self.users.upsert(where={"_id": "k"}, create={"_id": "k", "v": 1}, update={"$inc": {"v": 1}})
        self.users.upsert(where={"_id": "k"}, create={"_id": "k", "v": 1}, update={"$inc": {"v": 1}})
        self.assertEqual(self.users.find_by_id("k")["v"], 2)
        self.users.delete({"_id": "k"})
        self.assertIsNone(self.users.find_by_id("k"))

    def test_select_and_pagination(self):
        self.users.create_many([{"name": f"u{i}", "age": i} for i in range(10)])
        page = self.users.find_many(order_by={"age": "asc"}, take=3, skip=2, select={"name": True})
        self.assertEqual([u["name"] for u in page], ["u2", "u3", "u4"])
        self.assertNotIn("age", page[0])  # select narrows


if __name__ == "__main__":
    unittest.main()
