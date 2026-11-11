"""Security review (ADR-041): the roles reading stays bounded on hostile drawings.

Huge text heights cannot widen a text's reach past `ROLE_LINK_MAX_RADIUS_M`, a text weighs at most
`ROLE_LINK_MAX_CANDIDATES` features, and big or stacked scenes are read in a few seconds.
"""

from __future__ import annotations

import time

from cad_worker.domain.design_build import DrawingData, SourceCurve, SourceInsert, SourceText
from cad_worker.domain.kind_checks import check_kind
from cad_worker.domain.role_reading import (
    ROLE_LINK_MAX_CANDIDATES,
    ROLE_LINK_MAX_RADIUS_M,
    role_link_radius_m,
)
from cad_worker.domain.text_links import LINK_MIN_RADIUS_M
from tests.support.reading_scenes import (
    GENERAL_RULES,
    SECONDARY_RULES,
    insert,
    line,
    read,
    rules_of,
    text,
)

BOM = chr(0xFEFF)
# CPU seconds (not wall time: other processes may share the machine). The scenes below take about
# 1-3 s on a developer machine; the all-pairs reading they guard against took minutes.
CPU_BUDGET_S = 10


def test_role_text_is_trimmed_as_javascript_does() -> None:
    """`String.prototype.trim` removes U+FEFF; Python's `str.strip` keeps it."""
    drawing = DrawingData(
        (line("A", "OOOOOO", (0, 0), (100, 0)),),
        (),
        (text("SP", "EXCH", "SP 48" + BOM, (50, 3)),),
    )
    reading, _ = read(drawing, GENERAL_RULES, "general")
    assert [t.text for t in reading.texts] == ["SP 48"]


def test_a_huge_text_height_reaches_no_further_than_the_cap() -> None:
    assert role_link_radius_m(1e12) == ROLE_LINK_MAX_RADIUS_M
    assert role_link_radius_m(float("inf")) == ROLE_LINK_MAX_RADIUS_M
    # Al-Fath General texts are 7.5 m high (150 m): within the cap.
    assert role_link_radius_m(7.5) == 150
    far = ROLE_LINK_MAX_RADIUS_M + 10
    drawing = DrawingData(
        (
            line("NEAR", "OOOOOO", (0, 100), (100, 100)),
            line("FAR", "OOOOOO", (1000, far), (1100, far)),
        ),
        (),
        (
            text("T1", "EXCH", "500M/4way 16/12", (50, 0), height=1e12),
            text("T2", "EXCH", "400M/4way 16/12", (1050, 0), height=1e12),
        ),
    )
    reading, _ = read(drawing, GENERAL_RULES, "general")
    assert {t.radius_m for t in reading.texts} == {ROLE_LINK_MAX_RADIUS_M}
    assert {h: k[1] for h, k in reading.text_feature.items()} == {"T1": "NEAR"}


def test_a_text_height_that_is_not_a_number_reaches_the_minimum() -> None:
    assert role_link_radius_m(float("nan")) == LINK_MIN_RADIUS_M
    drawing = DrawingData(
        (line("A", "OOOOOO", (0, 0.5), (100, 0.5)),),
        (),
        (text("T", "EXCH", "500M/4way 16/12", (50, 0), height=float("nan")),),
    )
    reading, _ = read(drawing, GENERAL_RULES, "general")
    assert reading.text_feature["T"][1] == "A"


def test_a_text_weighs_only_its_nearest_features() -> None:
    """Stacked routes: the text takes the nearest one (ties by handle) among a bounded few."""
    n = ROLE_LINK_MAX_CANDIDATES * 4
    curves = tuple(line(f"R{i:04d}", "OOOOOO", (0, 1 + i % 3), (100, 1 + i % 3)) for i in range(n))
    drawing = DrawingData(curves, (), (text("T", "EXCH", "500M/4way 16/12", (50, 0)),))
    reading, _ = read(drawing, GENERAL_RULES, "general")
    assert reading.text_feature["T"][1] == "R0000"


def _routes(side: int) -> list[SourceCurve]:
    """side² short routes on a 10 m grid."""
    return [
        line(f"R{i}-{j}", "OOOOOO", (10.0 * i, 10.0 * j), (10.0 * i + 8, 10.0 * j))
        for i in range(side)
        for j in range(side)
    ]


