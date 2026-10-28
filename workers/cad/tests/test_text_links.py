"""Text classification and linking (ADR-019). Pure."""

from __future__ import annotations

from decimal import Decimal

import pytest

from cad_worker.domain.design import DesignFeatureDraft, FeatureType
from cad_worker.domain.design_build import LinkText
from cad_worker.domain.text_links import (
    AUTO_LINK_MIN_CONFIDENCE,
    LINK_MIN_RADIUS_M,
    LINK_RADIUS_TEXT_HEIGHTS,
    TEXT_LINK_TARGETS,
    box_codes,
    classify_link_text,
    link_confidence,
    link_radius_m,
    link_texts,
    linked_texts_by_kind,
    status_counts,
)


def point(handle: str, xy: tuple[float, float], kind: FeatureType = "box") -> DesignFeatureDraft:
    return DesignFeatureDraft(kind, "L", None, "insert", handle, (xy,))


def route(handle: str, *coords: tuple[float, float]) -> DesignFeatureDraft:
    return DesignFeatureDraft("route", "R", None, "curve", handle, coords)


def label(
    value: str | None, xy: tuple[float, float], height: float = 1.0, handle: str = "T"
) -> LinkText:
    return LinkText(handle, "CAP", xy, height, value or "raw?", value, value is not None)


def test_constants_mirror_the_shared_contract() -> None:
    assert (LINK_RADIUS_TEXT_HEIGHTS, LINK_MIN_RADIUS_M) == (15, 1.0)
    assert Decimal("0.8") == AUTO_LINK_MIN_CONFIDENCE
    assert TEXT_LINK_TARGETS["cable"] == ("route",) and TEXT_LINK_TARGETS["box_bpu"] == ("box",)
    assert TEXT_LINK_TARGETS["unreadable"] == ("route", "box", "hhi", "joint", "mh")


@pytest.mark.parametrize(
    ("value", "kind"),
    [
        ("F 36 C", "cable"),
        ("f144c", "cable"),
        ("  F 36 C  ", "cable"),
        ("1X2Way16/12", "duct"),
        ("2 x 1 way", "duct"),
        ("150.0M", "length"),
        ("12 m", "length"),
        ("1-1", "box_id"),
        ("12 - 3", "box_id"),
        ("3B", "box_bpu"),
        ("12 u", "box_bpu"),
        ("F 36 C extra", "other"),
        ("1-1a", "other"),
        ("\u0661-\u0661", "other"),  # Arabic-Indic digits: JS `\d` is ASCII only
        ("150.M", "other"),
        ("12 m\n", "length"),  # trimmed first
        ("", "other"),
        ("مقابر", "other"),
    ],
)
def test_classification_patterns(value: str, kind: str) -> None:
    assert classify_link_text(value) == kind


def test_confidence_formula() -> None:
    assert link_confidence(0.0, None, 1.0) == Decimal("1.000")
    assert link_confidence(0.5, None, 1.0) == Decimal("0.750")
    assert link_confidence(1.0, 2.0, 4.0) == Decimal("0.625")  # 0.5*0.75 + 0.5*0.5
    assert link_confidence(1.0, 1.0, 4.0) == Decimal("0.375")  # tie: uniqueness 0
    assert link_confidence(0.0, 0.0, 4.0) == Decimal("0.500")  # same spot: ambiguous
    assert link_confidence(4.0, None, 4.0) == Decimal("0.500")  # at the edge of the radius


def test_radius_from_text_height_with_minimum() -> None:
    assert link_radius_m(0.1) == pytest.approx(1.5)
    assert link_radius_m(0.0) == 1.0
    assert link_radius_m(0.05) == 1.0


def test_single_close_candidate_is_auto() -> None:
    (link,) = link_texts([label("1-1", (0.1, 0))], [point("B1", (0, 0))])
    assert (link.kind, link.status, link.feature) == ("box_id", "auto", ("insert", "B1"))
    assert link.distance_m == Decimal("0.100")
    assert link.confidence == Decimal("0.997")  # 0.5*(1-0.1/15) + 0.5*1


