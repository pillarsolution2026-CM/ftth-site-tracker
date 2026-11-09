"""Use case: process one `cad.render_view` job (ADR-039).

`view_status` queued -> ready, or failed with a code. The job runs only while it is the file's
`view_job_id` and the view is `queued` (a superseded job writes nothing). The DXF (converted, else
the original DXF) is rendered outside any transaction; the upload to
`projects/<projectId>/cad/<cadFileId>/view.json.gz` and `ready` happen under the row lock, so a
stale job can never overwrite a newer job's file.
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
    DrawingViewRepository,
    ObjectStorage,
    ViewFailure,
    ViewRenderer,
    ViewResult,
)
from cad_worker.domain.drawing_view import write_view_gzip
from cad_worker.domain.extents import Extents

log = logging.getLogger(__name__)

Outcome = Literal["ready", "failed", "superseded"]

# Technical cap of the stored gzip file (the vertex / text caps keep real views far below it).
MAX_VIEW_BYTES = 256 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class ViewDeps:
    repo: DrawingViewRepository
    storage: ObjectStorage
    renderer: ViewRenderer
    tmp_root: Path | None = None
    max_bytes: int = MAX_VIEW_BYTES


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
    with tempfile.TemporaryDirectory(prefix="view-", dir=deps.tmp_root) as tmp_name:
        tmp = Path(tmp_name)
        dxf = tmp / "drawing.dxf"
        try:
            deps.storage.download(dxf_key, dxf)
        except FileNotFoundError as exc:
            raise ViewFailure("FILE_MISSING", f"object not found: {dxf_key}") from exc
        rendered = deps.renderer.render(dxf, str(job.cad_file_id), extents)
        dxf.unlink()
        out = tmp / "view.json.gz"
        with out.open("wb") as fh:
            write_view_gzip(rendered.view, fh)
        size = out.stat().st_size
        if size > deps.max_bytes:
            raise ViewFailure("TOO_LARGE", f"view is {size} bytes (max {deps.max_bytes})")
        view = rendered.view
        stats: dict[str, object] = {
            **rendered.stats.to_json(),
            "vertices": view.vertex_count,
            "texts": view.text_count,
            "truncated": view.truncated,
            "seconds": round(time.monotonic() - started, 1),
            "workerId": worker_id,
        }
        key = drawing_view_key(job.project_id, job.cad_file_id)
        with deps.repo.open_finish(job) as tx:
            if tx is None:
                log.info("view job %s superseded while rendering; dropped", job.id)
                return "superseded"
            try:
                deps.storage.upload(out, key)
            except Exception as exc:
                raise ViewFailure("STORAGE_FAILED", f"{type(exc).__name__}: {exc}") from exc
            tx.finish(ViewResult(storage_key=key, size_bytes=size, stats=stats))
    log.info("view job %s ready: %s", job.id, stats)
    return "ready"
