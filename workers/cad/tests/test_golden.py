"""Golden tests on the client's real drawings (git-ignored; skipped when absent).

Only counts are committed (`tests/golden/*.json`). Regenerate after an intended change with
`UPDATE_GOLDEN=1 uv run pytest tests/test_golden.py`.
"""

from __future__ import annotations

import json
import os
import resource
import shutil
import time
from pathlib import Path
from typing import Any

import psycopg
import pytest

from cad_worker.adapters.ezdxf_reader import EzdxfReader
from cad_worker.adapters.libredwg_converter import LibreDwgWasmConverter
from cad_worker.adapters.postgres_repo import PostgresCadRepository
from cad_worker.adapters.storage import FsStorage
from cad_worker.application.import_job import ImportDeps, run_import
from tests.support.env import fixtures_dir
from tests.support.fakes import make_job
from tests.support.golden import summarize

GOLDEN_DIR = Path(__file__).parent / "golden"
GOLDEN_FILES = sorted(GOLDEN_DIR.glob("*.json"))
LENGTH_TOLERANCE = 0.011  # golden values are rounded to 0.01
MAX_SECONDS_4500_ENTITIES = 60


def _load(path: Path) -> dict[str, Any]:
    data: dict[str, Any] = json.loads(path.read_text("utf-8"))
    return data


def _node_ready() -> bool:
    converter_dir = Path(__file__).resolve().parents[1] / "converter"
    return shutil.which("node") is not None and (converter_dir / "node_modules").is_dir()


@pytest.fixture(scope="module")
def processed_drawings(
    database_url: str, tmp_path_factory: pytest.TempPathFactory
) -> dict[str, dict[str, Any]]:
    """Runs each available drawing once through the real pipeline; maps file name -> result."""
    out: dict[str, dict[str, Any]] = {}
    root = tmp_path_factory.mktemp("storage")
    deps = ImportDeps(
        repo=PostgresCadRepository(database_url),
        storage=FsStorage(root),
        converter=LibreDwgWasmConverter(),
        reader=EzdxfReader(),
    )
    import uuid

    with psycopg.connect(database_url, autocommit=True) as db:
        project_id = uuid.uuid4()
        db.execute(
            "INSERT INTO projects (id, name, client, crs_epsg, currency) "
            "VALUES (%s, 'golden', 'c', 32636, 'EGP')",
            (project_id,),
        )
        for golden_path in GOLDEN_FILES:
            name = _load(golden_path)["file"]
            drawing = fixtures_dir() / name
            if not drawing.is_file():
                continue
            file_id, job_id = uuid.uuid4(), uuid.uuid4()
            key = f"projects/{project_id}/cad/{file_id}/original.dwg"
            (root / key).parent.mkdir(parents=True)
            shutil.copyfile(drawing, root / key)
            db.execute(
                "INSERT INTO cad_files (id, project_id, original_name, format, size_bytes, sha256, "
                "storage_key, status, current_job_id, queued_at) "
                "VALUES (%s, %s, %s, 'dwg', %s, %s, %s, 'queued', %s, now())",
                (file_id, project_id, name, drawing.stat().st_size, "b" * 64, key, job_id),
            )
            started = time.monotonic()
            outcome = run_import(make_job(project_id, file_id, job_id, key, "dwg"), deps, "golden")
            elapsed = time.monotonic() - started
            out[name] = {
                "outcome": outcome,
                "seconds": elapsed,
                "summary": summarize(db, file_id),
            }
            children_mb = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss // 1024
            self_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024
            print(
                f"GOLDEN {name}: {outcome} in {elapsed:.1f}s, python peak {self_mb} MB, "
                f"node peak {children_mb} MB, totals {out[name]['summary']['totals']}"
            )
    return out


@pytest.mark.skipif(not _node_ready(), reason="node or converter/node_modules (npm ci) missing")
@pytest.mark.parametrize("golden_path", GOLDEN_FILES, ids=lambda p: p.stem)
def test_matches_golden(golden_path: Path, processed_drawings: dict[str, dict[str, Any]]) -> None:
    golden = _load(golden_path)
    result = processed_drawings.get(golden["file"])
    if result is None:
        pytest.skip(f"real drawing {golden['file']} not found in {fixtures_dir()}")
    assert result["outcome"] == "processed"
    actual = result["summary"]
    if os.environ.get("UPDATE_GOLDEN"):
        golden.update(actual)
        golden_path.write_text(json.dumps(golden, ensure_ascii=False, indent=2) + "\n", "utf-8")
        return
    expected = {k: golden[k] for k in actual}
    assert actual["totals"] == expected["totals"]
    assert actual["unreadable_texts"] == expected["unreadable_texts"]
    assert actual["entity_counts_by_layer"] == expected["entity_counts_by_layer"]
    assert actual["inserts_by_block"] == expected["inserts_by_block"]
    lengths, wanted = actual["curve_length_by_layer"], expected["curve_length_by_layer"]
    assert lengths.keys() == wanted.keys()
    for layer, value in wanted.items():
        assert lengths[layer] == pytest.approx(value, abs=LENGTH_TOLERANCE), layer


@pytest.mark.skipif(not _node_ready(), reason="node or converter/node_modules (npm ci) missing")
def test_qalyub_sector_1_known_facts(processed_drawings: dict[str, dict[str, Any]]) -> None:
    name = "General_القطاع_الاول_قليوب.dwg"
    result = processed_drawings.get(name)
    if result is None:
        pytest.skip(f"real drawing {name} not found in {fixtures_dir()}")
    summary = result["summary"]
    assert summary["inserts_by_block"]["sub"] == 17
    assert summary["inserts_by_block"]["JONT 144"] == 4
    assert summary["entity_counts_by_layer"]["N_DUC_CBL"]["LWPOLYLINE"] == 28
    assert result["seconds"] < MAX_SECONDS_4500_ENTITIES  # ~4,500 entities, DWG included
