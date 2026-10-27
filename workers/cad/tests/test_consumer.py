from typing import Any

from cad_worker.application.consumer import process_one
from cad_worker.application.ports import JobQueue


class FakeQueue:
    def __init__(self, jobs: list[dict[str, Any]]) -> None:
        self.jobs = jobs
        self.results: dict[str, dict[str, Any]] = {}

    def pop_job(self, timeout_s: int) -> dict[str, Any] | None:
        return self.jobs.pop(0) if self.jobs else None

    def put_result(self, job_id: str, result: dict[str, Any]) -> None:
        self.results[job_id] = result


def test_health_job_writes_result() -> None:
    fake = FakeQueue([{"id": "j1", "type": "health"}])
    q: JobQueue = fake
    assert process_one(q) is True
    assert fake.results["j1"]["ok"] is True
    assert fake.results["j1"]["result"]["status"] == "ok"


def test_unknown_job_type_reports_error() -> None:
    q = FakeQueue([{"id": "j2", "type": "parse"}])
    process_one(q)
    assert q.results["j2"]["ok"] is False


def test_empty_queue() -> None:
    assert process_one(FakeQueue([])) is False