def _general_scene(side: int) -> DrawingData:
    """side² routes; every other route has a bundle text and a cable text written together, one
    of five of those an «SP» text."""
    texts: list[SourceText] = []
    for i in range(side):
        for j in range(side):
            x, y, h = 10.0 * i, 10.0 * j, f"{i}-{j}"
            if (i + j) % 2 == 0:
                texts.append(text(f"B{h}", "EXCH", "500M/4way 16/12", (x + 4, y + 1)))
                texts.append(text(f"C{h}", "EXCH", f"520M/{1 + i % 144}Core", (x + 4, y + 2)))
                if (i * side + j) % 10 == 0:
                    texts.append(text(f"S{h}", "EXCH", "SP 48", (x + 4, y - 1)))
    return DrawingData(tuple(_routes(side)), (), tuple(texts))


def _timed_read(drawing: DrawingData) -> tuple[float, int, int]:
    start = time.process_time()
    reading, features = read(drawing, GENERAL_RULES, "general")
    problems = check_kind(features, reading, rules_of(GENERAL_RULES))
    return (
        time.process_time() - start,
        len(reading.cable_pairs),
        len(problems["SPARE_CORES_MISMATCH"]),
    )


def test_a_big_general_is_read_in_a_few_seconds() -> None:
    drawing = _general_scene(142)
    assert len(drawing.curves) > 20_000 and len(drawing.texts) > 20_000
    elapsed, cable_pairs, spare_problems = _timed_read(drawing)
    assert cable_pairs == (142 * 142 + 1) // 2
    assert spare_problems > 0
    assert elapsed < CPU_BUDGET_S, f"{elapsed:.1f} s"


def test_huge_text_heights_over_a_big_general_are_read_in_a_few_seconds() -> None:
    """Every text claims a reach of kilometres; each still weighs only what lies within the cap."""
    texts = tuple(
        text(
            f"H{k}",
            "EXCH",
            "SP 12" if k % 2 else "500M/4way 16/12",
            (7.0 * k % 1420, k % 1420),
            1e9,
        )
        for k in range(2000)
    )
    elapsed, _, _ = _timed_read(DrawingData(tuple(_routes(142)), (), texts))
    assert elapsed < CPU_BUDGET_S, f"{elapsed:.1f} s"


def test_stacked_routes_and_texts_are_read_in_a_few_seconds() -> None:
    routes = tuple(line(f"R{i:05d}", "OOOOOO", (0, 0), (100, 0)) for i in range(20_000))
    texts = tuple(
        text(f"T{i:05d}", "EXCH", "500M/4way 16/12" if i % 2 else "520M/144Core", (50, 1))
        for i in range(20_000)
    )
    elapsed, cable_pairs, _ = _timed_read(DrawingData(routes, (), texts))
    # Stacked bundle texts too: a cable text weighs only the first few of them (by handle).
    assert cable_pairs == ROLE_LINK_MAX_CANDIDATES
    assert elapsed < CPU_BUDGET_S, f"{elapsed:.1f} s"


def test_stacked_zone_curves_and_many_cabinets_are_read_in_a_few_seconds() -> None:
    stacked = tuple(
        line(f"Z{i:04d}", "ZOUN", (-1000, -1000), (1000, -1000), (1000, 1000), (-1000, 1000))
        for i in range(2000)
    )
    # Distinct overlapping zones: 1000 nested squares, none touching another.
    nested = tuple(
        line(
            f"N{i:04d}",
            "ZOUN",
            (-2000 - i, -2000 - i),
            (2000 + i, -2000 - i),
            (2000 + i, 2000 + i),
            (-2000 - i, 2000 + i),
        )
        for i in range(0, 2000, 2)
    )
    cabinets: tuple[SourceInsert, ...] = tuple(
        insert(f"CAB{i}", "sub", (float(i % 100), float(i // 100)), "sub") for i in range(2000)
    )
    drawing = DrawingData((*stacked, *nested), cabinets, ())
    start = time.process_time()
    reading, features = read(drawing, SECONDARY_RULES, "secondary")
    check_kind(features, reading, rules_of(SECONDARY_RULES))
    elapsed = time.process_time() - start
    assert len(reading.zones) == 1 + 1000
    zones = {reading.readings[f.key]["zoneHandle"] for f in features if f.feature_type == "cabinet"}
    assert zones == {"Z0000"}
    assert elapsed < CPU_BUDGET_S, f"{elapsed:.1f} s"
