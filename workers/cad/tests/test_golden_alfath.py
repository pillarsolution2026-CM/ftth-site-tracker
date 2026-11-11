"""ADR-041 golden run on the Al-Fath (Rabaa) General and Secondary (git-ignored; skipped when absent).

DB-free: the worker's own reader (EzdxfReader) gives the drawing rows, `compose_design` builds them
with the mappings `tests/golden/alfath_*_mapping.json` (layer names of this drawing). The owner's
facts (ADR-040/041) are asserted one by one below; every other count (Phase-1 problems, totals)
is pinned in the mapping file's `expected` — regenerate after an intended change with
`UPDATE_GOLDEN=1 uv run pytest tests/test_golden_alfath.py`.
"""

from __future__ import annotations

import json
import os
import uuid
from collections import Counter
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from cad_worker.adapters.ezdxf_reader import EzdxfReader
from cad_worker.application.build_revision import DesignBuild, compose_design
from cad_worker.domain.corrections import apply_corrections, parse_corrections
from cad_worker.domain.design import FEATURE_TYPES
from cad_worker.domain.design_build import (
    DrawingData,
    SourceAttribute,
    SourceCurve,
    SourceInsert,
    SourceText,
    build_features,
    parse_rules,
)
from cad_worker.domain.model import CurveRow, InsertRow, TextRow
from cad_worker.domain.placement import unit_placer
from cad_worker.domain.role_reading import read_drawing
from cad_worker.domain.text_roles import DrawingKind, cabinet_name_key
from tests.support.env import fixtures_dir

GOLDEN_DIR = Path(__file__).parent / "golden"
SECONDARY = GOLDEN_DIR / "alfath_secondary_mapping.json"
GENERAL = GOLDEN_DIR / "alfath_general_mapping.json"
# Owner-verified (ADR-040): boxes drawn under each cabinet = its written «nB».
BOXES_PER_CABINET = {
    "1-1": 24,
    "1-2": 24,
    "1-3": 27,
    "1-4": 13,
    "1-5": 28,
    "1-6": 36,
    "1-7": 22,
    "1-8": 23,
}


def _load(path: Path) -> dict[str, Any]:
    data: dict[str, Any] = json.loads(path.read_text("utf-8"))
    return data


def _drawing(name: str) -> DrawingData:
    path = fixtures_dir() / name
    if not path.is_file():
        pytest.skip(f"real drawing {name} not found in {fixtures_dir()}")
    curves: list[SourceCurve] = []
    inserts: list[SourceInsert] = []
    texts: list[SourceText] = []
    for row in EzdxfReader().open(path).features():
        if isinstance(row, InsertRow):
            c = row.centre if row.centre is not None else row.position
            attributes = tuple(
                SourceAttribute(a.tag, a.raw_value, a.value, a.readable) for a in row.attributes
            )
            inserts.append(
                SourceInsert(row.handle, row.layer, row.block_name, (c[0], c[1]), attributes)
            )
        elif isinstance(row, TextRow):
            texts.append(
                SourceText(
                    row.handle,
                    row.layer,
                    (row.position[0], row.position[1]),
                    row.height,
                    row.raw_text,
                    row.text,
                    row.readable,
                )
            )
        elif isinstance(row, CurveRow):
            curves.append(
                SourceCurve(
                    row.handle,
                    row.layer,
                    tuple((p[0], p[1]) for p in row.points),
                    row.is_closed,
                    row.entity_type,
                )
            )
    return DrawingData(tuple(curves), tuple(inserts), tuple(texts))


@pytest.fixture(scope="module")
def drawings() -> dict[str, DrawingData]:
    return {
        "secondary": _drawing(_load(SECONDARY)["file"]),
        "general": _drawing(_load(GENERAL)["file"]),
    }


def _prepare(
    drawing: DrawingData,
    rules_raw: list[dict[str, object]],
    corrections: list[dict[str, object]] | None,
) -> tuple[DrawingData, Any]:
    """What the build does before composing: curves of the rule layers, corrections applied."""
    rules = parse_rules(rules_raw)
    layers = rules.curve_layers()
    loaded = DrawingData(
        tuple(c for c in drawing.curves if c.layer in layers), drawing.inserts, drawing.texts
    )
    if corrections:
        loaded = apply_corrections(
            loaded,
            parse_corrections(corrections),
            metres_per_unit=1.0,
            move_targets=rules.layers_with(*FEATURE_TYPES, "label"),
        )
    return loaded, rules


