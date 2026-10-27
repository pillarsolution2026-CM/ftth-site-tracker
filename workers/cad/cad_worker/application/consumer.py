"""Job dispatch and consumer loop (queue-agnostic)."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from cad_worker.application.health import check_health
from cad_worker.application.ports import JobQueue


def handle_job(job: dict[str, Any]) -> dict[str, Any]:
    if job.get("type") == "health":
        return {"ok": True, "result": check_health().to_dict()}
    return {"ok": False, "error": f"unsupported job type: {job.get('type')!r}"}


def process_one(queue: JobQueue, timeout_s: int = 5) -> bool:
    """Process at most one job. Returns True if a job was consumed."""
    job = queue.pop_job(timeout_s)
    if job is None:
        return False
    job_id = str(job.get("id", ""))
    if not job_id:
        return True  # malformed: nowhere to write a result
    queue.put_result(job_id, handle_job(job))
    return True


def run_loop(queue: JobQueue, should_stop: Callable[[], bool], timeout_s: int = 5) -> None:
    while not should_stop():
        process_one(queue, timeout_s)
