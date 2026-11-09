"""Drawing view render in a child process (security review M1, ADR-039).

A crafted DXF must not hang or exhaust the shared worker: `SubprocessViewRenderer` runs
`python -m cad_worker.adapters.view_process <request.json>` with a wall-clock timeout (killed ->
`TIMEOUT`) and the child limits its own address space with RLIMIT_AS before it imports ezdxf
(Linux; a no-op where `resource` is missing, e.g. Windows) -> `MemoryError` -> `TOO_LARGE`.
Setting the limit in the child (not with `preexec_fn`) is safe with the worker's heartbeat thread.

The child writes the gzip view and a small result JSON; the view never crosses the process
boundary.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, get_args

from cad_worker.application.ports import RenderOutput, ViewFailure, ViewFailureCode
from cad_worker.domain.drawing_view import (
    DRAWING_VIEW_MAX_JSON_BYTES,
    DRAWING_VIEW_MAX_PARTS,
    DRAWING_VIEW_MAX_TEXTS,
    DRAWING_VIEW_MAX_VERTICES,
)
from cad_worker.domain.extents import Extents

DEFAULT_TIMEOUT_S = 300.0
DEFAULT_MAX_MEMORY_MB = 3072
_STDERR_LIMIT = 2000
_CODES: frozenset[str] = frozenset(get_args(ViewFailureCode))


class SubprocessViewRenderer:
    def __init__(
        self,
        *,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        max_memory_mb: int = DEFAULT_MAX_MEMORY_MB,
        python: str = sys.executable,
        max_vertices: int = DRAWING_VIEW_MAX_VERTICES,
        max_texts: int = DRAWING_VIEW_MAX_TEXTS,
        max_parts: int = DRAWING_VIEW_MAX_PARTS,
        max_json_bytes: int = DRAWING_VIEW_MAX_JSON_BYTES,
    ) -> None:
        self._timeout_s = timeout_s
        self._max_memory_mb = max_memory_mb
        self._python = python
        self._caps = {
            "maxVertices": max_vertices,
            "maxTexts": max_texts,
            "maxParts": max_parts,
            "maxJsonBytes": max_json_bytes,
        }

    def render_to(
        self, dxf: Path, out: Path, cad_file_id: str, extents: Extents | None
    ) -> RenderOutput:
        request_path = out.with_name(out.name + ".request.json")
        result_path = out.with_name(out.name + ".result.json")
        request = {
            "dxf": str(dxf),
            "out": str(out),
            "result": str(result_path),
            "cadFileId": cad_file_id,
            "extents": None
            if extents is None
            else [extents.min_x, extents.min_y, extents.max_x, extents.max_y],
            "maxMemoryMb": self._max_memory_mb,
            **self._caps,
        }
        request_path.write_text(json.dumps(request), "utf-8")
        env = {**os.environ, "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1"}
        cmd = [self._python, "-m", "cad_worker.adapters.view_process", str(request_path)]
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                errors="replace",
                timeout=self._timeout_s,
                env=env,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:  # the child is killed by subprocess.run
            out.unlink(missing_ok=True)
            raise ViewFailure("TIMEOUT", f"render exceeded {self._timeout_s} s") from exc
        except OSError as exc:
            raise ViewFailure("INTERNAL", f"cannot run {self._python}: {exc}") from exc
        stderr = proc.stderr.strip()[-_STDERR_LIMIT:]
        result = _read_result(result_path)
        if result is None:
            out.unlink(missing_ok=True)
            if "MemoryError" in stderr:
                raise ViewFailure("TOO_LARGE", "render exceeded the memory limit")
            raise ViewFailure("INTERNAL", f"render exited with code {proc.returncode}: {stderr}")
        if not result.get("ok"):
            out.unlink(missing_ok=True)
            code = str(result.get("code"))
            raise ViewFailure(
                code if code in _CODES else "INTERNAL",  # type: ignore[arg-type]
                str(result.get("message", ""))[:_STDERR_LIMIT],
            )
        stats = result.get("stats")
        return RenderOutput(
            size_bytes=int(result["sizeBytes"]),
            json_bytes=int(result["jsonBytes"]),
            stats=dict(stats) if isinstance(stats, dict) else {},
        )


def _read_result(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def limit_memory(max_memory_mb: int) -> None:
    """RLIMIT_AS for this process (Linux); nothing where `resource` is unavailable."""
    try:
        import resource
    except ImportError:  # pragma: no cover - Windows
        return
    limit = max_memory_mb * 1024 * 1024
    resource.setrlimit(resource.RLIMIT_AS, (limit, limit))


def child_main(request_path: str) -> int:
    request = json.loads(Path(request_path).read_text("utf-8"))
    limit_memory(int(request["maxMemoryMb"]))
    result: dict[str, Any]
    try:
        from cad_worker.adapters.ezdxf_view import EzdxfViewRenderer

        ext = request["extents"]
        output = EzdxfViewRenderer(
            max_vertices=int(request["maxVertices"]),
            max_texts=int(request["maxTexts"]),
            max_parts=int(request["maxParts"]),
            max_json_bytes=int(request["maxJsonBytes"]),
        ).render_to(
            Path(request["dxf"]),
            Path(request["out"]),
            str(request["cadFileId"]),
            None if ext is None else Extents(*(float(v) for v in ext)),
        )
        result = {
            "ok": True,
            "sizeBytes": output.size_bytes,
            "jsonBytes": output.json_bytes,
            "stats": output.stats,
        }
    except ViewFailure as failure:
        result = {"ok": False, "code": failure.code, "message": failure.message}
    except MemoryError:
        result = {"ok": False, "code": "TOO_LARGE", "message": "render exceeded the memory limit"}
    Path(request["result"]).write_text(json.dumps(result), "utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(child_main(sys.argv[1]))
