"""Environment-driven settings (names shared with the API where they overlap)."""

from __future__ import annotations

import socket
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    redis_url: str = "redis://localhost:6379/0"
    database_url: str = "postgresql://postgres:postgres@localhost:5432/ftth"
    worker_id: str = Field(default_factory=socket.gethostname, min_length=1, max_length=64)
    storage_driver: Literal["fs", "s3"] = "fs"
    storage_fs_root: str = "/var/lib/ftth/storage"
    s3_endpoint: str | None = None
    s3_bucket: str | None = None
    s3_access_key: str | None = None
    s3_secret_key: str | None = None
    s3_region: str = "us-east-1"
    converter_timeout_s: int = 300
    converter_max_old_space_mb: int = 2048
