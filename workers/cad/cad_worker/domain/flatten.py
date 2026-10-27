"""Arc, bulge and circle flattening into vertices.

Tolerance: the maximum distance (sagitta) between a chord and the true arc, in drawing units.
`FLATTEN_TOLERANCE` is 0.001 drawing units (1 mm for metre drawings); it is stored with every
approximated curve in `cad_curves.flatten_tolerance`. A single arc is limited to
`MAX_SEGMENTS` segments so a huge radius cannot create millions of vertices; the stored
tolerance is then a lower bound for that curve only in that degenerate case.
Shortened chords always lie inside the arc, so flattened lengths are slightly short of the true
length (relative error about tolerance / radius for the worst vertex spacing).
"""

from __future__ import annotations

import math
from collections.abc import Sequence

FLATTEN_TOLERANCE = 0.001
MAX_SEGMENTS = 2048

Xy = tuple[float, float]


def segment_count(radius: float, sweep: float, tolerance: float = FLATTEN_TOLERANCE) -> int:
    """Number of chords needed so no chord deviates from the arc by more than `tolerance`."""
    if radius <= 0 or sweep == 0:
        return 1
    ratio = 1.0 - tolerance / radius
    step = math.pi if ratio <= -1.0 else 2.0 * math.acos(max(ratio, -1.0))
    if step <= 0.0:
        return MAX_SEGMENTS
    return max(1, min(MAX_SEGMENTS, math.ceil(abs(sweep) / step)))


def arc_points(
    cx: float,
    cy: float,
    radius: float,
    start: float,
    sweep: float,
    tolerance: float = FLATTEN_TOLERANCE,
) -> list[Xy]:
    """Points of an arc from angle `start` (radians), counter-clockwise for positive `sweep`.

    Both end points are included.
    """
    n = segment_count(radius, sweep, tolerance)
    return [
        (
            cx + radius * math.cos(start + sweep * i / n),
            cy + radius * math.sin(start + sweep * i / n),
        )
        for i in range(n + 1)
    ]


def circle_points(
    cx: float, cy: float, radius: float, tolerance: float = FLATTEN_TOLERANCE
) -> list[Xy]:
    """Closed ring (first point repeated at the end)."""
    pts = arc_points(cx, cy, radius, 0.0, 2.0 * math.pi, tolerance)
    pts[-1] = pts[0]
    return pts


def bulge_points(p0: Xy, p1: Xy, bulge: float, tolerance: float = FLATTEN_TOLERANCE) -> list[Xy]:
    """Points of a polyline segment with bulge (tan of a quarter of the included angle).

    Positive bulge = counter-clockwise arc. Returns p0 ... p1 inclusive; a zero bulge or a
    zero-length chord gives just [p0, p1].
    """
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    chord = math.hypot(dx, dy)
    if bulge == 0.0 or chord == 0.0:
        return [p0, p1]
    sweep = 4.0 * math.atan(bulge)
    radius = chord / (2.0 * math.sin(abs(sweep) / 2.0))
    offset = (chord / 2.0) * (1.0 - bulge * bulge) / (2.0 * bulge)
    cx = (p0[0] + p1[0]) / 2.0 - dy / chord * offset
    cy = (p0[1] + p1[1]) / 2.0 + dx / chord * offset
    start = math.atan2(p0[1] - cy, p0[0] - cx)
    pts = arc_points(cx, cy, radius, start, sweep, tolerance)
    pts[0], pts[-1] = p0, p1
    return pts


def polyline_points(
    vertices: Sequence[tuple[float, float, float]],
    closed: bool,
    tolerance: float = FLATTEN_TOLERANCE,
) -> tuple[list[Xy], bool]:
    """Flatten (x, y, bulge) vertices. Returns (points, approximated).

    A closed polyline gets its first point appended; its closing segment may carry a bulge too.
    """
    pts: list[Xy] = []
    approximated = False
    count = len(vertices)
    last = count if closed else count - 1
    for i in range(last):
        x0, y0, bulge = vertices[i]
        x1, y1, _ = vertices[(i + 1) % count]
        seg = bulge_points((x0, y0), (x1, y1), bulge, tolerance)
        approximated = approximated or len(seg) > 2
        pts.extend(seg if not pts else seg[1:])
    return pts, approximated
