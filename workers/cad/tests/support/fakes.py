"""Test doubles for the ports that are not under test (never the database)."""

from __future__ import annotations

import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from cad_worker.adapters.ezdxf_reader import EzdxfReader
from cad_worker.adapters.job_message import CadImportJob
from cad_worker.application.ports import ConversionResult, DrawingSource, ImportFailure


class FailingConverter:
    def convert(self, dwg_path: Path, out_dir: Path) -> ConversionResult:
        raise ImportFailure("CONVERTER_FAILED", "converter exited with code 4", "libredwg: boom")


class CopyConverter:
    """Pretends a DWG is already a DXF: copies the bytes (the fixture file is DXF content)."""

    def convert(self, dwg_path: Path, out_dir: Path) -> ConversionResult:
        out = out_dir / "converted.dxf"
        out.write_bytes(dwg_path.read_bytes())
        return ConversionResult(out, "libredwg", "0.0-test", "converted by CopyConverter")


class HookReader:
    """EzdxfReader that runs a callback after the file is loaded (e.g. to supersede the job)."""

    def __init__(self, after_open: Callable[[], None]) -> None:
        self._inner = EzdxfReader()
        self._after_open = after_open

    def open(self, path: Path) -> DrawingSource:
        source = self._inner.open(path)
        self._after_open()
        return source


def make_job(
    project_id: uuid.UUID,
    cad_file_id: uuid.UUID,
    job_id: uuid.UUID,
    storage_key: str,
    fmt: Literal["dwg", "dxf"],
    attempt: int = 1,
) -> CadImportJob:
    return CadImportJob(
        id=job_id,
        type="cad.import",
        cadFileId=cad_file_id,
        projectId=project_id,
        storageKey=storage_key,
        format=fmt,
        attempt=attempt,
        enqueuedAt=datetime.now(UTC),
    )
