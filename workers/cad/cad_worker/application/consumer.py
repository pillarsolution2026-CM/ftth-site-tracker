"""Consumer loop (ADR-013): claim -> process -> ack, plus heartbeat and orphan recovery."""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from typing import Any

from pydantic import ValidationError

from cad_worker.adapters.job_message import (
    CadBuildRevisionJob,
    CadExportAsBuiltJob,
    CadHealthJob,
    CadImportJob,
    parse_job,
)
from cad_worker.application.build_revision import BuildDeps, run_build
from cad_worker.application.export_asbuilt import ExportDeps, run_export
from cad_worker.application.health import check_health
from cad_worker.application.import_job import ImportDeps, run_import
from cad_worker.application.ports import BrokerUnavailableError, JobBroker

log = logging.getLogger(__name__)

HEARTBEAT_INTERVAL_S = 10
RECOVERY_INTERVAL_S = 60
MAX_BACKOFF_S = 30.0


def handle_health(job: CadHealthJob) -> dict[str, Any]:
    return {"ok": True, "result": check_health().to_dict()}


class Consumer:
    def __init__(
        self,
        broker: JobBroker,
        deps: ImportDeps,
        worker_id: str,
        build: BuildDeps,
        export: ExportDeps,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._broker = broker
        self._deps = deps
        self._build = build
        self._export = export
        self._worker_id = worker_id
        self._sleep = sleep

    def process_raw(self, raw: str) -> None:
        """Handle one claimed item. Acks only after the database outcome is committed; an
        infrastructure error propagates and leaves the item in the in-flight list."""
        try:
            job = parse_job(raw)
        except ValidationError:
            log.warning("invalid job message moved to cad:dead")
            self._broker.dead_letter(raw)
            return
        if isinstance(job, CadHealthJob):
            self._broker.put_result(job.id, handle_health(job))
        elif isinstance(job, CadBuildRevisionJob):
            run_build(job, self._build, self._worker_id)
        elif isinstance(job, CadExportAsBuiltJob):
            run_export(job, self._export, self._worker_id)
        else:
            run_import(job, self._deps, self._worker_id)
        self._broker.ack(raw)

    def process_one(self, timeout_s: int = 5) -> bool:
        raw = self._broker.claim(timeout_s)
        if raw is None:
            return False
        self.process_raw(raw)
        return True

    def recover(self, *, include_own: bool) -> None:
        """ADR-013 for every durable job type: at MAX_ATTEMPTS the file, the revision or the
        As-Built export is marked failed (`MAX_ATTEMPTS_EXCEEDED`) before the orphan is
        dropped."""
        for orphan in self._broker.recover(include_own=include_own):
            job = orphan.job
            msg = f"job {job.id} lost {job.attempt} times (worker crashed)"
            if isinstance(job, CadImportJob):
                self._deps.repo.fail(job, "MAX_ATTEMPTS_EXCEEDED", msg)
            elif isinstance(job, CadExportAsBuiltJob):
                self._export.repo.fail(job, "MAX_ATTEMPTS_EXCEEDED", msg)
            else:
                self._build.repo.fail(job, "MAX_ATTEMPTS_EXCEEDED", msg)
            self._broker.ack_orphan(orphan)

    def run(self, should_stop: Callable[[], bool], timeout_s: int = 5) -> None:
        stop_heartbeat = threading.Event()
        self._broker.heartbeat()
        beat = threading.Thread(
            target=self._heartbeat_loop, args=(stop_heartbeat,), daemon=True, name="heartbeat"
        )
        beat.start()
        try:
            self.recover(include_own=True)
            last_recovery = time.monotonic()
            backoff = 1.0
            while not should_stop():
                try:
                    self.process_one(timeout_s)
                    if time.monotonic() - last_recovery >= RECOVERY_INTERVAL_S:
                        self.recover(include_own=False)
                        last_recovery = time.monotonic()
                    backoff = 1.0
                except BrokerUnavailableError as error:
                    log.warning("queue unavailable (%s); retrying in %.0fs", error, backoff)
                    self._sleep(backoff)
                    backoff = min(backoff * 2, MAX_BACKOFF_S)
        finally:
            stop_heartbeat.set()
            beat.join(timeout=2)

    def _heartbeat_loop(self, stop: threading.Event) -> None:
        while not stop.wait(HEARTBEAT_INTERVAL_S):
            try:
                self._broker.heartbeat()
            except Exception:
                log.exception("heartbeat failed")
