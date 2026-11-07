"""Placing a drawing on the earth (ADR-032, ADR-035). Pure apart from pyproj.

Mirror of `packages/geo/src/placement.ts` — change both together (shared test values).
drawing units → metres → source CRS → project UTM → control-point fit → hand adjustment.
A fit and a hand adjustment are similarities: X = a·x - b·y + tx, Y = b·x + a·y + ty.
"""

from __future__ import annotations

import math
import statistics
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

from pyproj import Transformer

from cad_worker.domain.design import Xy

SourceCrs = Literal["project", "egypt_red_belt"]

# Egypt 1907 / Red Belt with the general datum shift (ADR-035; mirror of EGYPT_RED_BELT_PROJ4).
EGYPT_RED_BELT_PROJ4 = (
    "+proj=tmerc +lat_0=30 +lon_0=31 +k=1 +x_0=615000 +y_0=810000 +ellps=helmert "
    "+towgs84=-130,110,-13,0,0,0,0 +units=m +no_defs"
)
SCALE_WARNING = 0.001
OUTLIER_FACTOR = 3.0
OUTLIER_MIN_M = 2.0


class PlacementInvalidError(ValueError):
    """The frozen placement cannot be applied (revision fails `MAPPING_INVALID`)."""


@dataclass(frozen=True, slots=True)
class Similarity:
    a: float = 1.0
    b: float = 0.0
    tx: float = 0.0
    ty: float = 0.0

    def apply(self, p: Xy) -> Xy:
        return (self.a * p[0] - self.b * p[1] + self.tx, self.b * p[0] + self.a * p[1] + self.ty)

    def after(self, inner: Similarity) -> Similarity:
        """`self ∘ inner`: apply `inner` first."""
        return Similarity(
            self.a * inner.a - self.b * inner.b,
            self.b * inner.a + self.a * inner.b,
            self.a * inner.tx - self.b * inner.ty + self.tx,
            self.b * inner.tx + self.a * inner.ty + self.ty,
        )

    @property
    def scale(self) -> float:
        return math.hypot(self.a, self.b)

    @property
    def rotation_deg(self) -> float:
        return math.degrees(math.atan2(self.b, self.a))


IDENTITY = Similarity()


@dataclass(frozen=True, slots=True)
class ControlPoint:
    id: str
    drawing: Xy  # drawing units
    lat: float
    lon: float
    excluded: bool = False


@dataclass(frozen=True, slots=True)
class Adjust:
    dx: float = 0.0
    dy: float = 0.0
    rotation_deg: float = 0.0
    scale: float = 1.0
    pivot: Xy | None = None


@dataclass(frozen=True, slots=True)
class Placement:
    source_crs: SourceCrs = "project"
    points: tuple[ControlPoint, ...] = ()
    fit_scale_with_two_points: bool = False
    adjust: Adjust = Adjust()

    @property
    def is_identity(self) -> bool:
        return self.source_crs == "project" and not self.points and self.adjust == Adjust()


NO_PLACEMENT = Placement()


@dataclass(frozen=True, slots=True)
class Residual:
    id: str
    error_m: float
    excluded: bool
    outlier: bool


@dataclass(frozen=True, slots=True)
class Solution:
    fit: Similarity
    adjust: Similarity
    total: Similarity
    points_used: int
    residuals: tuple[Residual, ...]
    to_source: Callable[[Xy], Xy]

    def to_project(self, p: Xy) -> Xy:
        """Drawing units → project CRS metres."""
        return self.total.apply(self.to_source(p))

    @property
    def scale(self) -> float:
        return self.total.scale

    @property
    def scale_warning(self) -> bool:
        return abs(self.total.scale - 1.0) > SCALE_WARNING


def source_to_project(
    source_crs: SourceCrs, project_epsg: int, metres_per_unit: float
) -> Callable[[Xy], Xy]:
    if source_crs == "project":
        return lambda p: (p[0] * metres_per_unit, p[1] * metres_per_unit)
    t = Transformer.from_crs(EGYPT_RED_BELT_PROJ4, f"EPSG:{project_epsg}", always_xy=True)

    def convert(p: Xy) -> Xy:
        x, y = t.transform(p[0] * metres_per_unit, p[1] * metres_per_unit)
        if not (math.isfinite(x) and math.isfinite(y)):
            raise PlacementInvalidError("Red Belt conversion failed")
        return (float(x), float(y))

    return convert


def fit_similarity(frm: Sequence[Xy], to: Sequence[Xy], with_scale: bool) -> Similarity:
    n = len(frm)
    if n == 0:
        return IDENTITY
    fx_m = sum(p[0] for p in frm) / n
    fy_m = sum(p[1] for p in frm) / n
    tx_m = sum(p[0] for p in to) / n
    ty_m = sum(p[1] for p in to) / n
    if n == 1:
        return Similarity(1.0, 0.0, tx_m - fx_m, ty_m - fy_m)
    num_a = num_b = den = 0.0
    for f, t in zip(frm, to, strict=True):
        fx, fy, tx, ty = f[0] - fx_m, f[1] - fy_m, t[0] - tx_m, t[1] - ty_m
        num_a += fx * tx + fy * ty
        num_b += fx * ty - fy * tx
        den += fx * fx + fy * fy
    if den == 0:
        raise PlacementInvalidError("Control points sit on one drawing spot")
    a, b = num_a / den, num_b / den
    if not with_scale:
        k = math.hypot(a, b)
        a, b = a / k, b / k
    return Similarity(a, b, tx_m - (a * fx_m - b * fy_m), ty_m - (b * fx_m + a * fy_m))