def test_nearest_candidate_wins_and_the_second_lowers_confidence() -> None:
    features = [point("FAR", (3, 0)), point("NEAR", (1, 0))]
    (link,) = link_texts([label("1-1", (0, 0))], features)
    assert link.feature == ("insert", "NEAR")
    # radius 15: 0.5*(1-1/15) + 0.5*(1-1/3) = 0.8
    assert link.confidence == Decimal("0.800") and link.status == "auto"


def test_threshold_boundary_is_inclusive_and_below_needs_review() -> None:
    features = [point("A", (1, 0)), point("B", (2.9, 0))]
    (link,) = link_texts([label("1-1", (0, 0))], features)
    assert link.confidence < AUTO_LINK_MIN_CONFIDENCE and link.status == "review"
    assert link.feature == ("insert", "A")  # proposal kept for the reviewer


def test_two_equally_near_candidates_need_review() -> None:
    (link,) = link_texts([label("1-1", (0, 0))], [point("A", (1, 0)), point("B", (-1, 0))])
    assert link.status == "review" and link.confidence == Decimal("0.467")
    assert link.feature == ("insert", "A")  # deterministic tie-break by handle


def test_candidates_outside_the_radius_or_of_other_types_are_ignored() -> None:
    features = [point("FAR", (20, 0)), route("R", (0, 0.2), (5, 0.2))]
    (link,) = link_texts([label("1-1", (0, 0), height=1.0)], features)  # radius 15
    assert (link.status, link.feature, link.distance_m, link.confidence) == (
        "review",
        None,
        None,
        Decimal("0.000"),
    )


def test_route_distance_is_to_the_line() -> None:
    (link,) = link_texts(
        [label("F 36 C", (5, 1), height=0.2)], [route("R", (0, 0), (10, 0)), point("B", (5, 1))]
    )  # radius 3: the box on the text is not a route
    assert (link.kind, link.feature, link.distance_m) == ("cable", ("curve", "R"), Decimal("1.000"))


def test_small_text_uses_the_minimum_radius() -> None:
    near = link_texts([label("3B", (0, 0), height=0.01)], [point("B", (0.9, 0))])[0]
    far = link_texts([label("3B", (0, 0), height=0.01)], [point("B", (1.1, 0))])[0]
    assert near.feature == ("insert", "B") and far.feature is None


def test_other_texts_are_unlinked_and_unreadable_are_reviewed() -> None:
    features = [point("B", (0, 0))]
    other, unreadable = link_texts(
        [label("hello", (0, 0), handle="T1"), label(None, (0.1, 0), handle="T2")], features
    )
    assert (other.kind, other.status, other.feature) == ("other", "unlinked", None)
    assert (unreadable.kind, unreadable.status) == ("unreadable", "review")
    assert unreadable.feature == ("insert", "B")  # nearest proposed, text never guessed
    assert unreadable.text.text is None


def test_no_features_at_all() -> None:
    (link,) = link_texts([label("1-1", (0, 0))], [])
    assert link.status == "review" and link.feature is None


def test_box_code_is_the_best_auto_box_id_link() -> None:
    features = [point("B1", (0, 0)), point("B2", (100, 0))]
    links = link_texts(
        [
            label("1-1", (0.1, 0), handle="T1"),
            label("1-2", (0.5, 0), handle="T2"),  # also near B1 but farther
            label("7B", (100, 0.1), handle="T3"),  # box_bpu: not a code
            label("2-5", (99, 0), handle="T4"),
            label("9-9", (98.5, 0), handle="T5"),  # also B2, lower confidence than T4
        ],
        features,
    )
    codes = box_codes(links, features)
    assert codes[("insert", "B1")] == "1-1"
    assert codes[("insert", "B2")] == "2-5"
    texts = linked_texts_by_kind(links)
    assert texts[("insert", "B2")]["box_bpu"] == ["7B"]


def test_review_links_never_set_a_code() -> None:
    features = [point("A", (1, 0)), point("B", (-1, 0))]
    links = link_texts([label("1-1", (0, 0))], features)
    assert box_codes(links, features) == {}


def test_status_counts_include_every_status() -> None:
    links = link_texts([label("hello", (0, 0)), label("1-1", (0, 0))], [point("B", (0, 0))])
    assert status_counts(links) == {
        "auto": 1,
        "review": 0,
        "confirmed": 0,
        "rejected": 0,
        "unlinked": 1,
    }
