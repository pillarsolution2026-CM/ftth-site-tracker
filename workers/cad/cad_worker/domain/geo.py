"""CRS handling. The single place in the worker where coordinate transforms happen."""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, field
from functools import lru_cache

from pyproj import CRS, Transformer
from pyproj.exceptions import CRSError

WGS84_EPSG = 4326
WEB_MERCATOR_EPSG = 3857
# Latitude limits of the UTM projection (polar regions use UPS).
UTM_NORTH_MAX_LAT = 84.0
UTM_SOUTH_MIN_LAT = -80.0
# Web-mercator tiles cover latitudes up to atan(sinh(pi)).
_MERCATOR_MAX_LAT = 85.0511287798066

Xy = tuple[float, float]


class InvalidCrsError(ValueError):
    """Raised when an EPSG code is unknown."""


@dataclass(frozen=True, slots=True)
class ProjectCrs:
    """Project coordinate reference system (metric, e.g. EPSG:32636)."""

    epsg: int
    _to_wgs84: Transformer = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        transformer = Transformer.from_crs(
            _crs(self.epsg), CRS.from_epsg(WGS84_EPSG), always_xy=True
        )
        object.__setattr__(self, "_to_wgs84", transformer)

    def to_wgs84(self, x: float, y: float) -> tuple[float, float]:
        """Transform project (x, y) to WGS84 (lon, lat) for display/GPS only."""
        lon, lat = self._to_wgs84.transform(x, y)
        return float(lon), float(lat)

    def bounds_to_wgs84(
        self, min_x: float, min_y: float, max_x: float, max_y: float
    ) -> tuple[float, float, float, float]:
        """(min_lon, min_lat, max_lon, max_lat) enclosing the projected box.

        The edges are densified: a UTM rectangle is not a lon/lat rectangle, so transforming the
        corners alone could cut off tiles along curved edges.
        """
        bounds = self._to_wgs84.transform_bounds(min_x, min_y, max_x, max_y, densify_pts=21)
        return float(bounds[0]), float(bounds[1]), float(bounds[2]), float(bounds[3])


def _crs(epsg: int) -> CRS:
    try:
        return CRS.from_epsg(epsg)
    except CRSError as exc:
        raise InvalidCrsError(f"Invalid EPSG code: {epsg}") from exc


@lru_cache(maxsize=32)
def project_crs(epsg: int) -> ProjectCrs:
    """Cached ProjectCrs: building a pyproj transformer is expensive."""
    return ProjectCrs(epsg)


@lru_cache(maxsize=32)
def _transformer(src_epsg: int, dst_epsg: int) -> Transformer:
    return Transformer.from_crs(_crs(src_epsg), _crs(dst_epsg), always_xy=True)


def reproject(points: Sequence[Xy], src_epsg: int, dst_epsg: int) -> tuple[Xy, ...]:
    """Transform 2D points between two CRS (identity when they are equal)."""
    if src_epsg == dst_epsg:
        return tuple((float(x), float(y)) for x, y in points)
    transformer = _transformer(src_epsg, dst_epsg)
    out: list[Xy] = []
    for x, y in points:
        tx, ty = transformer.transform(x, y)
        out.append((float(tx), float(ty)))
    return tuple(out)


@dataclass(frozen=True, slots=True)
class UtmZone:
    """WGS 84 / UTM zone of an EPSG code (326zz north, 327zz south)."""

    zone: int
    south: bool

    @property
    def central_meridian(self) -> float:
        return -183.0 + 6.0 * self.zone

    def latitude_band(self) -> tuple[float, float]:
        """Latitudes the hemisphere's UTM projection is defined for."""
        return (UTM_SOUTH_MIN_LAT, 0.0) if self.south else (0.0, UTM_NORTH_MAX_LAT)


def utm_zone(epsg: int | None) -> UtmZone | None:
    """The UTM zone of a WGS 84 / UTM EPSG code; None for any other CRS."""
    if epsg is None:
        return None
    if 32601 <= epsg <= 32660:
        return UtmZone(epsg - 32600, south=False)
    if 32701 <= epsg <= 32760:
        return UtmZone(epsg - 32700, south=True)
    return None


def lonlat_to_tile(lon: float, lat: float, zoom: int) -> tuple[int, int]:
    """Web-mercator (XYZ) tile containing a WGS 84 position, clamped to the tile grid."""
    n = 1 << zoom
    lat = max(-_MERCATOR_MAX_LAT, min(_MERCATOR_MAX_LAT, lat))
    x = (lon + 180.0) / 360.0 * n
    rad = math.radians(lat)
    y = (1.0 - math.asinh(math.tan(rad)) / math.pi) / 2.0 * n
    return min(n - 1, max(0, int(x))), min(n - 1, max(0, int(y)))
