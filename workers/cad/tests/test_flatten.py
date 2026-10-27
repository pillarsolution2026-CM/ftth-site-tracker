import itertools
import math

import pytest

from cad_worker.domain.flatten import (
    FLATTEN_TOLERANCE,
    MAX_SEGMENTS,
    arc_points,
    bulge_points,
    circle_points,
    polyline_points,
    segment_count,
)


def length(points: list[tuple[float, float]]) -> float:
    return sum(math.dist(a, b) for a, b in itertools.pairwise(points))


def max_sagitta(points: list[tuple[float, float]], cx: float, cy: float, r: float) -> float:
    """Largest distance between a chord midpoint and the true circle."""
    return max(
        abs(r - math.dist(((a[0] + b[0]) / 2, (a[1] + b[1]) / 2), (cx, cy)))
        for a, b in itertools.pairwise(points)
    )


def test_quarter_arc_length_and_tolerance() -> None:
    pts = arc_points(0, 0, 100, 0, math.pi / 2)
    assert pts[0] == pytest.approx((100, 0))
    assert pts[-1] == pytest.approx((0, 100), abs=1e-9)
    assert length(pts) == pytest.approx(100 * math.pi / 2, abs=0.01)
    assert max_sagitta(pts, 0, 0, 100) <= FLATTEN_TOLERANCE * 1.0001


def test_negative_sweep_goes_clockwise() -> None:
    pts = arc_points(0, 0, 10, 0, -math.pi / 2)
    assert pts[-1] == pytest.approx((0, -10), abs=1e-9)


def test_circle_is_closed_ring() -> None:
    ring = circle_points(5, 5, 2)
    assert ring[0] == ring[-1]
    assert length(ring) == pytest.approx(2 * math.pi * 2, rel=1e-3)


def test_segment_count_is_capped_and_handles_tiny_radius() -> None:
    assert segment_count(1e9, 2 * math.pi) == MAX_SEGMENTS
    assert segment_count(0.0005, math.pi) >= 1
    assert segment_count(0, 1) == 1


def test_zero_bulge_is_straight() -> None:
    assert bulge_points((0, 0), (5, 0), 0.0) == [(0, 0), (5, 0)]


def test_semicircle_bulge_positive_is_counter_clockwise() -> None:
    pts = bulge_points((0, 0), (10, 0), 1.0)
    assert pts[0] == (0, 0) and pts[-1] == (10, 0)
    # counter-clockwise from (0,0) to (10,0) bulges to the right of travel: y < 0
    assert min(y for _, y in pts) == pytest.approx(-5, abs=1e-3)
    assert length(pts) == pytest.approx(math.pi * 5, abs=0.01)


def test_negative_bulge_bulges_to_the_left() -> None:
    pts = bulge_points((0, 0), (10, 0), -1.0)
    assert max(y for _, y in pts) == pytest.approx(5, abs=1e-3)


def test_quarter_bulge_radius() -> None:
    bulge = math.tan(math.pi / 8)  # 90 degree arc
    pts = bulge_points((0, 0), (10, 0), bulge)
    radius = 10 / math.sqrt(2)
    assert length(pts) == pytest.approx(radius * math.pi / 2, abs=0.01)


def test_zero_length_chord() -> None:
    assert bulge_points((1, 1), (1, 1), 0.5) == [(1, 1), (1, 1)]


def test_polyline_open_closed_and_approximated_flag() -> None:
    pts, approx = polyline_points([(0, 0, 0), (4, 0, 0), (4, 3, 0)], closed=False)
    assert pts == [(0, 0), (4, 0), (4, 3)] and not approx
    ring, approx = polyline_points([(0, 0, 0), (4, 0, 0), (4, 3, 0)], closed=True)
    assert ring[0] == ring[-1] and len(ring) == 4 and not approx
    bulged, approx = polyline_points([(0, 0, 1.0), (10, 0, 0)], closed=False)
    assert approx and len(bulged) > 2
