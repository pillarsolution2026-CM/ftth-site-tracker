"""Shared fixtures: real PostGIS (never mocked) and real Redis, plus a project/file factory."""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import psycopg
import pytest
import redis

from tests.support.docker import docker_available, postgis_container, redis_container
from tests.support.env import MIGRATIONS_DIR, env_value

MIGRATION_FILES = sorted(MIGRATIONS_DIR.glob("*.sql"))


def _apply_migrations(admin_url: str, db_name: str) -> str:
    with psycopg.connect(admin_url, autocommit=True) as admin:
        admin.execute(f'CREATE DATABASE "{db_name}"')
    base, _, _ = admin_url.rpartition("/")
    url = f"{base}/{db_name}"
    with psycopg.connect(url, autocommit=True) as conn:
        for path in MIGRATION_FILES:
            conn.execute(path.read_text("utf-8"))
    return url


@pytest.fixture(scope="session")
def pg_server_url() -> Iterator[str]:
    url = env_value("TEST_DATABASE_URL")
    if url:
        yield url
    elif docker_available():
        with postgis_container() as container_url:
            yield container_url
    else:
        pytest.skip("no PostGIS: set TEST_DATABASE_URL or make docker available")


@pytest.fixture(scope="session")
def database_url(pg_server_url: str) -> Iterator[str]:
    """A fresh database with every API migration applied (the schema the worker writes to)."""
    name = f"cad_worker_{uuid.uuid4().hex[:10]}"
    url = _apply_migrations(pg_server_url, name)
    yield url
    with psycopg.connect(pg_server_url, autocommit=True) as admin:
        admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


@pytest.fixture(scope="session")
def redis_server_url() -> Iterator[str]:
    url = env_value("TEST_REDIS_URL")
    if url:
        yield url
    elif docker_available():
        with redis_container() as container_url:
            yield container_url
    else:
        pytest.skip("no Redis: set TEST_REDIS_URL or make docker available")


@pytest.fixture
def redis_client(redis_server_url: str) -> Iterator[redis.Redis]:
    client: redis.Redis = redis.Redis.from_url(redis_server_url, decode_responses=True)
    client.flushdb()
    yield client
    client.flushdb()
    client.close()


@pytest.fixture
def db(database_url: str) -> Iterator[psycopg.Connection[Any]]:
    with psycopg.connect(database_url, autocommit=True) as conn:
        yield conn


@dataclass(frozen=True)
class QueuedFile:
    project_id: uuid.UUID
    cad_file_id: uuid.UUID
    job_id: uuid.UUID
    storage_key: str
    format: str


@pytest.fixture
def make_cad_file(db: psycopg.Connection[Any]) -> Any:
    """Insert a project and a `queued` cad_files row; the original stays in `storage_root`."""

    def factory(
        data: bytes, fmt: str, storage_root: Path, *, write_object: bool = True
    ) -> QueuedFile:
        project_id, file_id, job_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        db.execute(
            "INSERT INTO projects (id, name, client, crs_epsg, currency) "
            "VALUES (%s, 'p', 'c', 32636, 'EGP')",
            (project_id,),
        )
        key = f"projects/{project_id}/cad/{file_id}/original.{fmt}"
        if write_object:
            target = storage_root / key
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        db.execute(
            "INSERT INTO cad_files (id, project_id, original_name, format, size_bytes, sha256, "
            "storage_key, status, current_job_id, queued_at) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, 'queued', %s, now())",
            (file_id, project_id, f"drawing.{fmt}", fmt, max(len(data), 1), "a" * 64, key, job_id),
        )
        return QueuedFile(project_id, file_id, job_id, key, fmt)

    return factory
