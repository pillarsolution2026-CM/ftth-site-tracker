"""Golden tests on the client's real drawings (git-ignored; skipped when absent).

Only counts are committed (`tests/golden/*.json`). Regenerate after an intended change with
`UPDATE_GOLDEN=1 uv run pytest tests/test_golden.py` (or `scripts/golden.sh`). A golden value
that is `null` is not compared yet: the test prints the actual value instead.

Phase 1b: Qalyub sector 1 is also built into a design revision with
`tests/golden/qalyub_sector1_mapping.json` (its drawing unit is a test parameter, see the file).
"""

from __future__ import annotations

import json
import os
import resource
import shutil
import time
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import psycopg
import pytest

from cad_worker.adapters.ezdxf_reader import EzdxfReader
from cad_worker.adapters.job_message import CadBuildRevisionJob
from cad_worker.adapters.libredwg_converter import LibreDwgWasmConverter
from cad_worker.adapters.postgres_repo import PostgresCadRepository
from cad_worker.adapters.postgres_revision_repo import PostgresRevisionRepository
from cad_worker.adapters.storage import FsStorage
from cad_worker.application.build_revision import BuildDeps, run_build
from cad_worker.application.import_job import ImportDeps, run_import
from tests.support.env import fixtures_dir
from tests.support.fakes import make_job
from tests.support.golden import summarize

GOLDEN_DIR = Path(__file__).parent / "golden"
MAPPING_SUFFIX = "_mapping.json"
GOLDEN_FILES = sorted(p for p in GOLDEN_DIR.glob("*.json") if not p.name.endswith(MAPPING_SUFFIX))
SECTOR_1_MAPPING = GOLDEN_DIR / f"qalyub_sector1{MAPPING_SUFFIX}"
MAX_BUILD_SECONDS = 60
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
                "project_id": project_id,
                "cad_file_id": file_id,
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
    if expected["unreadable_texts"] is None:
        # Stale since the SHX table (ADR-019): regenerate with the drawings (UPDATE_GOLDEN=1).
        print(
            f"GOLDEN {golden['file']}: unreadable_texts = {actual['unreadable_texts']} (not pinned)"
        )
    else:
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


def _build_sector_1(
    db: psycopg.Connection[Any],
    database_url: str,
    result: dict[str, Any],
    mapping: dict[str, Any],
    storage: Path,
) -> tuple[uuid.UUID, str, float]:
    revision_id, job_id = uuid.uuid4(), uuid.uuid4()
    db.execute(
        "INSERT INTO design_revisions (id, project_id, cad_file_id, status, current_job_id, rules, "
        "mapping_version, crs_epsg, drawing_unit, metres_per_unit, ins_units, units_conflict) "
        "SELECT %s, f.project_id, f.id, 'queued', %s, %s, 1, %s, %s, %s, f.ins_units, "
        "COALESCE((f.crs_detection->>'unitsConflict')::boolean, false) FROM cad_files f "
        "WHERE f.id = %s",
        (
            revision_id,
            job_id,
            json.dumps(mapping["rules"]),
            mapping["crsEpsg"],
            mapping["drawingUnit"],
            Decimal(mapping["metresPerUnit"]),
            result["cad_file_id"],
        ),
    )
    job = CadBuildRevisionJob(
        id=job_id,
        type="cad.build_revision",
        revisionId=revision_id,
        projectId=result["project_id"],
        cadFileId=result["cad_file_id"],
        attempt=1,
        enqueuedAt=datetime.now(UTC),
    )
    deps = BuildDeps(PostgresRevisionRepository(database_url), FsStorage(storage))
    started = time.monotonic()
    outcome = run_build(job, deps, "golden")
    return revision_id, outcome, time.monotonic() - started


@pytest.mark.skipif(not _node_ready(), reason="node or converter/node_modules (npm ci) missing")
def test_qalyub_sector_1_design_revision(
    processed_drawings: dict[str, dict[str, Any]],
    database_url: str,
    tmp_path: Path,
) -> None:
    mapping = _load(SECTOR_1_MAPPING)
    result = processed_drawings.get(mapping["file"])
    if result is None:
        pytest.skip(f"real drawing {mapping['file']} not found in {fixtures_dir()}")
    with psycopg.connect(database_url, autocommit=True) as db:
        revision_id, outcome, seconds = _build_sector_1(db, database_url, result, mapping, tmp_path)
        row = db.execute(
            "SELECT r.status, r.error_code, r.error_message, r.counts, r.text_link_counts, "
            "r.tiles_storage_key, f.crs_detection FROM design_revisions r "
            "JOIN cad_files f ON f.id = r.cad_file_id WHERE r.id = %s",
            (revision_id,),
        ).fetchone()
    assert row is not None
    status, error_code, error_message, counts, link_counts, tiles_key, crs = row
    assert (outcome, status) == ("built", "draft"), (error_code, error_message)
    features, route_m = counts["features"], counts["routeLengthM"]
    print(
        f"GOLDEN REVISION {mapping['file']}: routes={features['route']} route_m={route_m} "
        f"boxes={features['box']} hhi={features['hhi']} joints={features['joint']} "
        f"mh={features['mh']} links={link_counts} suggestedEpsg={crs['suggestedEpsg']} "
        f"unitsConflict={crs['unitsConflict']} import={result['seconds']:.1f}s "
        f"build={seconds:.1f}s total={result['seconds'] + seconds:.1f}s tiles={tiles_key}"
    )
    expected = mapping["expected"]
    if os.environ.get("UPDATE_GOLDEN"):
        expected.update(routes=features["route"], routeLengthM=route_m)
        SECTOR_1_MAPPING.write_text(
            json.dumps(mapping, ensure_ascii=False, indent=2) + "\n", "utf-8"
        )
    assert features["box"] == expected["boxes"] == 17
    assert features["joint"] == expected["joints"] == 4
    assert features["hhi"] == expected["hhi"] == 6
    assert crs["suggestedEpsg"] == expected["suggestedEpsg"] == 32636
    assert tiles_key is not None
    if expected["routes"] is not None:
        assert features["route"] == expected["routes"]
    if expected["routeLengthM"] is not None:
        assert Decimal(route_m) == pytest.approx(
            Decimal(expected["routeLengthM"]), abs=Decimal("0.01")
        )
    assert seconds < MAX_BUILD_SECONDS
