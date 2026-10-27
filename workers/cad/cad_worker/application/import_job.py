"""Use case: process one `cad.import` job end to end (ADR-013)."""

from __future__ import annotations

import logging
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from cad_worker.adapters.job_message import CadImportJob
from cad_worker.application.extract import extract
from cad_worker.application.keys import converted_key
from cad_worker.application.ports import (
    CadRepository,
    ConverterPort,
    DrawingReader,
    ImportFailure,
    ObjectStorage,
)

log = logging.getLogger(__name__)

Outcome = Literal["processed", "failed", "superseded"]


@dataclass(frozen=True, slots=True)
class ImportDeps:
    repo: CadRepository
    storage: ObjectStorage
    converter: ConverterPort
    reader: DrawingReader
    tmp_root: Path | None = None


def run_import(job: CadImportJob, deps: ImportDeps, worker_id: str) -> Outcome:
    """Never raises for handled failures; infrastructure errors (database down) propagate so
    the job stays in the in-flight list and is redelivered after a restart."""
    if not deps.repo.start_processing(job, worker_id):
        log.info("job %s superseded before start; dropped", job.id)
        return "superseded"
    started = time.monotonic()
    try:
        outcome = _process(job, deps, started)
    except ImportFailure as failure:
        return _fail(deps, job, failure)
    except Exception as exc:
        log.exception("job %s crashed", job.id)
        return _fail(deps, job, ImportFailure("INTERNAL", f"{type(exc).__name__}: {exc}"))
    log.info("job %s %s in %.1fs", job.id, outcome, time.monotonic() - started)
    return outcome


def _fail(deps: ImportDeps, job: CadImportJob, failure: ImportFailure) -> Outcome:
    recorded = deps.repo.fail(job, failure.code, failure.message, failure.log)
    log.warning("job %s failed: %s %s", job.id, failure.code, failure.message)
    return "failed" if recorded else "superseded"


def _process(job: CadImportJob, deps: ImportDeps, started: float) -> Outcome:
    with tempfile.TemporaryDirectory(prefix="cad-", dir=deps.tmp_root) as tmp_name:
        tmp = Path(tmp_name)
        original = tmp / f"original.{job.format}"
        try:
            deps.storage.download(job.storage_key, original)
        except FileNotFoundError as exc:
            raise ImportFailure("FILE_MISSING", f"object not found: {job.storage_key}") from exc

        converter_log = ""
        converter: Literal["libredwg", "oda", "none"] = "none"
        converter_version: str | None = None
        converted: str | None = None
        dxf_path = original
        if job.format == "dwg":
            conversion = deps.converter.convert(original, tmp)
            dxf_path = conversion.dxf_path
            converter, converter_version = conversion.converter, conversion.version
            converter_log = conversion.log
            converted = converted_key(job.storage_key)
            deps.storage.upload(dxf_path, converted)

        source = deps.reader.open(dxf_path)
        converter_log += f"\nprepare: {time.monotonic() - started:.1f}s (download, convert, load)"
        with deps.repo.open_result(job) as sink:
            if sink is None:
                return "superseded"
            result = extract(
                source,
                sink,
                converter=converter,
                converter_version=converter_version,
                converted_storage_key=converted,
                converter_log=converter_log,
            )
            sink.commit(result)
    return "processed"
