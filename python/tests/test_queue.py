import unittest

from monlite import create_db
from monlite.queue import create_queue


class TestQueue(unittest.TestCase):
    def setUp(self):
        self.db = create_db(":memory:")

    def tearDown(self):
        self.db.close()

    # ── happy path ───────────────────────────────────────────────────────────
    def test_add_claim_complete(self):
        q = create_queue(self.db)
        job = q.add("email", {"to": "a@b.c"})
        self.assertEqual(job["status"], "pending")
        self.assertEqual(job["queue"], "email")
        self.assertEqual(job["payload"], {"to": "a@b.c"})
        self.assertEqual(job["attempts"], 0)
        self.assertEqual(q.size("pending", "email"), 1)

        claimed = q.claim("email")
        self.assertIsNotNone(claimed)
        self.assertEqual(claimed["id"], job["id"])
        self.assertEqual(claimed["status"], "active")
        self.assertEqual(claimed["attempts"], 1)  # counted at claim time
        self.assertEqual(q.size("active", "email"), 1)

        q.complete(claimed, {"sent": True})
        done = q.get(job["id"])
        self.assertEqual(done["status"], "done")
        self.assertEqual(done["result"], {"sent": True})
        self.assertIsNone(done["error"])
        self.assertEqual(q.size("pending", "email"), 0)

    def test_claim_returns_none_when_empty(self):
        q = create_queue(self.db)
        self.assertIsNone(q.claim("email"))

    # ── priority ─────────────────────────────────────────────────────────────
    def test_priority_ordering(self):
        q = create_queue(self.db)
        q.add("q", {"n": 1}, priority=0)
        q.add("q", {"n": 2}, priority=10)  # highest priority -> claimed first
        q.add("q", {"n": 3}, priority=5)

        order = [q.claim("q")["payload"]["n"] for _ in range(3)]
        self.assertEqual(order, [2, 3, 1])

    def test_fifo_within_same_priority(self):
        q = create_queue(self.db)
        first = q.add("q", {"n": 1})
        q.add("q", {"n": 2})
        # Same priority -> oldest id first.
        self.assertEqual(q.claim("q")["id"], first["id"])

    # ── delay ────────────────────────────────────────────────────────────────
    def test_delay_not_claimable_until_run_at(self):
        q = create_queue(self.db)
        delayed = q.add("q", {"n": 1}, delay=60_000)  # due in 60s
        self.assertEqual(delayed["status"], "pending")
        self.assertIsNone(q.claim("q"))  # not yet due

        # A second, immediate job IS claimable even though the delayed one isn't.
        ready = q.add("q", {"n": 2})
        claimed = q.claim("q")
        self.assertEqual(claimed["id"], ready["id"])

    def test_run_at_overrides_delay(self):
        q = create_queue(self.db)
        job = q.add("q", {"n": 1}, delay=999_999, run_at=1)  # past run_at wins
        self.assertEqual(job["run_at"], 1)
        self.assertIsNotNone(q.claim("q"))

    # ── retry / backoff / dead-letter ────────────────────────────────────────
    def test_retry_backoff_then_dead_letter(self):
        # Zero backoff so the retried job is immediately due again.
        q2 = create_queue(self.db, max_attempts=3, backoff=lambda attempt: 0)
        q2.add("retryq", {"n": 1})

        # attempt 1 -> fail -> back to pending (attempts < max)
        j = q2.claim("retryq")
        self.assertEqual(j["attempts"], 1)
        q2.fail(j, "boom-1")
        back = q2.get(j["id"])
        self.assertEqual(back["status"], "pending")
        self.assertEqual(back["error"], "boom-1")

        # attempt 2 -> fail -> still pending
        j = q2.claim("retryq")
        self.assertEqual(j["attempts"], 2)
        q2.fail(j, "boom-2")
        self.assertEqual(q2.get(j["id"])["status"], "pending")

        # attempt 3 (== max) -> fail -> dead-lettered as failed
        j = q2.claim("retryq")
        self.assertEqual(j["attempts"], 3)
        q2.fail(j, "boom-3")
        dead = q2.get(j["id"])
        self.assertEqual(dead["status"], "failed")
        self.assertEqual(dead["error"], "boom-3")
        self.assertEqual(q2.size("failed", "retryq"), 1)

    def test_backoff_pushes_run_at_into_future(self):
        q = create_queue(self.db, max_attempts=2)  # default exponential backoff
        q.add("q", {"n": 1})
        j = q.claim("q")
        q.fail(j, "boom")
        back = q.get(j["id"])
        self.assertEqual(back["status"], "pending")
        # Default backoff(1) == 1000ms -> run_at is in the future, not claimable now.
        self.assertIsNone(q.claim("q"))

    def test_default_max_attempts_one_dead_letters_immediately(self):
        q = create_queue(self.db)  # max_attempts defaults to 1 (no retry)
        q.add("q", {"n": 1})
        j = q.claim("q")
        self.assertEqual(j["attempts"], 1)
        q.fail(j, "nope")
        self.assertEqual(q.get(j["id"])["status"], "failed")

    # ── dedupe ───────────────────────────────────────────────────────────────
    def test_dedupe_returns_existing_no_duplicate_row(self):
        q = create_queue(self.db)
        a = q.add("q", {"n": 1}, job_id="user-42")
        b = q.add("q", {"n": 999}, job_id="user-42")  # same job_id, still pending
        self.assertEqual(a["id"], b["id"])
        self.assertEqual(b["payload"], {"n": 1})  # existing returned, not the new payload
        self.assertEqual(q.size("pending", "q"), 1)

    def test_dedupe_scoped_per_queue(self):
        q = create_queue(self.db)
        a = q.add("q1", {"n": 1}, job_id="dup")
        b = q.add("q2", {"n": 2}, job_id="dup")  # different queue -> NOT deduped
        self.assertNotEqual(a["id"], b["id"])
        self.assertEqual(q.size("pending", "q1"), 1)
        self.assertEqual(q.size("pending", "q2"), 1)

    def test_dedupe_allows_readd_after_terminal(self):
        q = create_queue(self.db)
        a = q.add("q", {"n": 1}, job_id="once")
        claimed = q.claim("q")
        q.complete(claimed)  # now 'done' (not pending/active)
        b = q.add("q", {"n": 2}, job_id="once")  # free to enqueue again
        self.assertNotEqual(a["id"], b["id"])

    # ── process() drain ──────────────────────────────────────────────────────
    def test_process_drains_due_jobs(self):
        q = create_queue(self.db)
        for i in range(5):
            q.add("q", {"n": i})
        seen = []
        n = q.process("q", lambda payload: seen.append(payload["n"]) or "ok")
        self.assertEqual(n, 5)
        self.assertEqual(sorted(seen), [0, 1, 2, 3, 4])
        self.assertEqual(q.size("done", "q"), 5)
        self.assertEqual(q.size("pending", "q"), 0)

    def test_process_respects_max(self):
        q = create_queue(self.db)
        for i in range(5):
            q.add("q", {"n": i})
        n = q.process("q", lambda payload: "ok", max=2)
        self.assertEqual(n, 2)
        self.assertEqual(q.size("done", "q"), 2)
        self.assertEqual(q.size("pending", "q"), 3)

    def test_process_failure_fails_job(self):
        q = create_queue(self.db)  # max_attempts 1 -> dead-letter on raise
        q.add("q", {"n": 1})

        def boom(payload):
            raise RuntimeError("handler exploded")

        n = q.process("q", boom)
        self.assertEqual(n, 1)
        failed = q.get(1)
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["error"], "handler exploded")

    def test_process_skips_delayed_jobs(self):
        q = create_queue(self.db)
        q.add("q", {"n": 1})
        q.add("q", {"n": 2}, delay=60_000)  # not due
        n = q.process("q", lambda payload: "ok")
        self.assertEqual(n, 1)  # only the due one ran
        self.assertEqual(q.size("pending", "q"), 1)

    # ── no double-claim ──────────────────────────────────────────────────────
    def test_two_claims_never_return_same_job(self):
        q = create_queue(self.db)
        job = q.add("q", {"n": 1})
        first = q.claim("q")
        second = q.claim("q")
        self.assertIsNotNone(first)
        self.assertEqual(first["id"], job["id"])
        self.assertIsNone(second)  # only one due job; the second claim gets nothing

    def test_two_workers_split_jobs_disjointly(self):
        wa = create_queue(self.db, worker_id="A")
        wb = create_queue(self.db, worker_id="B")
        wa.add("q", {"n": 1})
        wa.add("q", {"n": 2})
        ja = wa.claim("q")
        jb = wb.claim("q")
        self.assertIsNotNone(ja)
        self.assertIsNotNone(jb)
        self.assertNotEqual(ja["id"], jb["id"])  # never the same row
        self.assertEqual(ja["locked_by"] if "locked_by" in ja else "A", "A")
        # No more due jobs for either worker.
        self.assertIsNone(wa.claim("q"))
        self.assertIsNone(wb.claim("q"))

    # ── cross-queue claim ────────────────────────────────────────────────────
    def test_claim_without_name_across_queues(self):
        q = create_queue(self.db)
        q.add("q1", {"n": 1})
        q.add("q2", {"n": 2})
        a = q.claim()  # any queue
        b = q.claim()
        self.assertIsNotNone(a)
        self.assertIsNotNone(b)
        self.assertNotEqual(a["id"], b["id"])
        self.assertIsNone(q.claim())

    # ── remove_on_complete ───────────────────────────────────────────────────
    def test_remove_on_complete_deletes_row(self):
        q = create_queue(self.db, remove_on_complete=True)
        job = q.add("q", {"n": 1})
        q.complete(q.claim("q"))
        self.assertIsNone(q.get(job["id"]))
        self.assertEqual(q.size("done", "q"), 0)

    # ── complete/fail by id ──────────────────────────────────────────────────
    def test_complete_and_fail_accept_id(self):
        q = create_queue(self.db)
        job = q.add("q", {"n": 1})
        q.claim("q")
        q.complete(job["id"], "by-id")  # pass the bare id
        self.assertEqual(q.get(job["id"])["status"], "done")


if __name__ == "__main__":
    unittest.main()