def _build(
    drawing: DrawingData,
    kind: DrawingKind,
    rules_raw: list[dict[str, object]],
    corrections: list[dict[str, object]] | None = None,
) -> DesignBuild:
    loaded, rules = _prepare(drawing, rules_raw, corrections)
    return compose_design(loaded, rules, unit_placer(1.0), (), uuid.uuid4, kind)


def _problems(build: DesignBuild) -> dict[str, list[dict[str, Any]]]:
    return {str(p["code"]): list(p["items"]) for p in build.problems}  # type: ignore[call-overload]


def _readings(build: DesignBuild, feature_type: str) -> list[Mapping[str, Any]]:
    return [
        f.attrs["reading"]  # type: ignore[misc]
        for f in build.rows.features
        if f.feature_type == feature_type and "reading" in f.attrs
    ]


def _summary(build: DesignBuild) -> dict[str, Any]:
    return {
        "features": {k: v for k, v in build.feature_counts.items() if v},
        "problems": {str(p["code"]): p["count"] for p in build.problems},
        "reading": build.reading_totals,
        "log": build.reading_log,
    }


def _pin(path: Path, variant: str, actual: dict[str, Any]) -> None:
    mapping = _load(path)
    if os.environ.get("UPDATE_GOLDEN"):
        expected = mapping.get("expected") or {}
        expected[variant] = actual
        mapping["expected"] = expected
        body = json.dumps(mapping, ensure_ascii=False, indent=2) + "\n"
        path.write_text(body, "utf-8", newline="\n")
        return
    expected = (mapping.get("expected") or {}).get(variant)
    if expected is None:
        print(f"GOLDEN ALFATH {variant}: {json.dumps(actual, ensure_ascii=False)} (not pinned)")
        return
    assert actual == expected


def test_secondary_owner_facts(drawings: dict[str, DrawingData]) -> None:
    mapping = _load(SECONDARY)
    build = _build(drawings["secondary"], "secondary", mapping["rules"])
    problems = _problems(build)
    boxes = [f for f in build.rows.features if f.feature_type == "box"]
    assert len(boxes) == 197
    assert all(f.code for f in boxes), "every box is named cabinet/number"
    cabinets = {c["name"]: c for c in _readings(build, "cabinet")}
    assert {n: c["boxesDrawn"] for n, c in cabinets.items()} == BOXES_PER_CABINET
    assert {n: c["boxCount"] for n, c in cabinets.items()} == BOXES_PER_CABINET
    assert "CABINET_BOX_COUNT_MISMATCH" not in problems
    mismatches = Counter(
        (i["params"]["found"], i["params"]["expected"]) for i in problems["LABEL_TYPE_MISMATCH"]
    )
    assert mismatches == {("7", "12"): 9, ("12", "24"): 3, ("4", "7"): 1}
    assert "BOX_NOT_REACHED" not in problems
    totals = build.reading_totals
    assert totals is not None
    assert sum(c["count"] for c in totals["connectors"]) == 187  # type: ignore[attr-defined]
    spares = Counter(s["count"] for r in _readings(build, "route") for s in r["spares"])
    assert spares == {2: 7, 3: 7, 4: 3, 5: 6, 6: 7, 7: 3, 10: 1, 12: 2, 13: 1}
    assert totals["spares"] == [{"ductSize": "7/3.5", "singles": 187, "endCaps": 374}]
    # Recorded on the first run (ADR-041): no duplicate box numbers, every cabinet in a zone.
    assert "BOX_NUMBER_DUPLICATE" not in problems
    assert "CABINET_ZONE_MISSING" not in problems
    assert build.rows.text_links == ()  # every text layer of this mapping has roles
    _pin(SECONDARY, "as_drawn", _summary(build))


