"""CRS detection from the drawing extents (Phase 1b contract, ADR-018).

Mirror of `CrsDetectionSchema` (`packages/shared/src/cad/crs-detection.schemas.ts`). It only
suggests: the PM confirms the EPSG and picks the drawing unit on the mapping screen. Easting alone
cannot tell the UTM zone, so an EPSG is suggested only when the project's own UTM CRS places the
drawing inside its zone. All transforms go through `geo.py`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from cad_worker.domain.extents import Extents
from cad_worker.domain.geo import project_crs, utm_zone

CrsKind = Literal["projected_utm", "geographic", "local", "unknown"]
CrsReason = Literal[
    "MATCHES_PROJECT_CRS",
    "UTM_ZONE_UNKNOWN",
    "LONLAT_RANGE",
    "SMALL_LOCAL_COORDINATES",
    "NO_EXTENTS",
    "OUT_OF_KNOWN_RANGES",
]
DrawingUnit = Literal["m", "cm", "mm", "km", "in", "ft"]

# DXF `$INSUNITS` codes that correspond to a drawing unit (INSUNITS_TO_DRAWING_UNIT).
INSUNITS_TO_DRAWING_UNIT: dict[int, DrawingUnit] = {
    1: "in",
    2: "ft",
    4: "mm",
    5: "cm",
    6: "m",
    7: "km",
}

# Extents that read as UTM easting/northing in metres (contract "Worker / Import").
UTM_MIN_EASTING = 100_000.0
UTM_MAX_EASTING = 900_000.0
UTM_MAX_NORTHING = 10_000_000.0
# The centre may lie this far from the zone's central meridian (zone half-width 3° + margin).
UTM_ZONE_MAX_OFFSET_DEG = 4.0
GEOGRAPHIC_MAX_SPAN_DEG = 10.0
LOCAL_MAX_ABS = 100_000.0


@dataclass(frozen=True, slots=True)
class CrsDetection:
    kind: CrsKind
    reason: CrsReason
    suggested_epsg: int | None
    project_epsg: int | None
    implied_unit: DrawingUnit | None
    ins_units: int | None
    declared_unit: DrawingUnit | None
    units_conflict: bool

    def to_json(self) -> dict[str, object]:
        """camelCase keys exactly as `CrsDetectionSchema` (stored in `cad_files.crs_detection`)."""
        return {
            "kind": self.kind,
            "reason": self.reason,
            "suggestedEpsg": self.suggested_epsg,
            "projectEpsg": self.project_epsg,
            "impliedUnit": self.implied_unit,
            "insUnits": self.ins_units,
            "declaredUnit": self.declared_unit,
            "unitsConflict": self.units_conflict,
        }


def declared_unit(ins_units: int | None) -> DrawingUnit | None:
    """The unit `$INSUNITS` declares; None when unitless, absent or unsupported."""
    return None if ins_units is None else INSUNITS_TO_DRAWING_UNIT.get(ins_units)


def detect_crs(
    extents: Extents | None, ins_units: int | None, project_epsg: int | None
) -> CrsDetection:
    kind, reason, suggested, implied = _classify(extents, project_epsg)
    declared = declared_unit(ins_units)
    conflict = implied is not None and declared is not None and implied != declared
    return CrsDetection(
        kind=kind,
        reason=reason,
        suggested_epsg=suggested,
        project_epsg=project_epsg,
        implied_unit=implied,
        ins_units=ins_units,
        declared_unit=declared,
        units_conflict=conflict,
    )


def _classify(
    e: Extents | None, project_epsg: int | None
) -> tuple[CrsKind, CrsReason, int | None, DrawingUnit | None]:
    if e is None:
        return "unknown", "NO_EXTENTS", None, None
    if _looks_like_utm(e):
        if _inside_project_zone(e, project_epsg):
            return "projected_utm", "MATCHES_PROJECT_CRS", project_epsg, "m"
        return "projected_utm", "UTM_ZONE_UNKNOWN", None, "m"
    if _looks_like_lonlat(e):
        # Degrees are not a drawing unit and 4326 is not a supported project CRS: no suggestion.
        return "geographic", "LONLAT_RANGE", None, None
    if all(abs(v) < LOCAL_MAX_ABS for v in (e.min_x, e.min_y, e.max_x, e.max_y)):
        return "local", "SMALL_LOCAL_COORDINATES", None, None
    return "unknown", "OUT_OF_KNOWN_RANGES", None, None


def _looks_like_utm(e: Extents) -> bool:
    return (
        e.min_x >= UTM_MIN_EASTING
        and e.max_x <= UTM_MAX_EASTING
        and e.min_y >= 0
        and e.max_y <= UTM_MAX_NORTHING
    )


def _looks_like_lonlat(e: Extents) -> bool:
    inside = all(abs(x) <= 180 for x in (e.min_x, e.max_x)) and all(
        abs(y) <= 90 for y in (e.min_y, e.max_y)
    )
    span = max(e.max_x - e.min_x, e.max_y - e.min_y)
    return inside and span < GEOGRAPHIC_MAX_SPAN_DEG


def _inside_project_zone(e: Extents, project_epsg: int | None) -> bool:
    """The extents centre, read as metres in the project's UTM CRS, lies inside its zone."""
    zone = utm_zone(project_epsg)
    if zone is None or project_epsg is None:
        return False
    cx, cy = (e.min_x + e.max_x) / 2, (e.min_y + e.max_y) / 2
    lon, lat = project_crs(project_epsg).to_wgs84(cx, cy)
    offset = abs((lon - zone.central_meridian + 180.0) % 360.0 - 180.0)
    low, high = zone.latitude_band()
    return offset <= UTM_ZONE_MAX_OFFSET_DEG and low <= lat <= high
