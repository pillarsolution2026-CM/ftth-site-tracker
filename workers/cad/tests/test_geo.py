import pytest

from cad_worker.domain.geo import InvalidCrsError, ProjectCrs


def test_valid_epsg() -> None:
    assert ProjectCrs(32636).epsg == 32636


def test_utm36n_qalyub_to_wgs84() -> None:
    lon, lat = ProjectCrs(32636).to_wgs84(330000.0, 3340000.0)
    assert lon == pytest.approx(31.2, abs=0.05)
    assert lat == pytest.approx(30.2, abs=0.05)


def test_invalid_epsg_raises() -> None:
    with pytest.raises(InvalidCrsError):
        ProjectCrs(999999)
