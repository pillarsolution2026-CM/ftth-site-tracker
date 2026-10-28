"""CRS detection from extents (pure; transforms through geo.py)."""

from __future__ import annotations

import pytest

from cad_worker.domain.crs_detect import declared_unit, detect_crs
from cad_worker.domain.extents import Extents
from cad_worker.domain.geo import lonlat_to_tile, project_crs, reproject, utm_zone

# Qalyub, sector 1: UTM 36N metres, but $INSUNITS = 1 (inches) — ADR-018.
QALYUB = Extents(323_800.0, 3_338_900.0, 326_600.0, 3_341_700.0)


def test_qalyub_like_extents_match_the_project_utm_zone_with_a_units_conflict() -> None:
    result = detect_crs(QALYUB, 1, 32636)
    assert result.to_json() == {
        "kind": "projected_utm",
        "reason": "MATCHES_PROJECT_CRS",
        "suggestedEpsg": 32636,
        "projectEpsg": 32636,
        "impliedUnit": "m",
        "insUnits": 1,
        "declaredUnit": "in",
        "unitsConflict": True,
    }


def test_declared_metres_do_not_conflict() -> None:
    result = detect_crs(QALYUB, 6, 32636)
    assert result.units_conflict is False and result.declared_unit == "m"


@pytest.mark.parametrize("ins_units", [None, 0, 3, 99])
def test_unitless_or_unsupported_insunits_never_conflict(ins_units: int | None) -> None:
    result = detect_crs(QALYUB, ins_units, 32636)
    assert result.declared_unit is None and result.units_conflict is False


def test_drawing_outside_the_project_zone_gets_no_suggestion() -> None:
    # Far west of zone 36's central meridian at a high latitude: > 4° away.
    far = Extents(105_000.0, 7_000_000.0, 106_000.0, 7_001_000.0)
    result = detect_crs(far, 6, 32636)
    assert (result.kind, result.reason, result.suggested_epsg) == (
        "projected_utm",
        "UTM_ZONE_UNKNOWN",
        None,
    )
    assert result.implied_unit == "m"


@pytest.mark.parametrize("project_epsg", [None, 4326, 3857])
def test_non_utm_project_crs_cannot_tell_the_zone(project_epsg: int | None) -> None:
    result = detect_crs(QALYUB, 1, project_epsg)
    assert result.reason == "UTM_ZONE_UNKNOWN" and result.suggested_epsg is None
    assert result.units_conflict is True  # still metres implied, inches declared


def test_south_hemisphere_project_zone() -> None:
    # Around 27°S, 33°E (UTM 36S): northing counts down from 10,000,000 m.
    south = Extents(499_000.0, 7_010_000.0, 501_000.0, 7_012_000.0)
    assert detect_crs(south, 6, 32736).suggested_epsg == 32736
    # The same numbers read in the northern zone are ~63°N: still inside 36N's band.
    north = detect_crs(south, 6, 32636)
    assert north.reason == "MATCHES_PROJECT_CRS"


def test_northern_hemisphere_band_excludes_polar_northings() -> None:
    polar = Extents(499_000.0, 9_800_000.0, 501_000.0, 9_900_000.0)
    assert detect_crs(polar, 6, 32636).reason == "UTM_ZONE_UNKNOWN"


def test_lon_lat_values_are_geographic_without_suggestion() -> None:
    result = detect_crs(Extents(31.18, 30.17, 31.22, 30.21), 0, 32636)
    assert (result.kind, result.reason, result.suggested_epsg, result.implied_unit) == (
        "geographic",
        "LONLAT_RANGE",
        None,
        None,
    )
    assert result.units_conflict is False


def test_small_coordinates_are_local() -> None:
    result = detect_crs(Extents(0.0, 0.0, 220.0, 220.0), 6, 32636)
    assert (result.kind, result.reason, result.units_conflict) == (
        "local",
        "SMALL_LOCAL_COORDINATES",
        False,
    )


def test_wide_degree_like_range_is_local_not_geographic() -> None:
    assert detect_crs(Extents(0.0, 0.0, 50.0, 40.0), None, 32636).kind == "local"


def test_negative_large_values_are_out_of_known_ranges() -> None:
    result = detect_crs(Extents(-500_000.0, 10.0, -400_000.0, 20.0), 6, 32636)
    assert (result.kind, result.reason) == ("unknown", "OUT_OF_KNOWN_RANGES")


def test_no_extents() -> None:
    result = detect_crs(None, 1, 32636)
    assert result.to_json() == {
        "kind": "unknown",
        "reason": "NO_EXTENTS",
        "suggestedEpsg": None,
        "projectEpsg": 32636,
        "impliedUnit": None,
        "insUnits": 1,
        "declaredUnit": "in",
        "unitsConflict": False,
    }


def test_declared_units_table() -> None:
    assert [declared_unit(i) for i in (1, 2, 4, 5, 6, 7)] == ["in", "ft", "mm", "cm", "m", "km"]


def test_utm_zone_helper() -> None:
    zone = utm_zone(32636)
    assert zone is not None and (zone.zone, zone.south, zone.central_meridian) == (36, False, 33.0)
    south = utm_zone(32701)
    assert south is not None and south.south and south.central_meridian == -177.0
    assert utm_zone(4326) is None and utm_zone(None) is None


def test_bounds_and_reprojection_and_tiles() -> None:
    min_lon, min_lat, max_lon, max_lat = project_crs(32636).bounds_to_wgs84(
        QALYUB.min_x, QALYUB.min_y, QALYUB.max_x, QALYUB.max_y
    )
    assert 31.1 < min_lon < max_lon < 31.3 and 30.1 < min_lat < max_lat < 30.3
    ((x, y),) = reproject([(325_000.0, 3_340_000.0)], 32636, 32635)
    ((bx, by),) = reproject([(x, y)], 32635, 32636)
    assert (bx, by) == pytest.approx((325_000.0, 3_340_000.0), abs=1e-6)
    assert reproject([(1.0, 2.0)], 32636, 32636) == ((1.0, 2.0),)
    assert lonlat_to_tile(0.0, 0.0, 1) == (1, 1)
    assert lonlat_to_tile(-180.0, 89.0, 3) == (0, 0)
    assert lonlat_to_tile(180.0, -89.0, 3) == (7, 7)
