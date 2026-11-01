"""Consumer semantics with an in-memory broker (the Redis protocol itself is in test_broker_pg)."""

from __future__ import annotations

import json
from typing import Any

import pytest
from pydantic import ValidationError

from cad_worker.adapters.job_message import CadBuildRevisionJob, CadExportAsBuiltJob, parse_job
from cad_worker.application.build_revision import BuildDeps
from cad_worker.application.consumer import Consumer
from cad_worker.application.export_asbuilt import ExportDeps
from cad_worker.application.import_job import ImportDeps
from cad_worker.application.ports import BrokerUnavailableError, RecoveredJob


class MemoryBroker:
    def __init__(self) -> None:
        self.acked: list[str] = []
        self.dead: list[str] = []
        self.results: dict[str, dict[str, Any]] = {}

    def claim(self, timeout_s: int) -> str | None:
        return None

    def ack(self, raw: str) -> None:
        self.acked.append(raw)

    def dead_letter(self, raw: str) -> None:
        self.dead.append(raw)

    def put_result(self, job_id: str, result: dict[str, Any]) -> None:
        self.results[job_id] = result

    def heartbeat(self) -> None: ...

    def recover(self, *, include_own: bool) -> list[RecoveredJob]:
        return []

    def ack_orphan(self, recovered: RecoveredJob) -> None: ...


class ExplodingRepo:
    def start_processing(self, *_: Any) -> bool:
        raise ConnectionError("database down")


NO_EXPORT = ExportDeps(repo=None, storage=None, writer=None)  # type: ignore[arg-type]


def make_consumer(broker: MemoryBroker, repo: Any = None) -> Consumer:
    deps = ImportDeps(repo=repo, storage=None, converter=None, reader=None)  # type: ignore[arg-type]
    build = BuildDeps(repo=repo, storage=None)  # type: ignore[arg-type]
    return Consumer(broker, deps, "w", build, NO_EXPORT)


def test_health_job_result_then_ack() -> None:
    broker = MemoryBroker()
    raw = json.dumps({"id": "j1", "type": "health"})
    make_consumer(broker).process_raw(raw)
    assert broker.results["j1"]["ok"] is True and broker.acked == [raw]


def test_invalid_message_is_dead_lettered_not_acked() -> None:
    broker = MemoryBroker()
    make_consumer(broker).process_raw('{"type": "parse"}')
    assert broker.dead == ['{"type": "parse"}'] and broker.acked == []


def test_infrastructure_error_leaves_job_in_flight() -> None:
    broker = MemoryBroker()
    raw = json.dumps(
        {
            "id": "7f0f3a0e-3c33-4a3b-9d3c-6e5f2f0b6a11",
            "type": "cad.import",
            "cadFileId": "7f0f3a0e-3c33-4a3b-9d3c-6e5f2f0b6a12",
            "projectId": "7f0f3a0e-3c33-4a3b-9d3c-6e5f2f0b6a13",
            "storageKey": "k",
            "format": "dxf",
            "attempt": 1,
            "enqueuedAt": "2026-10-27T10:00:00.000Z",
        }
    )
    with pytest.raises(ConnectionError):
        make_consumer(broker, ExplodingRepo()).process_raw(raw)
    assert broker.acked == [] and broker.dead == []


class FlakyBroker(MemoryBroker):
    """Raises BrokerUnavailableError for the first claims, then lets the loop stop."""

    def __init__(self, failures: int) -> None:
        super().__init__()
        self.failures = failures
        self.claims = 0

    def claim(self, timeout_s: int) -> str | None:
        self.claims += 1
        if self.claims <= self.failures:
            raise BrokerUnavailableError("Timeout reading from socket")
        return None


def test_loop_survives_a_queue_outage_with_growing_backoff() -> None:
    broker = FlakyBroker(failures=3)
    sleeps: list[float] = []
    deps = ImportDeps(repo=None, storage=None, converter=None, reader=None)  # type: ignore[arg-type]
    build = BuildDeps(repo=None, storage=None)  # type: ignore[arg-type]
    consumer = Consumer(broker, deps, "w", build, NO_EXPORT, sleep=sleeps.append)

    consumer.run(lambda: broker.claims >= 5)

    assert sleeps == [1.0, 2.0, 4.0]
    assert broker.claims == 5


