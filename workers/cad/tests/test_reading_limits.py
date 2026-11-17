"""Security review (ADR-041): the roles reading stays bounded on hostile drawings.

Huge text heights cannot widen a text's reach past `ROLE_LINK_MAX_RADIUS_M`, a text weighs at most
`ROLE_LINK_MAX_CANDIDATES` features, and big or stacked scenes are read in a few seconds.
"""

from __future__ import annotations

import math
import time

from cad_worker.domain.design_build import DrawingData, SourceCurve, SourceInsert, SourceText
from cad_worker.domain.kind_checks import MAX_FOUND_LENGTH, NETWORK_MAX_HITS, check_kind
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


# ---------- cable networks of the spare-cores check (security review of the owner answers) ----


def _star(n: int, centre: tuple[float, float]) -> list[SourceCurve]:
    """n routes leaving one point (that end lies on every one of them)."""
    cx, cy = centre
    return [
        line(
            f"S{i:05d}",
            "OOOOOO",
            centre,
            (cx + 100 * math.cos(2 * math.pi * i / n), cy + 100 * math.sin(2 * math.pi * i / n)),
        )
        for i in range(n)
    ]


def _main_with_spare() -> tuple[list[SourceCurve], list[SourceText]]:
    """A labelled 144-core main (0,0)-(500,0) with «SP 132» and one 12-core branch."""
    curves = [
        line("MAIN", "OOOOOO", (0, 0), (500, 0)),
        line("BRANCH", "OOOOOO", (200, 0), (200, -300)),
    ]
    texts = [
        text("B-MAIN", "EXCH", "500M/4way 16/12", (100, 3)),
        text("C-MAIN", "EXCH", "520M/144Core F.O", (100, 6)),
        text("B-BR", "EXCH", "20M/4way 7/3.5", (203, -150)),
        text("C-BR", "EXCH", "50M/12Core F.O", (206, -147)),
        text("SP", "EXCH", "SP 132", (300, 3)),
    ]
    return curves, texts


def _spare_places(drawing: DrawingData) -> tuple[float, list[dict[str, object]]]:
    start = time.process_time()
    reading, features = read(drawing, GENERAL_RULES, "general")
    problems = check_kind(features, reading, rules_of(GENERAL_RULES))
    elapsed = time.process_time() - start
    places = [{"handle": i.handle, **(i.params or {})} for i in problems["SPARE_CORES_MISMATCH"]]
    return elapsed, places


def test_a_network_too_crowded_to_read_fails_closed() -> None:
    """More than NETWORK_MAX_HITS routes at one route end: the network cannot be trusted, so its SP
    check is a (blocking) SPARE_CORES_MISMATCH with no expected value."""
    curves, texts = _main_with_spare()
    crowd = _star(NETWORK_MAX_HITS + 1, (500, 0))
    _, places = _spare_places(DrawingData((*curves, *crowd), (), tuple(texts)))
    assert places == [{"handle": "SP", "found": "132", "mainCores": 144, "featureHandle": "MAIN"}]
    # The same crowd far from the main does not touch its network: checked normally.
    far = _star(NETWORK_MAX_HITS + 1, (5000, 5000))
    _, places = _spare_places(DrawingData((*curves, *far), (), tuple(texts)))
    assert places == []
    # Up to NETWORK_MAX_HITS the network is read (the star's spokes carry no cable).
    fine = _star(NETWORK_MAX_HITS - 2, (500, 0))
    _, places = _spare_places(DrawingData((*curves, *fine), (), tuple(texts)))
    assert places == []


def test_a_crowded_node_fails_closed() -> None:
    curves, texts = _main_with_spare()
    spokes = [
        line(f"P{i:03d}", "OOOOOO", (503 + i * 0.01, 3), (503 + i * 0.01, 50))
        for i in range(NETWORK_MAX_HITS + 1)
    ]
    drawing = DrawingData((*curves, *spokes), (insert("HX", "HH", (502, 2)),), tuple(texts))
    _, places = _spare_places(drawing)
    assert [(p["handle"], p.get("expected")) for p in places] == [("SP", None)]


def test_a_star_of_20k_routes_is_checked_in_a_few_seconds() -> None:
    curves, texts = _main_with_spare()
    drawing = DrawingData((*curves, *_star(20_000, (500, 0))), (), tuple(texts))
    elapsed, places = _spare_places(drawing)
    assert [(p["handle"], p.get("expected")) for p in places] == [("SP", None)]
    assert elapsed < CPU_BUDGET_S, f"{elapsed:.1f} s"


def test_20k_route_ends_around_stacked_nodes_are_checked_in_a_few_seconds() -> None:
    curves, texts = _main_with_spare()
    around = [
        line(
            f"E{i:05d}",
            "OOOOOO",
            (500 + 3 * math.cos(i), 3 * math.sin(i)),
            (500 + 3.5 * math.cos(i), 3.5 * math.sin(i)),
        )
        for i in range(10_000)
    ]
    nodes = tuple(insert(f"H{i:05d}", "HH", (500, 0)) for i in range(2000))
    elapsed, places = _spare_places(DrawingData((*curves, *around), nodes, tuple(texts)))
    assert [(p["handle"], p.get("expected")) for p in places] == [("SP", None)]
    assert elapsed < CPU_BUDGET_S, f"{elapsed:.1f} s"


def test_box_number_duplicates_name_a_bounded_list_of_written_forms() -> None:
    boxes = tuple(insert(f"B{i:04d}", "BOX", (30.0 * i, 0), "box c") for i in range(400))
    texts = tuple(
        t
        for i in range(400)
        for t in (
            text(f"N{i:04d}", "TXTNMPER", "0" * (i % 4) + "1", (30.0 * i, 3)),
            text(f"K{i:04d}", "TXTCAP", "1-3", (30.0 * i + 2, 3)),
        )
    )
    reading, features = read(DrawingData((), boxes, texts), SECONDARY_RULES, "secondary")
    problems = check_kind(features, reading, rules_of(SECONDARY_RULES))
    found = {str((i.params or {})["found"]) for i in problems["BOX_NUMBER_DUPLICATE"]}
    assert found == {"0001, 001, 01, 1"}
    assert all(len(f) <= MAX_FOUND_LENGTH for f in found)
