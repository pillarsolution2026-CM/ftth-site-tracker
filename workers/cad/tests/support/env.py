"""Test environment lookups."""

from __future__ import annotations

import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
MIGRATIONS_DIR = REPO_ROOT / "apps/api/src/db/migrations"


def env_value(name: str) -> str | None:
    value = os.environ.get(name, "").strip()
    return value or None


def fixtures_dir() -> Path:
    """Real client drawings (git-ignored). Override with CAD_FIXTURES_DIR."""
    override = env_value("CAD_FIXTURES_DIR")
    return Path(override) if override else REPO_ROOT / "fixtures/cad"
