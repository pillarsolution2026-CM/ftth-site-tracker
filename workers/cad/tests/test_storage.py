from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from cad_worker.adapters.settings import Settings
from cad_worker.adapters.storage import FsStorage, S3Storage, build_storage
from cad_worker.application.keys import converted_key


def test_converted_key() -> None:
    assert converted_key("projects/p/cad/f/original.dwg") == "projects/p/cad/f/converted.dxf"


def test_fs_roundtrip_and_missing(tmp_path: Path) -> None:
    storage = FsStorage(tmp_path / "root")
    src = tmp_path / "a.dxf"
    src.write_bytes(b"data")
    storage.upload(src, "projects/p/cad/f/converted.dxf")
    dest = tmp_path / "out.dxf"
    storage.download("projects/p/cad/f/converted.dxf", dest)
    assert dest.read_bytes() == b"data"
    assert not list((tmp_path / "root").rglob("*.tmp"))
    with pytest.raises(FileNotFoundError):
        storage.download("projects/p/cad/f/none.dxf", dest)


@pytest.mark.parametrize("key", ["../etc/passwd", "/abs/path", "a/../../b", ""])
def test_fs_rejects_unsafe_keys(tmp_path: Path, key: str) -> None:
    with pytest.raises(ValueError, match="invalid storage key"):
        FsStorage(tmp_path).download(key, tmp_path / "x")


class FakeS3:
    def __init__(self, error_code: str | None = None) -> None:
        self.error_code = error_code
        self.calls: list[tuple[str, ...]] = []

    def download_file(self, bucket: str, key: str, dest: str) -> None:
        if self.error_code:
            err = Exception("boom")
            err.response = {"Error": {"Code": self.error_code}}  # type: ignore[attr-defined]
            raise err
        Path(dest).write_bytes(b"s3data")
        self.calls.append(("get", bucket, key))

    def upload_file(self, src: str, bucket: str, key: str) -> None:
        self.calls.append(("put", bucket, key))


def test_s3_download_upload(tmp_path: Path) -> None:
    client = FakeS3()
    storage = S3Storage(client, "bkt")
    dest = tmp_path / "o"
    storage.download("k", dest)
    storage.upload(dest, "k2")
    assert dest.read_bytes() == b"s3data" and client.calls == [
        ("get", "bkt", "k"),
        ("put", "bkt", "k2"),
    ]


def test_s3_missing_object_maps_to_file_not_found(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        S3Storage(FakeS3("NoSuchKey"), "b").download("k", tmp_path / "o")
    with pytest.raises(Exception, match="boom"):
        S3Storage(FakeS3("AccessDenied"), "b").download("k", tmp_path / "o")


def test_build_storage_selects_driver_and_validates_s3(tmp_path: Path) -> None:
    fs = build_storage(Settings(storage_driver="fs", storage_fs_root=str(tmp_path)))
    assert isinstance(fs, FsStorage)
    with pytest.raises(ValueError, match="S3_BUCKET"):
        build_storage(Settings(storage_driver="s3", s3_endpoint="http://x"))
    s3 = build_storage(
        Settings(
            storage_driver="s3",
            s3_endpoint="http://localhost:9000",
            s3_bucket="b",
            s3_access_key="k",
            s3_secret_key="s",
        )
    )
    assert isinstance(s3, S3Storage)


def test_settings_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("WORKER_ID", raising=False)
    assert Settings().worker_id
    monkeypatch.setenv("WORKER_ID", "w-9")
    monkeypatch.setenv("STORAGE_DRIVER", "s3")
    settings: Any = Settings()
    assert settings.worker_id == "w-9" and settings.storage_driver == "s3"
