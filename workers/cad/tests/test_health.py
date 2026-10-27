from cad_worker.application.health import check_health


def test_health_versions_ok() -> None:
    report = check_health()
    assert report.status == "ok"
    assert set(report.versions) == {"ezdxf", "pyproj", "shapely"}


def test_health_degraded_when_probe_fails() -> None:
    def boom() -> bool:
        raise ConnectionError

    report = check_health({"redis": boom, "db": lambda: True})
    assert report.status == "degraded"
    assert report.dependencies == {"redis": "down", "db": "ok"}
