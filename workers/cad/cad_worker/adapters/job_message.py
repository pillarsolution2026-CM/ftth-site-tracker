"""Job message contract (ADR-013).

Mirror of `packages/shared/src/cad/cad-job.schemas.ts` — change both together.
Unknown fields are ignored (forward compatible, like Zod's default strip).
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

JOBS_KEY = "cad:jobs"
PROCESSING_PREFIX = "cad:processing:"
WORKER_HEARTBEAT_PREFIX = "cad:worker:"
DEAD_LETTER_KEY = "cad:dead"
RESULTS_PREFIX = "cad:results:"

CAD_JOB_MAX_ATTEMPTS = 3
WORKER_HEARTBEAT_TTL_S = 30


class _Message(BaseModel):
    model_config = ConfigDict(frozen=True, extra="ignore", populate_by_name=True)


class CadImportJob(_Message):
    id: UUID
    type: Literal["cad.import"]
    cad_file_id: UUID = Field(alias="cadFileId")
    project_id: UUID = Field(alias="projectId")
    storage_key: str = Field(alias="storageKey", min_length=1, max_length=512)
    format: Literal["dwg", "dxf"]
    attempt: int = Field(ge=1, le=CAD_JOB_MAX_ATTEMPTS)
    enqueued_at: datetime = Field(alias="enqueuedAt")


class CadHealthJob(_Message):
    id: str = Field(min_length=1)
    type: Literal["health"]


CadJob = Annotated[CadImportJob | CadHealthJob, Field(discriminator="type")]

CAD_JOB_ADAPTER: TypeAdapter[CadImportJob | CadHealthJob] = TypeAdapter(CadJob)


def parse_job(raw: str) -> CadImportJob | CadHealthJob:
    """Parse a raw Redis list item. Raises pydantic.ValidationError on a malformed message."""
    return CAD_JOB_ADAPTER.validate_json(raw)
