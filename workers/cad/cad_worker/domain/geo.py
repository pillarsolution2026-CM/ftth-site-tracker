"""CRS handling. The single place in the worker where coordinate transforms happen."""

from __future__ import annotations

from dataclasses import dataclass, field

from pyproj import CRS, Transformer
from pyproj.exceptions import CRSError

WGS84_EPSG = 4326


class InvalidCrsError(ValueError):
    """Raised when an EPSG code is unknown."""


@dataclass(frozen=True, slots=True)
class ProjectCrs:
    """Project coordinate reference system (metric, e.g. EPSG:32636)."""

    epsg: int
    _to_wgs84: Transformer = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        try:
            crs = CRS.from_epsg(self.epsg)
        except CRSError as exc:
            raise InvalidCrsError(f"Invalid EPSG code: {self.epsg}") from exc
        transformer = Transformer.from_crs(crs, CRS.from_epsg(WGS84_EPSG), always_xy=True)
        object.__setattr__(self, "_to_wgs84", transformer)

    def to_wgs84(self, x: float, y: float) -> tuple[float, float]:
        """Transform project (x, y) to WGS84 (lon, lat) for display/GPS only."""
        lon, lat = self._to_wgs84.transform(x, y)
        return float(lon), float(lat)
