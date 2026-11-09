"""Use case: process one `cad.render_view` job (ADR-039).

`view_status` queued -> ready, or failed with a code. The job runs only while it is the file's
`view_job_id` and the view is `queued` (a superseded job writes nothing). The DXF (converted, else
the original DXF) is rendered by the renderer (a child process with timeout and memory limit in
production) and uploaded to its own key `projects/<p>/cad/<f>/view-<jobId>.json.gz` with no
transaction open; then one short transaction locks the row, re-checks the job and sets `ready`.
A job found stale at that point deletes its upload (best effort).
"""

from __future__ import annotations

import logging
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from cad_worker.adapters.job_message import CadRenderViewJob
from cad_worker.application.keys import drawing_view_key
from cad_worker.application.ports import (
    DeletableStorage,
    DrawingViewRepository,
    ViewFailure,
    ViewRenderer,
    ViewResult,
)
from cad_worker.domain.extents import Extents

log = logging.getLogger(__name__)

Outcome = Literal["ready", "failed", "superseded"]


@dataclass(frozen=True, slots=True)
class ViewDeps:
    repo: DrawingViewRepository
    storage: DeletableStorage
    renderer: ViewRenderer
    tmp_root: Path | None = None


def run_render(job: CadRenderViewJob, deps: ViewDeps, worker_id: str) -> Outcome:
    """Never raises for handled failures; infrastructure errors (database down) propagate so the
    job stays in the in-flight list and is redelivered after a restart."""
    inputs = deps.repo.start_view(job)
    if inputs is None:
        log.info("view job %s superseded before start; dropped", job.id)
        return "superseded"
    started = time.monotonic()
    try:
        if inputs.status != "processed":
            raise ViewFailure("FILE_NOT_PROCESSED", f"file is {inputs.status}")
        key = inputs.dxf_key
        if key is None:
            raise ViewFailure("FILE_NOT_PROCESSED", "no DXF of the file (DWG not converted)")
        outcome = _render(job, deps, key, inputs.extents, started, worker_id)
    except ViewFailure as failure:
        return _fail(deps, job, failure)
    except Exception as exc:
        log.exception("view job %s crashed", job.id)
        return _fail(deps, job, ViewFailure("INTERNAL", f"{type(exc).__name__}: {exc}"))
    return outcome


def _fail(deps: ViewDeps, job: CadRenderViewJob, failure: ViewFailure) -> Outcome:
    recorded = deps.repo.fail(job, failure.code, failure.message)
    log.warning("view job %s failed: %s %s", job.id, failure.code, failure.message)
    return "failed" if recorded else "superseded"


def _render(
    job: CadRenderViewJob,
    deps: ViewDeps,
    dxf_key: str,
    extents: Extents | None,
    started: float,
    worker_id: str,
) -> Outcome:
    key = drawing_view_key(job.project_id, job.cad_file_id, job.id)
    with tempfile.TemporaryDirectory(prefix="view-", dir=deps.tmp_root) as tmp_name:
        tmp = Path(tmp_name)
        dxf = tmp / "drawing.dxf"
        try:
            deps.storage.download(dxf_key, dxf)
        except FileNotFoundError as exc:
            raise ViewFailure("FILE_MISSING", f"object not found: {dxf_key}") from exc
        out = tmp / "view.json.gz"
        output = deps.renderer.render_to(dxf, out, str(job.cad_file_id), extents)
        try:
            deps.storage.upload(out, key)
        except Exception as exc:
            raise ViewFailure("STORAGE_FAILED", f"{type(exc).__name__}: {exc}") from exc
    stats: dict[str, object] = {
        **output.stats,
        "seconds": round(time.monotonic() - started, 1),
        "workerId": worker_id,
    }
    result = ViewResult(storage_key=key, size_bytes=output.size_bytes, stats=stats)
    # A database error propagates (the job is redelivered and rewrites the same per-job key).
    if not deps.repo.finish(job, result):
        log.info("view job %s superseded while rendering; dropped", job.id)
        _discard(deps, key)
        return "superseded"
    log.info("view job %s ready: %s", job.id, stats)
    return "ready"


def _discard(deps: ViewDeps, key: str) -> None:
    try:
        deps.storage.delete(key)
    except Exception:
        log.warning("could not delete stale drawing view %s", key, exc_info=True)
