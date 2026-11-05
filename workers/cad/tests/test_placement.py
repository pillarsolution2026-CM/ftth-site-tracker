"""Placement solver (ADR-035). Same cases and values as packages/geo/src/placement.spec.ts."""

from __future__ import annotations

import math

import pytest
from pyproj import Transformer

from cad_worker.domain.placement import (
    Adjust,
    ControlPoint,
    Placement,
    PlacementInvalidError,
    adjust_similarity,
    parse_placement,
    solve,
    source_to_project,
)

CAB_1_7 = (7284.2708, 4091.7164)
CAB_1_7_LL = (30.984506906326853, 32.78324905782938)
_to_ll = Transformer.from_crs("EPSG:32636", "EPSG:4326", always_xy=True)


def ll(x: float, y: float) -> tuple[float, float]:
    lon, lat = _to_ll.transform(x, y)
    return lat, lon


def test_no_point_leaves_the_drawing_as_drawn() -> None:
    s = solve(Placement(), 32636, 1.0)
    assert s.to_project((10, 20)) == (10, 20) and s.points_used == 0


def test_one_point_only_moves_the_drawing_rabaa_cabinet_1_7() -> None:
    s = solve(Placement(points=(ControlPoint("c", CAB_1_7, *CAB_1_7_LL),)), 32636, 1.0)
    x, y = s.to_project(CAB_1_7)
    assert (x, y) == pytest.approx((479304.27, 3427905.06), abs=0.05)
    assert s.scale == 1 and s.residuals[0].error_m < 1e-6


def test_two_points_recover_a_rotation_and_keep_scale_1() -> None:
    def turned(p: tuple[float, float]) -> tuple[float, float]:
        return (479000 - p[1], 3427000 + p[0])

    pts = tuple(ControlPoint(i, p, *ll(*turned(p))) for i, p in (("a", (0, 0)), ("b", (100, 0))))
    s = solve(Placement(points=pts), 32636, 1.0)
    assert s.total.rotation_deg == pytest.approx(90, abs=1e-6) and s.scale == pytest.approx(1)
    assert s.to_project((50, 0)) == pytest.approx((479000, 3427050), abs=1e-3)


def test_three_points_fit_scale_and_flag_an_outlier() -> None:
    def at(x: float, y: float) -> tuple[float, float]:
        return ll(479000 + 1.002 * x, 3427000 + 1.002 * y)

    pts = [
        ControlPoint("p1", (0, 0), *at(0, 0)),
        ControlPoint("p2", (1000, 0), *at(1000, 0)),
        ControlPoint("p3", (0, 1000), *at(0, 1000)),
        ControlPoint("p4", (1000, 1000), *at(1000, 1000)),
        ControlPoint("far", (500, 500), *at(700, 500)),
    ]
    s = solve(Placement(points=tuple(pts)), 32636, 1.0)
    assert next(r for r in s.residuals if r.id == "far").outlier
    clean = solve(
        Placement(
            points=tuple(ControlPoint(p.id, p.drawing, p.lat, p.lon, p.id == "far") for p in pts)
        ),
        32636,
        1.0,
    )
    assert clean.scale == pytest.approx(1.002, abs=1e-5) and clean.scale_warning
    assert max(r.error_m for r in clean.residuals if not r.excluded) < 0.01
    assert next(r for r in clean.residuals if r.id == "far").error_m > 150


def test_a_hand_adjustment_turns_about_its_pivot_then_moves() -> None:
    adj = adjust_similarity(Adjust(5, -2, 90, 1, (10, 10)))
    assert adj.apply((20, 10)) == pytest.approx((15, 18), abs=1e-9)
    with pytest.raises(PlacementInvalidError):
        adjust_similarity(Adjust(scale=1.1))


def test_red_belt_with_the_general_datum_shift_matches_the_web() -> None:
    f = source_to_project("egypt_red_belt", 32636, 1.0)
    assert f((615000, 810000)) == pytest.approx((307246.448, 3320485.069), abs=0.01)
    assert f((877657, 937648)) == pytest.approx((571977.79, 3443379.759), abs=0.01)


def test_parse_the_frozen_json() -> None:
    p = parse_placement(
        {
            "sourceCrs": "project",
            "points": [
                {
                    "id": "c",
                    "drawing": {"x": 1, "y": 2},
                    "lat": 30.0,
                    "lon": 32.0,
                    "source": "kml",
                    "excluded": False,
                }
            ],
            "fitScaleWithTwoPoints": False,
            "adjust": {"dx": 1, "dy": 2, "rotationDeg": 0, "scale": 1, "pivot": None},
        }
    )
    assert p.points[0].drawing == (1, 2) and p.adjust.dx == 1
    assert parse_placement(None).is_identity
    with pytest.raises(PlacementInvalidError):
        parse_placement({"sourceCrs": "mars"})
    assert math.isfinite(solve(p, 32636, 1.0).to_project((0, 0))[0])
