"""ADR-013 protocol against real Redis and real PostGIS."""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

import psycopg
import pytest
import redis

from cad_worker.adapters.ezdxf_reader import EzdxfReader
from cad_worker.adapters.postgres_repo import PostgresCadRepository
from cad_worker.adapters.queue import RedisJobBroker
from cad_worker.adapters.storage import FsStorage
from cad_worker.application.consumer import Consumer
from cad_worker.application.import_job import ImportDeps
from tests.conftest import QueuedFile
from tests.support.dxf_samples import write_sample
from tests.support.fakes import FailingConverter

WORKER = "worker-a"


def message(f: QueuedFile, attempt: int = 1, job_id: uuid.UUID | None = None) -> str:
    return json.dumps(
        {
            "id": str(job_id or f.job_id),
            "type": "cad.import",
            "cadFileId": str(f.cad_file_id),
            "projectId": str(f.project_id),
            "storageKey": f.storage_key,
            "format": f.format,
            "attempt": attempt,
            "enqueuedAt": "2026-10-27T10:00:00.000Z",
        }
    )


@pytest.fixture
def consumer(database_url: str, redis_client: redis.Redis, tmp_path: Path) -> Consumer:
    deps = ImportDeps(
        repo=PostgresCadRepository(database_url),
        storage=FsStorage(tmp_path / "storage"),
        converter=FailingConverter(),
        reader=EzdxfReader(),
    )
    return Consumer(RedisJobBroker(redis_client, WORKER), deps, WORKER)


@pytest.fixture
def queued(make_cad_file: Any, tmp_path: Path) -> QueuedFile:
    data = write_sample(tmp_path / "s.dxf").read_bytes()
    result: QueuedFile = make_cad_file(data, "dxf", tmp_path / "storage")
    return result


def status_of(db: psycopg.Connection[Any], f: QueuedFile) -> tuple[Any, ...]:
    row = db.execute(
        "SELECT status, error_code FROM cad_files WHERE id = %s", (f.cad_file_id,)
    ).fetchone()
    assert row is not None
    return tuple(row)


def test_job_is_claimed_processed_and_acked(
    consumer: Consumer, redis_client: redis.Redis, db: psycopg.Connection[Any], queued: QueuedFile
) -> None:
    redis_client.lpush("cad:jobs", message(queued))
    assert consumer.process_one(timeout_s=1) is True
    assert status_of(db, queued) == ("processed", None)
    assert redis_client.llen("cad:jobs") == 0
    assert redis_client.llen(f"cad:processing:{WORKER}") == 0
    assert consumer.process_one(timeout_s=1) is False


def test_job_stays_in_flight_until_the_database_commit(
    consumer: Consumer, redis_client: redis.Redis, queued: QueuedFile
) -> None:
    raw = message(queued)
    redis_client.lpush("cad:jobs", raw)
    claimed = consumer._broker.claim(1)  # worker "crashes" right after the atomic claim
    assert claimed == raw
    assert redis_client.lrange(f"cad:processing:{WORKER}", 0, -1) == [raw]


def test_fifo_order(consumer: Consumer, redis_client: redis.Redis, queued: QueuedFile) -> None:
    first, second = message(queued, job_id=uuid.uuid4()), message(queued, job_id=uuid.uuid4())
    redis_client.lpush("cad:jobs", first)
    redis_client.lpush("cad:jobs", second)
    assert consumer._broker.claim(1) == first


def test_stale_job_is_acked_and_dropped(
    consumer: Consumer, redis_client: redis.Redis, db: psycopg.Connection[Any], queued: QueuedFile
) -> None:
    redis_client.lpush("cad:jobs", message(queued, job_id=uuid.uuid4()))  # not the current job id
    assert consumer.process_one(timeout_s=1) is True
    assert status_of(db, queued) == ("queued", None)
    assert redis_client.llen(f"cad:processing:{WORKER}") == 0


def test_invalid_messages_go_to_dead_letter(consumer: Consumer, redis_client: redis.Redis) -> None:
    for bad in ["not json", json.dumps({"type": "cad.import", "id": "nope"}), '{"type": "x"}']:
        redis_client.lpush("cad:jobs", bad)
        assert consumer.process_one(timeout_s=1) is True
    assert sorted(redis_client.lrange("cad:dead", 0, -1)) == sorted(
        ["not json", json.dumps({"type": "cad.import", "id": "nope"}), '{"type": "x"}']
    )
    assert redis_client.llen(f"cad:processing:{WORKER}") == 0


