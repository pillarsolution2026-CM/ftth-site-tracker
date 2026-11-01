"""Ports (protocols) implemented by adapters."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import AbstractContextManager
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any, Literal, Protocol
from uuid import UUID

from cad_worker.adapters.job_message import (
    CadBuildRevisionJob,
    CadExportAsBuiltJob,
    CadImportJob,
    DurableJob,
)
from cad_worker.domain.asbuilt_drawing import (
    AsBuiltDrawing,
    AsBuiltFeatureIn,
    DesignFeatureIn,
    ExportStats,
)
from cad_worker.domain.crs_detect import CrsDetection
from cad_worker.domain.design_build import BackgroundSelection, DrawingData
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
from cad_worker.domain.revision_match import BaseFeature

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
    crs_detection: CrsDetection


class ResultSink(Protocol):
    @property
    def project_epsg(self) -> int | None:
        """`projects.crs_epsg`, read in the import transaction (input of the CRS detection)."""
        ...

    def add(self, row: InsertRow | TextRow | CurveRow) -> None: ...

    def commit(self, result: ExtractionResult) -> None:
        """Flush, write layers, file metadata and `crs_detection`, append `cad_file.processed`,
        commit."""
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
    job: DurableJob


# ---------- design revisions (Phase 1b, ADR-017) ----------

RevisionFailureCode = Literal[
    "MAPPING_INVALID",
    "CAD_FILE_NOT_PROCESSED",
    "TILES_FAILED",
    "MAX_ATTEMPTS_EXCEEDED",
    "INTERNAL",
]


class TileLimitError(Exception):
    """The revision would need more tiles or bytes than the tile writer allows."""


class BuildFailure(Exception):
    """A handled build failure: the revision is marked `failed` with this code (no retry)."""

    def __init__(self, code: RevisionFailureCode, message: str, log: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.log = log


@dataclass(frozen=True, slots=True)
class RevisionInputs:
    """The frozen inputs of a revision, read under the row lock."""

    revision_id: UUID
    project_id: UUID
    cad_file_id: UUID
    base_revision_id: UUID | None
    rules: object
    crs_epsg: int
    drawing_unit: str
    metres_per_unit: Decimal


@dataclass(frozen=True, slots=True)
class FeatureRow:
    """A design feature ready to be written (ids assigned, metres, revision CRS)."""

    feature_id: UUID
    feature_type: str
    code: str | None
    layer: str
    block_name: str | None
    source_kind: str
    source_handle: str
    # Routes: the polyline; points: one position (the adapter writes WKT with the revision SRID).
    coords: tuple[tuple[float, float], ...]
    attrs: dict[str, object]


@dataclass(frozen=True, slots=True)
class TextLinkRow:
    text_handle: str
    layer: str
    text: str | None
    raw_text: str
    readable: bool
    position: tuple[float, float]
    height_m: float
    kind: str
    status: str
    feature_id: UUID | None
    distance_m: Decimal | None
    confidence: Decimal


@dataclass(frozen=True, slots=True)
class DiffRow:
    feature_id: UUID
    feature_type: str
    change: str
    code: str | None
    previous_code: str | None
    distance_m: Decimal | None
    candidate_ids: tuple[UUID, ...]


@dataclass(frozen=True, slots=True)
class RevisionRows:
    new_feature_ids: tuple[tuple[UUID, str], ...]  # (id, feature_type) inserted into `features`
    features: tuple[FeatureRow, ...]
    text_links: tuple[TextLinkRow, ...]
    diff: tuple[DiffRow, ...]


@dataclass(frozen=True, slots=True)
class TileStats:
    tiles: int
    bytes: int


@dataclass(frozen=True, slots=True)
class BuildSummary:
    counts: dict[str, object]
    text_link_counts: dict[str, int]
    diff_counts: dict[str, int]
    tiles_storage_key: str | None
    warnings: list[dict[str, object]]
    log: str


class RevisionBuild(Protocol):
    """One open transaction on a locked `building` revision (guarded by `current_job_id`)."""

    inputs: RevisionInputs

    def load_drawing(self, curve_layers: frozenset[str]) -> DrawingData:
        """Rows of the revision's CAD file (drawing units). Raises
        BuildFailure(CAD_FILE_NOT_PROCESSED). Only curves on `curve_layers` are read."""
        ...

    def load_base(self) -> tuple[BaseFeature, ...]:
        """The base revision's features in this revision's CRS (empty without a base)."""
        ...

    def write(self, rows: RevisionRows) -> Decimal:
        """Insert features, design features, text links and diff; return Σ route `length_m`."""
        ...

    def render_tiles(self, dest: Path, background: BackgroundSelection) -> TileStats:
        """Write the PMTiles archive of the (uncommitted) revision to `dest`."""
        ...

    def finish(self, summary: BuildSummary) -> None:
        """Set `draft`, counts, tiles key, append `design_revision.built`, commit."""
        ...


class RevisionRepository(Protocol):
    def start_build(self, job: CadBuildRevisionJob, worker_id: str) -> bool:
        """`queued` -> `building` + event; False when the job is not current (superseded)."""
        ...

    def open_build(self, job: CadBuildRevisionJob) -> AbstractContextManager[RevisionBuild | None]:
        """Lock the revision and clear previous partial rows; None when superseded."""
        ...

    def fail(
        self, job: CadBuildRevisionJob, code: RevisionFailureCode, message: str, log: str = ""
    ) -> bool:
        """Mark `failed` + event, guarded by `current_job_id`. False when superseded."""
        ...


# ---------- As-Built DXF export (Phase 4, ADR-030) ----------

ExportFailureCode = Literal[
    "REVISION_NOT_PUBLISHED",
    "GEOMETRY_INVALID",
    "STORAGE_FAILED",
    "MAX_ATTEMPTS_EXCEEDED",
    "INTERNAL",
]


class ExportFailure(Exception):
    """A handled export failure: the row is marked `failed` with this code (no retry)."""

    def __init__(self, code: ExportFailureCode, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True, slots=True)
class ExportInputs:
    """The export row and its revision, read under the export row lock."""

    export_id: UUID
    project_id: UUID
    revision_id: UUID
    revision_status: str
    crs_epsg: int


@dataclass(frozen=True, slots=True)
class ExportResult:
    storage_key: str
    size_bytes: int
    sha256: str
    stats: ExportStats
    warnings: tuple[dict[str, object], ...]


class DxfWriter(Protocol):
    def is_valid_layer_name(self, name: str) -> bool: ...

    def write(self, drawing: AsBuiltDrawing) -> bytes:
        """DXF R2018 bytes (UTF-8), units metres."""
        ...


class AsBuiltExportSession(Protocol):
    """One open transaction holding the lock on a `processing` export row (current job)."""

    inputs: ExportInputs

    def load_design(self) -> tuple[DesignFeatureIn, ...]:
        """Design features of the export's revision, in the revision CRS."""
        ...

    def load_asbuilt(self) -> tuple[AsBuiltFeatureIn, ...]:
        """Approved As-Built rows of the project with a geometry or a label, revision CRS."""
        ...

    def finish(self, result: ExportResult) -> None:
        """Set `done` with key, size, sha256, stats; append `asbuilt_export.done`; commit."""
        ...


class AsBuiltExportRepository(Protocol):
    def start_export(self, job: CadExportAsBuiltJob, worker_id: str) -> bool:
        """`queued` -> `processing`; False when the job is not current or the row is final."""
        ...

    def open_export(
        self, job: CadExportAsBuiltJob
    ) -> AbstractContextManager[AsBuiltExportSession | None]:
        """Lock the export row; None when superseded."""
        ...

    def fail(self, job: CadExportAsBuiltJob, code: ExportFailureCode, message: str) -> bool:
        """Mark `failed` + event, guarded by `current_job_id`. False when superseded."""
        ...