BUILD_MESSAGE = {
    "id": "7f0f3a0e-3c33-4a3b-9d3c-6e5f2f0b6a21",
    "type": "cad.build_revision",
    "revisionId": "7f0f3a0e-3c33-4a3b-9d3c-6e5f2f0b6a22",
    "projectId": "7f0f3a0e-3c33-4a3b-9d3c-6e5f2f0b6a23",
    "cadFileId": "7f0f3a0e-3c33-4a3b-9d3c-6e5f2f0b6a24",
    "attempt": 1,
    "enqueuedAt": "2026-10-28T10:00:00.000Z",
    "future": "ignored",
}


def test_build_job_message_mirrors_the_zod_schema() -> None:
    job = parse_job(json.dumps(BUILD_MESSAGE))
    assert isinstance(job, CadBuildRevisionJob)
    assert str(job.revision_id).endswith("22") and str(job.cad_file_id).endswith("24")
    for broken in (
        {**BUILD_MESSAGE, "attempt": 4},
        {**BUILD_MESSAGE, "revisionId": "nope"},
        {k: v for k, v in BUILD_MESSAGE.items() if k != "cadFileId"},
    ):
        with pytest.raises(ValidationError):
            parse_job(json.dumps(broken))


class ExplodingRevisionRepo:
    def start_build(self, *_: Any) -> bool:
        raise ConnectionError("database down")


def test_build_job_infrastructure_error_leaves_job_in_flight() -> None:
    broker = MemoryBroker()
    deps = ImportDeps(repo=None, storage=None, converter=None, reader=None)  # type: ignore[arg-type]
    build = BuildDeps(repo=ExplodingRevisionRepo(), storage=None)  # type: ignore[arg-type]
    with pytest.raises(ConnectionError):
        Consumer(broker, deps, "w", build, NO_EXPORT).process_raw(json.dumps(BUILD_MESSAGE))
    assert broker.acked == [] and broker.dead == []


EXPORT_MESSAGE = {
    "id": "7f0f3a0e-3c33-4a3b-9d3c-6e5f2f0b6a31",
    "type": "cad.export_asbuilt",
    "exportId": "7f0f3a0e-3c33-4a3b-9d3c-6e5f2f0b6a32",
    "projectId": "7f0f3a0e-3c33-4a3b-9d3c-6e5f2f0b6a33",
    "attempt": 2,
    "enqueuedAt": "2026-11-01T10:00:00.000Z",
    "future": "ignored",
}


def test_export_job_message_mirrors_the_zod_schema() -> None:
    job = parse_job(json.dumps(EXPORT_MESSAGE))
    assert isinstance(job, CadExportAsBuiltJob)
    assert str(job.export_id).endswith("32") and str(job.project_id).endswith("33")
    assert job.attempt == 2
    for broken in (
        {**EXPORT_MESSAGE, "attempt": 0},
        {**EXPORT_MESSAGE, "attempt": 4},
        {**EXPORT_MESSAGE, "exportId": "nope"},
        {k: v for k, v in EXPORT_MESSAGE.items() if k != "projectId"},
        {k: v for k, v in EXPORT_MESSAGE.items() if k != "enqueuedAt"},
    ):
        with pytest.raises(ValidationError):
            parse_job(json.dumps(broken))


class ExplodingExportRepo:
    def start_export(self, *_: Any) -> bool:
        raise ConnectionError("database down")


def test_export_job_infrastructure_error_leaves_job_in_flight() -> None:
    broker = MemoryBroker()
    deps = ImportDeps(repo=None, storage=None, converter=None, reader=None)  # type: ignore[arg-type]
    build = BuildDeps(repo=None, storage=None)  # type: ignore[arg-type]
    export = ExportDeps(repo=ExplodingExportRepo(), storage=None, writer=None)  # type: ignore[arg-type]
    with pytest.raises(ConnectionError):
        Consumer(broker, deps, "w", build, export).process_raw(json.dumps(EXPORT_MESSAGE))
    assert broker.acked == [] and broker.dead == []
