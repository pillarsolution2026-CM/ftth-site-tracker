"""Redis reliable queue (ADR-013): per-worker in-flight list, heartbeat, atomic requeue."""

from __future__ import annotations

import json
from typing import Any

import redis
from pydantic import ValidationError

from cad_worker.adapters.job_message import (
    CAD_JOB_MAX_ATTEMPTS,
    DEAD_LETTER_KEY,
    JOBS_KEY,
    PROCESSING_PREFIX,
    RESULTS_PREFIX,
    WORKER_HEARTBEAT_PREFIX,
    WORKER_HEARTBEAT_TTL_S,
    CadHealthJob,
    parse_job,
)
from cad_worker.application.ports import RecoveredJob

RESULT_TTL_S = 3600

# Atomic: only if `raw` is still in the dead worker's list is it moved, so two recoverers cannot
# both requeue the same job. KEYS: source list, destination list. ARGV: old item, new item.
_MOVE_LUA = """
if redis.call('LREM', KEYS[1], 1, ARGV[1]) > 0 then
  redis.call('LPUSH', KEYS[2], ARGV[2])
  return 1
end
return 0
"""


class RedisJobBroker:
    def __init__(self, client: redis.Redis, worker_id: str) -> None:
        self._client = client
        self._worker_id = worker_id
        self._processing = PROCESSING_PREFIX + worker_id
        self._move = client.register_script(_MOVE_LUA)

    @classmethod
    def from_url(cls, url: str, worker_id: str) -> RedisJobBroker:
        return cls(redis.Redis.from_url(url, decode_responses=True), worker_id)

    def ping(self) -> bool:
        return bool(self._client.ping())

    def claim(self, timeout_s: int) -> str | None:
        item = self._client.blmove(JOBS_KEY, self._processing, timeout_s, "RIGHT", "LEFT")
        return str(item) if item is not None else None

    def ack(self, raw: str) -> None:
        self._client.lrem(self._processing, 1, raw)

    def dead_letter(self, raw: str) -> None:
        self._move(keys=[self._processing, DEAD_LETTER_KEY], args=[raw, raw])

    def put_result(self, job_id: str, result: dict[str, Any]) -> None:
        self._client.set(RESULTS_PREFIX + job_id, json.dumps(result), ex=RESULT_TTL_S)

    def heartbeat(self) -> None:
        self._client.set(WORKER_HEARTBEAT_PREFIX + self._worker_id, "1", ex=WORKER_HEARTBEAT_TTL_S)

    def ack_orphan(self, recovered: RecoveredJob) -> None:
        self._client.lrem(PROCESSING_PREFIX + recovered.owner, 1, recovered.raw)

    def recover(self, *, include_own: bool) -> list[RecoveredJob]:
        """Requeue jobs of dead workers (no heartbeat) and, at start, of this worker's own list.

        Returns the jobs that already used all attempts; the caller marks the file failed and
        then calls `ack_orphan`.
        """
        exhausted: list[RecoveredJob] = []
        for key in self._client.scan_iter(match=PROCESSING_PREFIX + "*"):
            owner = str(key)[len(PROCESSING_PREFIX) :]
            own = owner == self._worker_id
            if own and not include_own:
                continue
            if not own and self._client.exists(WORKER_HEARTBEAT_PREFIX + owner):
                continue
            for raw in self._client.lrange(str(key), 0, -1):
                self._recover_one(str(key), owner, str(raw), exhausted)
        return exhausted

    def _recover_one(self, key: str, owner: str, raw: str, exhausted: list[RecoveredJob]) -> None:
        try:
            job = parse_job(raw)
        except ValidationError:
            self._move(keys=[key, DEAD_LETTER_KEY], args=[raw, raw])
            return
        if isinstance(job, CadHealthJob):
            self._client.lrem(key, 1, raw)
            return
        if job.attempt >= CAD_JOB_MAX_ATTEMPTS:
            exhausted.append(RecoveredJob(raw, owner, job))
            return
        message = json.loads(raw)
        message["attempt"] = job.attempt + 1
        self._move(keys=[key, JOBS_KEY], args=[raw, json.dumps(message, separators=(",", ":"))])
