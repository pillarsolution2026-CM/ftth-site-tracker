"""Ports (protocols) implemented by adapters."""

from __future__ import annotations

from typing import Any, Protocol


class JobQueue(Protocol):
    def pop_job(self, timeout_s: int) -> dict[str, Any] | None:
        """Block up to timeout_s for the next job; None if none arrived."""
        ...

    def put_result(self, job_id: str, result: dict[str, Any]) -> None: ...
