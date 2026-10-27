"""DWG -> DXF through LibreDWG WASM, run as a Node subprocess (`converter/dwg2dxf.mjs`)."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from cad_worker.application.ports import ConversionResult, ImportFailure

DEFAULT_TIMEOUT_S = 300
DEFAULT_MAX_OLD_SPACE_MB = 2048
_LOG_LIMIT = 20_000


def default_script() -> Path:
    """`/app/converter` in the image, `workers/cad/converter` in a source checkout."""
    candidates = [Path("/app/converter"), Path(__file__).resolve().parents[2] / "converter"]
    for directory in candidates:
        if (directory / "dwg2dxf.mjs").is_file():
            return directory / "dwg2dxf.mjs"
    return candidates[-1] / "dwg2dxf.mjs"


class LibreDwgWasmConverter:
    def __init__(
        self,
        script: Path | None = None,
        node: str = "node",
        timeout_s: int = DEFAULT_TIMEOUT_S,
        max_old_space_mb: int = DEFAULT_MAX_OLD_SPACE_MB,
    ) -> None:
        self._script = script or default_script()
        self._node = node
        self._timeout_s = timeout_s
        self._max_old_space_mb = max_old_space_mb

    def version(self) -> str | None:
        manifest = self._script.parent / "node_modules/@mlightcad/libredwg-web/package.json"
        try:
            return str(json.loads(manifest.read_text("utf-8"))["version"])
        except (OSError, ValueError, KeyError):
            return None

    def convert(self, dwg_path: Path, out_dir: Path) -> ConversionResult:
        out = out_dir / "converted.dxf"
        version = self.version()
        header = f"converter: libredwg-web {version or 'unknown'} (wasm)"
        cmd = [
            self._node,
            f"--max-old-space-size={self._max_old_space_mb}",
            str(self._script),
            str(dwg_path),
            str(out),
        ]
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                errors="replace",
                timeout=self._timeout_s,
                cwd=self._script.parent,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise ImportFailure(
                "TIMEOUT", f"DWG conversion exceeded {self._timeout_s} s", header
            ) from exc
        except OSError as exc:
            raise ImportFailure(
                "CONVERTER_FAILED", f"cannot run {self._node}: {exc}", header
            ) from exc
        log = "\n".join(
            part for part in (header, proc.stdout.strip(), proc.stderr.strip()) if part
        )[:_LOG_LIMIT]
        if proc.returncode != 0:
            raise ImportFailure(
                "CONVERTER_FAILED", f"converter exited with code {proc.returncode}", log
            )
        if not out.is_file() or out.stat().st_size == 0:
            raise ImportFailure("CONVERTER_FAILED", "converter produced no output", log)
        return ConversionResult(out, "libredwg", version, log)