def test_health_job_writes_result(consumer: Consumer, redis_client: redis.Redis) -> None:
    redis_client.lpush("cad:jobs", json.dumps({"id": "h1", "type": "health"}))
    consumer.process_one(timeout_s=1)
    result = json.loads(redis_client.get("cad:results:h1") or "{}")
    assert result["ok"] is True and result["result"]["status"] == "ok"
    assert redis_client.ttl("cad:results:h1") > 0


def test_orphan_of_dead_worker_is_requeued_with_attempt_bumped(
    consumer: Consumer, redis_client: redis.Redis, queued: QueuedFile
) -> None:
    redis_client.lpush("cad:processing:dead-1", message(queued, attempt=1))  # no heartbeat key
    consumer.recover(include_own=False)
    assert redis_client.llen("cad:processing:dead-1") == 0
    requeued = json.loads(redis_client.lrange("cad:jobs", 0, -1)[0])
    assert requeued["attempt"] == 2 and requeued["id"] == str(queued.job_id)


def test_live_worker_list_is_left_alone(
    consumer: Consumer, redis_client: redis.Redis, queued: QueuedFile
) -> None:
    redis_client.lpush("cad:processing:alive-1", message(queued))
    redis_client.set("cad:worker:alive-1", "1", ex=30)
    consumer.recover(include_own=False)
    assert redis_client.llen("cad:processing:alive-1") == 1 and redis_client.llen("cad:jobs") == 0


def test_own_list_is_recovered_on_start_only(
    consumer: Consumer, redis_client: redis.Redis, queued: QueuedFile
) -> None:
    redis_client.lpush(f"cad:processing:{WORKER}", message(queued))
    redis_client.set(f"cad:worker:{WORKER}", "1", ex=30)  # heartbeat of the previous instance
    consumer.recover(include_own=False)
    assert redis_client.llen("cad:jobs") == 0
    consumer.recover(include_own=True)
    assert redis_client.llen(f"cad:processing:{WORKER}") == 0
    assert json.loads(redis_client.lrange("cad:jobs", 0, -1)[0])["attempt"] == 2


def test_requeue_is_atomic_per_item(redis_client: redis.Redis, queued: QueuedFile) -> None:
    """Two recoverers racing for the same orphan requeue it once."""
    redis_client.lpush("cad:processing:dead-1", message(queued))
    a, b = RedisJobBroker(redis_client, "r1"), RedisJobBroker(redis_client, "r2")
    a.recover(include_own=False)
    b.recover(include_own=False)
    assert redis_client.llen("cad:jobs") == 1


def test_third_crash_marks_file_failed(
    consumer: Consumer, redis_client: redis.Redis, db: psycopg.Connection[Any], queued: QueuedFile
) -> None:
    db.execute("UPDATE cad_files SET status = 'processing' WHERE id = %s", (queued.cad_file_id,))
    redis_client.lpush("cad:processing:dead-1", message(queued, attempt=3))
    consumer.recover(include_own=False)
    assert status_of(db, queued) == ("failed", "MAX_ATTEMPTS_EXCEEDED")
    assert redis_client.llen("cad:processing:dead-1") == 0 and redis_client.llen("cad:jobs") == 0
    types = [
        r[0]
        for r in db.execute(
            "SELECT type FROM events WHERE entity_id = %s", (str(queued.cad_file_id),)
        ).fetchall()
    ]
    assert types == ["cad_file.failed"]


def test_invalid_item_in_orphan_list_goes_to_dead_letter(
    consumer: Consumer, redis_client: redis.Redis
) -> None:
    redis_client.lpush("cad:processing:dead-1", "garbage")
    consumer.recover(include_own=False)
    assert redis_client.lrange("cad:dead", 0, -1) == ["garbage"]
    assert redis_client.llen("cad:processing:dead-1") == 0


def test_heartbeat_sets_expiring_key(consumer: Consumer, redis_client: redis.Redis) -> None:
    consumer._broker.heartbeat()
    assert 0 < redis_client.ttl(f"cad:worker:{WORKER}") <= 30


def test_run_loop_recovers_own_list_then_processes(
    consumer: Consumer, redis_client: redis.Redis, db: psycopg.Connection[Any], queued: QueuedFile
) -> None:
    """Restart scenario: the previous instance died after claiming; the new one finishes the job."""
    redis_client.lpush(f"cad:processing:{WORKER}", message(queued))
    stops = iter([False, False, True])
    consumer.run(lambda: next(stops), timeout_s=1)
    assert status_of(db, queued) == ("processed", None)
    assert redis_client.llen(f"cad:processing:{WORKER}") == 0
