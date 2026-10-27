"""Start throw-away service containers for tests with the plain docker CLI."""

from __future__ import annotations

import shutil
import subprocess
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager

import psycopg
import redis

POSTGIS_IMAGE = "postgis/postgis:16-3.4"
REDIS_IMAGE = "redis:7.4-alpine"


def docker_available() -> bool:
    if shutil.which("docker") is None:
        return False
    return subprocess.run(["docker", "info"], capture_output=True, check=False).returncode == 0


def _run(image: str, port: int, env: dict[str, str]) -> str:
    cmd = ["docker", "run", "-d", "--rm", "-p", f"127.0.0.1::{port}"]
    for key, value in env.items():
        cmd += ["-e", f"{key}={value}"]
    out = subprocess.run([*cmd, image], capture_output=True, text=True, check=True)
    return out.stdout.strip()


def _host_port(container: str, port: int) -> int:
    out = subprocess.run(
        ["docker", "port", container, str(port)], capture_output=True, text=True, check=True
    )
    return int(out.stdout.splitlines()[0].rsplit(":", 1)[1])


def _wait(probe: Callable[[], object], what: str, timeout_s: float = 60) -> None:
    deadline = time.monotonic() + timeout_s
    last: Exception | None = None
    while time.monotonic() < deadline:
        try:
            probe()
            return
        except Exception as exc:
            last = exc
            time.sleep(0.5)
    raise RuntimeError(f"{what} did not become ready: {last}")


@contextmanager
def postgis_container() -> Iterator[str]:
    container = _run(
        POSTGIS_IMAGE,
        5432,
        {"POSTGRES_USER": "ftth", "POSTGRES_PASSWORD": "ftth", "POSTGRES_DB": "ftth_test"},
    )
    try:
        url = f"postgresql://ftth:ftth@127.0.0.1:{_host_port(container, 5432)}/ftth_test"

        def probe() -> None:
            # the image restarts postgres once after init; require two consecutive successes
            for _ in range(2):
                psycopg.connect(url, connect_timeout=2).close()
                time.sleep(1.5)

        _wait(probe, "postgis")
        yield url
    finally:
        subprocess.run(["docker", "stop", "-t", "2", container], capture_output=True, check=False)


@contextmanager
def redis_container() -> Iterator[str]:
    container = _run(REDIS_IMAGE, 6379, {})
    try:
        url = f"redis://127.0.0.1:{_host_port(container, 6379)}/0"
        _wait(lambda: redis.Redis.from_url(url).ping(), "redis")
        yield url
    finally:
        subprocess.run(["docker", "stop", "-t", "1", container], capture_output=True, check=False)
