"""Health use case: library versions and dependency status."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from importlib.metadata import version
from typing import Any

from cad_worker.domain.geo import ProjectCrs

ProbeFn = Callable[[], bool]


@dataclass(frozen=True, slots=True)
class HealthReport:
    status: str
    versions: Mapping[str, str]
    dependencies: Mapping[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "versions": dict(self.versions),
            "dependencies": dict(self.dependencies),
        }


def check_health(probes: Mapping[str, ProbeFn] | None = None) -> HealthReport:
    """Report library versions and the status of external dependencies.

    `probes` maps a dependency name (e.g. "redis") to a callable returning True when reachable.
    A CRS round trip also verifies that pyproj data is usable.
    """
    versions = {name: version(name) for name in ("ezdxf", "pyproj", "shapely")}
    deps: dict[str, str] = {}
    for name, probe in (probes or {}).items():
        try:
            deps[name] = "ok" if probe() else "down"
        except Exception:  # a failing probe must not crash health
            deps[name] = "down"
    ProjectCrs(32636).to_wgs84(330000.0, 3340000.0)
    status = "ok" if all(v == "ok" for v in deps.values()) else "degraded"
    return HealthReport(status=status, versions=versions, dependencies=deps)