def test_general_as_drawn(drawings: dict[str, DrawingData]) -> None:
    mapping = _load(GENERAL)
    build = _build(drawings["general"], "general", mapping["rules"])
    problems = _problems(build)
    assert Counter(r["type"] for r in _readings(build, "hhi")) == {"DH": 4, "HH-I": 3}
    assert not {"HANDHOLE_TYPE_MISSING", "HANDHOLE_TYPE_UNKNOWN"} & set(problems)
    assert [i["text"] for i in problems["HANDHOLE_NOT_DRAWN"]] == ["CH01"]
    missing = problems["LABEL_MISSING"]
    assert len(missing) == 8
    assert {i["layer"] for i in missing} == {"Sap"}
    assert all(i["params"] == {"role": "cabinet_info", "field": "name"} for i in missing)
    # The four «Joint 144» texts on layer jont 36: three are paired with a JONT 36 symbol (type
    # mismatch); the fourth is nearest the joint drawn on layer jont 144 at 04A, so Phase 1 says
    # WRONG_LAYER for it (right text, wrong layer).
    joints = [i["text"] for i in problems["LABEL_TYPE_MISMATCH"]]
    assert joints == ["Joint 144"] * 3
    assert [i["text"] for i in problems["WRONG_LAYER"]] == ["Joint 144"]
    # «450m/1x4 way 16/12» is not a bundle label for the shared reading ("1x4 way" is not read):
    # its pair with «670M/144Core» is not checked until the PM corrects the text.
    assert not {"CABLE_SLACK_TOO_LONG", "CABLE_SLACK_TOO_SHORT"} & set(problems)
    assert "SPARE_CORES_MISMATCH" not in problems  # «SP 48» sits on the joint layer: not read
    _pin(GENERAL, "as_drawn", _summary(build))


def test_general_corrected_by_the_pm(drawings: dict[str, DrawingData]) -> None:
    mapping = _load(GENERAL)
    loaded, rules = _prepare(drawings["general"], mapping["rules"], mapping["corrections"])
    place = unit_placer(1.0)
    built = build_features(loaded, rules, place)
    reading = read_drawing(
        built.features,
        loaded.texts,
        loaded.curves,
        rules,
        place,
        "general",
        built.text_feature_handles,
    )
    pairs = sorted(
        (int(float(p.bundle.reading.length_m or 0)), int(float(p.cable.reading.length_m or 0)))
        for p in reading.cable_pairs
    )
    assert pairs == sorted(
        [
            (400, 420),
            (720, 750),
            (170, 200),
            (150, 170),
            (650, 670),
            (20, 50),
            (300, 320),
            (290, 310),
            (500, 520),
            (500, 520),
            (500, 520),
            (270, 290),
            (450, 670),
        ]
    )
    build = compose_design(loaded, rules, place, (), uuid.uuid4, "general")
    problems = _problems(build)
    assert [(i["text"], i["params"]["slackM"]) for i in problems["CABLE_SLACK_TOO_LONG"]] == [
        ("670M/144Core F.O(el fath)", "220.000")
    ]
    assert "CABLE_SLACK_TOO_SHORT" not in problems
    # SP 48 = 144 - 8 x 12 (read once moved onto EXCH).
    spare_routes = [r for r in _readings(build, "route") if r["spareCores"] is not None]
    assert [(r["spareCores"], r["cableCores"]) for r in spare_routes] == [(48, 144)]
    assert "SPARE_CORES_MISMATCH" not in problems
    _pin(GENERAL, "corrected", _summary(build))


def test_cabinets_of_both_drawings_match_once_the_general_names_them(
    drawings: dict[str, DrawingData],
) -> None:
    general = _load(GENERAL)
    named = _build(
        drawings["general"],
        "general",
        [*general["rules"], general["namedCabinetsRule"]],
        general["corrections"],
    )
    secondary = _build(drawings["secondary"], "secondary", _load(SECONDARY)["rules"])

    def sub_cabinets(build: DesignBuild) -> dict[str, int]:
        return {
            cabinet_name_key(f.code): f.attrs["reading"]["boxCount"]  # type: ignore[index]
            for f in build.rows.features
            if f.feature_type == "cabinet" and f.attrs.get("role") == "sub" and f.code
        }

    assert sub_cabinets(named) == sub_cabinets(secondary) == BOXES_PER_CABINET
    assert "LABEL_MISSING" not in _problems(named)
    _pin(GENERAL, "named_cabinets", _summary(named))
