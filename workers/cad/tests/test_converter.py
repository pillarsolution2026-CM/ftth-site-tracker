from __future__ import annotations

import shutil
import stat
import subprocess
from pathlib import Path

import pytest

from cad_worker.adapters.libredwg_converter import LibreDwgWasmConverter
from cad_worker.application.ports import ImportFailure

CONVERTER_DIR = Path(__file__).resolve().parents[1] / "converter"


def fake_node(tmp_path: Path, body: str) -> str:
    """A stand-in for `node`: argv = flags, script, input, output."""
    exe = tmp_path / "fake-node"
    exe.write_text(f"#!/bin/sh\nIN=$3\nOUT=$4\n{body}\n")
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    return str(exe)


def converter(node: str, timeout_s: int = 10) -> LibreDwgWasmConverter:
    return LibreDwgWasmConverter(CONVERTER_DIR / "dwg2dxf.mjs", node=node, timeout_s=timeout_s)


@pytest.fixture
def dwg(tmp_path: Path) -> Path:
    path = tmp_path / "in.dwg"
    path.write_bytes(b"AC1032 fake")
    return path


def test_success_captures_log_and_returns_output(tmp_path: Path, dwg: Path) -> None:
    node = fake_node(
        tmp_path, 'echo "read warning: error code 4" >&2; echo ok > "$OUT"; echo wrote'
    )
    result = converter(node).convert(dwg, tmp_path)
    assert result.dxf_path.read_text().strip() == "ok" and result.converter == "libredwg"
    assert "wrote" in result.log and "error code 4" in result.log
    assert "libredwg-web" in result.log


def test_nonzero_exit_is_converter_failed_with_log(tmp_path: Path, dwg: Path) -> None:
    node = fake_node(tmp_path, 'echo "boom" >&2; exit 4')
    with pytest.raises(ImportFailure) as exc:
        converter(node).convert(dwg, tmp_path)
    assert exc.value.code == "CONVERTER_FAILED" and "boom" in exc.value.log


def test_exit_zero_without_output_is_converter_failed(tmp_path: Path, dwg: Path) -> None:
    with pytest.raises(ImportFailure) as exc:
        converter(fake_node(tmp_path, "exit 0")).convert(dwg, tmp_path)
    assert exc.value.code == "CONVERTER_FAILED"


def test_timeout(tmp_path: Path, dwg: Path) -> None:
    with pytest.raises(ImportFailure) as exc:
        converter(fake_node(tmp_path, "sleep 5"), timeout_s=1).convert(dwg, tmp_path)
    assert exc.value.code == "TIMEOUT"


def test_missing_node_binary(tmp_path: Path, dwg: Path) -> None:
    with pytest.raises(ImportFailure) as exc:
        converter("/nonexistent/node").convert(dwg, tmp_path)
    assert exc.value.code == "CONVERTER_FAILED"


def test_node_flags_are_passed(tmp_path: Path, dwg: Path) -> None:
    node = fake_node(tmp_path, 'echo "$@" > "$OUT.args"; echo x > "$OUT"')
    LibreDwgWasmConverter(CONVERTER_DIR / "dwg2dxf.mjs", node=node, max_old_space_mb=512).convert(
        dwg, tmp_path
    )
    assert "--max-old-space-size=512" in (tmp_path / "converted.dxf.args").read_text()


needs_node = pytest.mark.skipif(
    shutil.which("node") is None or not (CONVERTER_DIR / "node_modules").is_dir(),
    reason="node or converter/node_modules (npm ci) not available",
)


@needs_node
def test_real_script_exit_codes(tmp_path: Path) -> None:
    script = str(CONVERTER_DIR / "dwg2dxf.mjs")
    usage = subprocess.run(["node", script], capture_output=True, check=False)
    missing = subprocess.run(
        ["node", script, str(tmp_path / "none.dwg"), str(tmp_path / "o.dxf")],
        capture_output=True,
        check=False,
    )
    garbage = tmp_path / "garbage.dwg"
    garbage.write_bytes(b"not a dwg at all" * 100)
    bad = subprocess.run(
        ["node", script, str(garbage), str(tmp_path / "o.dxf")], capture_output=True, check=False
    )
    assert (usage.returncode, missing.returncode) == (2, 3)
    assert bad.returncode == 4 and not (tmp_path / "o.dxf").exists()


@needs_node
def test_real_converter_rejects_garbage_with_converter_failed(tmp_path: Path) -> None:
    garbage = tmp_path / "garbage.dwg"
    garbage.write_bytes(b"not a dwg at all" * 100)
    with pytest.raises(ImportFailure) as exc:
        LibreDwgWasmConverter(CONVERTER_DIR / "dwg2dxf.mjs").convert(garbage, tmp_path)
    assert exc.value.code == "CONVERTER_FAILED" and "0.8.2" in exc.value.log