def adjust_similarity(adjust: Adjust) -> Similarity:
    turns = adjust.rotation_deg != 0 or adjust.scale != 1
    if turns and adjust.pivot is None:
        raise PlacementInvalidError("Rotate / Scale need a pivot")
    cx, cy = adjust.pivot if turns and adjust.pivot is not None else (0.0, 0.0)
    t = math.radians(adjust.rotation_deg)
    a, b = adjust.scale * math.cos(t), adjust.scale * math.sin(t)
    return Similarity(a, b, cx - (a * cx - b * cy) + adjust.dx, cy - (b * cx + a * cy) + adjust.dy)


def solve(placement: Placement, project_epsg: int, metres_per_unit: float) -> Solution:
    to_source = source_to_project(placement.source_crs, project_epsg, metres_per_unit)
    wgs = Transformer.from_crs("EPSG:4326", f"EPSG:{project_epsg}", always_xy=True)
    rows = [
        (p, to_source(p.drawing), tuple(map(float, wgs.transform(p.lon, p.lat))))
        for p in placement.points
    ]
    used = [r for r in rows if not r[0].excluded]
    with_scale = len(used) >= 3 or (len(used) == 2 and placement.fit_scale_with_two_points)
    fit = fit_similarity([r[1] for r in used], [r[2] for r in used], with_scale)  # type: ignore[misc]
    adj = adjust_similarity(placement.adjust)
    errors = [math.dist(fit.apply(f), t) for _, f, t in rows]
    used_errors = [e for (p, _, _), e in zip(rows, errors, strict=True) if not p.excluded]
    limit = (
        max(OUTLIER_FACTOR * statistics.median(used_errors), OUTLIER_MIN_M)
        if len(used) >= 3
        else math.inf
    )
    residuals = tuple(
        Residual(p.id, e, p.excluded, (not p.excluded) and e > limit)
        for (p, _, _), e in zip(rows, errors, strict=True)
    )
    return Solution(fit, adj, adj.after(fit), len(used), residuals, to_source)


def parse_placement(raw: object) -> Placement:
    """The revision's frozen `placement` JSON (`PlacementSchema`); None/null = as drawn."""
    if raw is None:
        return NO_PLACEMENT
    if not isinstance(raw, Mapping):
        raise PlacementInvalidError("placement must be an object")
    try:
        points = tuple(
            ControlPoint(
                str(p["id"]),
                (float(p["drawing"]["x"]), float(p["drawing"]["y"])),
                float(p["lat"]),
                float(p["lon"]),
                bool(p.get("excluded", False)),
            )
            for p in raw.get("points", [])
        )
        a = raw.get("adjust") or {}
        pivot = a.get("pivot")
        source = raw.get("sourceCrs", "project")
        if source not in ("project", "egypt_red_belt"):
            raise PlacementInvalidError(f"unknown source CRS {source!r}")
        return Placement(
            source,
            points,
            bool(raw.get("fitScaleWithTwoPoints", False)),
            Adjust(
                float(a.get("dx", 0)),
                float(a.get("dy", 0)),
                float(a.get("rotationDeg", 0)),
                float(a.get("scale", 1)),
                (float(pivot["x"]), float(pivot["y"])) if pivot else None,
            ),
        )
    except (KeyError, TypeError, ValueError) as exc:
        if isinstance(exc, PlacementInvalidError):
            raise
        raise PlacementInvalidError(f"invalid placement: {exc}") from exc


@dataclass(frozen=True, slots=True)
class Placer:
    """How the build turns drawing coordinates into project CRS metres, and back for display."""

    to_project: Callable[[Xy], Xy]
    to_drawing: Callable[[Xy], Xy]
    unit_m: float  # metres per drawing unit after placement (text heights, tolerances)


def unit_placer(metres_per_unit: float) -> Placer:
    """As drawn: drawing units times metres per unit, already in the project CRS."""
    f = metres_per_unit
    return Placer(lambda p: (p[0] * f, p[1] * f), lambda p: (p[0] / f, p[1] / f), f)


def inverse(s: Similarity) -> Similarity:
    k = s.a * s.a + s.b * s.b
    a, b = s.a / k, -s.b / k
    return Similarity(a, b, -(a * s.tx - b * s.ty), -(b * s.tx + a * s.ty))


def make_placer(placement: Placement, project_epsg: int, metres_per_unit: float) -> Placer:
    if placement.is_identity:
        return unit_placer(metres_per_unit)
    solution = solve(placement, project_epsg, metres_per_unit)
    back = inverse(solution.total)
    f = metres_per_unit
    if placement.source_crs == "project":
        from_source: Callable[[Xy], Xy] = lambda p: (p[0] / f, p[1] / f)  # noqa: E731
    else:
        t = Transformer.from_crs(f"EPSG:{project_epsg}", EGYPT_RED_BELT_PROJ4, always_xy=True)

        def from_source(p: Xy) -> Xy:
            x, y = t.transform(p[0], p[1])
            return (float(x) / f, float(y) / f)

    return Placer(
        solution.to_project,
        lambda p: from_source(back.apply(p)),
        f * solution.scale,
    )
