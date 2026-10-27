"""ObjectStorage adapters (ADR-012): `fs` (shared volume) and `s3` (boto3). Files are streamed."""

from __future__ import annotations

import os
import shutil
from pathlib import Path, PurePosixPath
from typing import Any

from cad_worker.adapters.settings import Settings
from cad_worker.application.ports import ObjectStorage

_MISSING_CODES = {"404", "NoSuchKey", "NotFound"}


class FsStorage:
    def __init__(self, root: Path) -> None:
        self._root = root.resolve()

    def _path(self, key: str) -> Path:
        pure = PurePosixPath(key)
        if pure.is_absolute() or ".." in pure.parts or not key:
            raise ValueError(f"invalid storage key: {key!r}")
        return self._root.joinpath(*pure.parts)

    def download(self, key: str, dest: Path) -> None:
        shutil.copyfile(self._path(key), dest)  # FileNotFoundError when missing

    def upload(self, src: Path, key: str) -> None:
        target = self._path(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(f".{target.name}.{os.getpid()}.tmp")
        shutil.copyfile(src, tmp)
        os.replace(tmp, target)


class S3Storage:
    def __init__(self, client: Any, bucket: str) -> None:
        self._client = client
        self._bucket = bucket

    def download(self, key: str, dest: Path) -> None:
        try:
            self._client.download_file(self._bucket, key, str(dest))
        except Exception as exc:  # botocore.ClientError, typed loosely: boto3 ships no stubs
            code = str(getattr(exc, "response", {}).get("Error", {}).get("Code", ""))
            if code in _MISSING_CODES:
                raise FileNotFoundError(key) from exc
            raise

    def upload(self, src: Path, key: str) -> None:
        self._client.upload_file(str(src), self._bucket, key)


def build_storage(settings: Settings) -> ObjectStorage:
    if settings.storage_driver == "fs":
        return FsStorage(Path(settings.storage_fs_root))
    missing = [
        name
        for name, value in (
            ("S3_ENDPOINT", settings.s3_endpoint),
            ("S3_BUCKET", settings.s3_bucket),
            ("S3_ACCESS_KEY", settings.s3_access_key),
            ("S3_SECRET_KEY", settings.s3_secret_key),
        )
        if not value
    ]
    if missing:
        raise ValueError(f"STORAGE_DRIVER=s3 requires {', '.join(missing)}")
    import boto3  # imported lazily: only needed for s3

    client = boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
        region_name=settings.s3_region,
    )
    assert settings.s3_bucket is not None
    return S3Storage(client, settings.s3_bucket)
