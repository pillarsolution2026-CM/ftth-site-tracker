"""Redis list-based JobQueue adapter."""

from __future__ import annotations

import json
from typing import Any

import redis

JOBS_KEY = "cad:jobs"
RESULTS_PREFIX = "cad:results:"
RESULT_TTL_S = 3600


class RedisJobQueue:
    def __init__(self, client: redis.Redis) -> None:
        self._client = client

    @classmethod
    def from_url(cls, url: str) -> RedisJobQueue:
        return cls(redis.Redis.from_url(url, decode_responses=True))

    def ping(self) -> bool:
        return bool(self._client.ping())

    def pop_job(self, timeout_s: int) -> dict[str, Any] | None:
        item = self._client.blpop([JOBS_KEY], timeout=timeout_s)
        if not item:
            return None
        try:
            payload = json.loads(item[1])
        except (TypeError, ValueError):
            return None
        return payload if isinstance(payload, dict) else None

    def put_result(self, job_id: str, result: dict[str, Any]) -> None:
        self._client.set(RESULTS_PREFIX + job_id, json.dumps(result), ex=RESULT_TTL_S)
