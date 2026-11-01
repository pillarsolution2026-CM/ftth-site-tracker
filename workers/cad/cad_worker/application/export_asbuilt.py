"""Use case: process one `cad.export_asbuilt` job (Phase 4, ADR-030).

queued -> processing -> done, or failed with a code. The DXF is built from the export's revision
and the approved As-Built state read under the export row lock, uploaded to
`projects/<projectId>/asbuilt/<exportId>.dxf`, then `done` + event are committed in the same
transaction. A superseded job (other `current_job_id`, or the row already final) writes nothing.
"""

from __future__ import annotations

import hashlib
import logging
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from cad_worker.adapters.job_message import CadExportAsBuiltJob
from cad_worker.application.keys import asbuilt_export_key
from cad_worker.application.ports import (
    AsBuiltExportRepository,
    DxfWriter,
    ExportFailure,
    ExportResult,
    ObjectStorage,
)
from cad_worker.domain.asbuilt_drawing import DrawingDataError, build_drawing

log = logging.getLogger(__name__)

Outcome = Literal["done", "failed", "superseded"]


@dataclass(frozen=True, slots=True)
class ExportDeps:
    repo: AsBuiltExportRepository
    storage: ObjectStorage
    writer: DxfWriter
    tmp_root: Path | None = None


def run_export(job: CadExportAsBuiltJob, deps: ExportDeps, worker_id: str) -> Outcome:
    """Never raises for handled failures; infrastructure errors (database down) propagate so the
    job stays in the in-flight list and is redelivered after a restart."""
    if not deps.repo.start_export(job, worker_id):
        log.info("export job %s superseded before start; dropped", job.id)
        return "superseded"
    started = time.monotonic()
    try:
        outcome = _export(job, deps)
    except ExportFailure as failure:
        return _fail(deps, job, failure)
    except Exception as exc:
        log.exception("export job %s crashed", job.id)
        return _fail(deps, job, ExportFailure("INTERNAL", f"{type(exc).__name__}: {exc}"))
    log.info("export job %s %s in %.1fs", job.id, outcome, time.monotonic() - started)
    return outcome


def _fail(deps: ExportDeps, job: CadExportAsBuiltJob, failure: ExportFailure) -> Outcome:
    recorded = deps.repo.fail(job, failure.code, failure.message)
    log.warning("export job %s failed: %s %s", job.id, failure.code, failure.message)
    return "failed" if recorded else "superseded"


def _export(job: CadExportAsBuiltJob, deps: ExportDeps) -> Outcome:
    with deps.repo.open_export(job) as tx:
        if tx is None:
            return "superseded"
        if tx.inputs.revision_status != "published":
            raise ExportFailure(
                "REVISION_NOT_PUBLISHED", f"revision is {tx.inputs.revision_status}"
            )
        try:
            drawing = build_drawing(
                tx.load_design(), tx.load_asbuilt(), deps.writer.is_valid_layer_name
            )
        except DrawingDataError as exc:
            raise ExportFailure("GEOMETRY_INVALID", str(exc)) from exc
        data = deps.writer.write(drawing)
        key = asbuilt_export_key(job.project_id, job.export_id)
        _upload(deps, data, key)
        for warning in drawing.warnings:
            log.warning("export job %s: %s", job.id, warning)
        tx.finish(
            ExportResult(
                storage_key=key,
                size_bytes=len(data),
                sha256=hashlib.sha256(data).hexdigest(),
                stats=drawing.stats,
                warnings=drawing.warnings,
            )
        )
    return "done"


def _upload(deps: ExportDeps, data: bytes, key: str) -> None:
    try:
        with tempfile.TemporaryDirectory(prefix="asbuilt-", dir=deps.tmp_root) as tmp_name:
            path = Path(tmp_name) / "asbuilt.dxf"
            path.write_bytes(data)
            deps.storage.upload(path, key)
    except Exception as exc:
        raise ExportFailure("STORAGE_FAILED", f"{type(exc).__name__}: {exc}") from exc
