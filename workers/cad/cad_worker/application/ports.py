"""Ports (protocols) implemented by adapters."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import AbstractContextManager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Protocol

from cad_worker.adapters.job_message import CadImportJob
from cad_worker.domain.extents import Extents
from cad_worker.domain.model import (
    CadWarning,
    CurveRow,
    DrawingMeta,
    Feature,
    InsertRow,
    LayerRow,
    TextRow,
)

FailureCode = Literal[
    "FILE_MISSING",
    "CONVERTER_FAILED",
    "DXF_UNREADABLE",
    "TIMEOUT",
    "MAX_ATTEMPTS_EXCEEDED",
    "INTERNAL",
]


class ImportFailure(Exception):
    """A handled failure: the file is marked `failed` with this code (no automatic retry)."""

    def __init__(self, code: FailureCode, message: str, log: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.log = log


@dataclass(frozen=True, slots=True)
class ConversionResult:
    dxf_path: Path
    converter: Literal["libredwg", "oda"]
    version: str | None
    log: str


class ConverterPort(Protocol):
    def convert(self, dwg_path: Path, out_dir: Path) -> ConversionResult:
        """Raises ImportFailure(CONVERTER_FAILED | TIMEOUT)."""
        ...


class ObjectStorage(Protocol):
    def download(self, key: str, dest: Path) -> None:
        """Stream an object to `dest`. Raises FileNotFoundError when the key does not exist."""
        ...

    def upload(self, src: Path, key: str) -> None: ...


class DrawingSource(Protocol):
    meta: DrawingMeta

    def features(self) -> Iterator[Feature]: ...


class DrawingReader(Protocol):
    def open(self, path: Path) -> DrawingSource:
        """Raises ImportFailure(DXF_UNREADABLE)."""
        ...


@dataclass(frozen=True, slots=True)
class ExtractionResult:
    layers: list[LayerRow]
    insert_count: int
    text_count: int
    curve_count: int
    extents: Extents | None
    warnings: list[CadWarning]
    log: str
    dxf_version: str | None
    ins_units: int | None
    converter: Literal["libredwg", "oda", "none"]
    converter_version: str | None
    converted_storage_key: str | None


class ResultSink(Protocol):
    def add(self, row: InsertRow | TextRow | CurveRow) -> None: ...

    def commit(self, result: ExtractionResult) -> None:
        """Flush, write layers and file metadata, append `cad_file.processed`, commit."""
        ...


class CadRepository(Protocol):
    def start_processing(self, job: CadImportJob, worker_id: str) -> bool:
        """False when the job is not the file's current job (superseded or duplicate)."""
        ...

    def open_result(self, job: CadImportJob) -> AbstractContextManager[ResultSink | None]:
        """One transaction; yields None when the job is no longer current."""
        ...

    def fail(self, job: CadImportJob, code: FailureCode, message: str, log: str = "") -> bool:
        """Mark failed + event, guarded by `current_job_id`. False when superseded."""
        ...


class BrokerUnavailableError(Exception):
    """The queue could not be reached (network, timeout, restart). The consumer retries."""


class JobBroker(Protocol):
    """Reliable-queue operations of ADR-013. Items are the raw JSON strings."""

    def claim(self, timeout_s: int) -> str | None: ...

    def ack(self, raw: str) -> None: ...

    def dead_letter(self, raw: str) -> None: ...

    def put_result(self, job_id: str, result: dict[str, Any]) -> None: ...

    def heartbeat(self) -> None: ...

    def recover(self, *, include_own: bool) -> list[RecoveredJob]:
        """Requeue (attempt + 1) orphaned jobs; return those that ran out of attempts."""
        ...

    def ack_orphan(self, recovered: RecoveredJob) -> None: ...


@dataclass(frozen=True, slots=True)
class RecoveredJob:
    """A job found in a dead worker's list that has run out of attempts."""

    raw: str
    owner: str
    job: CadImportJob
