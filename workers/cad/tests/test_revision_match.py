"""Revision matching and the diff (ADR-020). Pure."""

from __future__ import annotations

import itertools
import uuid
from decimal import Decimal

from cad_worker.domain.design import DesignFeatureDraft, FeatureType, SourceKind, Xy
from cad_worker.domain.revision_match import (
    BaseFeature,
    DiffEntry,
    RevisionMatch,
    diff_counts,
    match_revision,
)

IDS = [uuid.UUID(int=i) for i in range(1, 50)]


def new(
    handle: str, *coords: Xy, kind: FeatureType = "box", code: str | None = None
) -> DesignFeatureDraft:
    source: SourceKind = "curve" if kind == "route" else "insert"
    return DesignFeatureDraft(kind, "L", None, source, handle, coords, {}, code)


def old(
    n: int, handle: str, *coords: Xy, kind: FeatureType = "box", code: str | None = None
) -> BaseFeature:
    source: SourceKind = "curve" if kind == "route" else "insert"
    return BaseFeature(IDS[n], kind, code, source, handle, coords)


def run(features: list[DesignFeatureDraft], base: list[BaseFeature]) -> RevisionMatch:
    fresh = (uuid.UUID(int=1000 + i) for i in itertools.count())
    return match_revision(features, base, lambda: next(fresh))


def entry(result: RevisionMatch, handle: str) -> DiffEntry:
    return next(e for e in result.entries if e.key is not None and e.key[1] == handle)


def test_no_base_everything_is_added_with_new_ids() -> None:
    result = run([new("A", (0, 0)), new("R", (0, 0), (1, 0), kind="route")], [])
    assert {e.change for e in result.entries} == {"added"}
    assert result.new_ids == set(result.ids.values()) and len(result.new_ids) == 2


def test_unchanged_keeps_the_id() -> None:
    result = run([new("A", (10, 10), code="1-1")], [old(1, "A", (10, 10), code="1-1")])
    e = entry(result, "A")
    assert (e.change, e.feature_id, e.distance_m, e.previous_code) == (
        "unchanged",
        IDS[1],
        Decimal("0.000"),
        "1-1",
    )
    assert result.new_ids == frozenset()


def test_moved_point_keeps_the_id() -> None:
    result = run([new("A", (12, 10))], [old(1, "A", (10, 10))])
    e = entry(result, "A")
    assert (e.change, e.feature_id, e.distance_m) == ("moved", IDS[1], Decimal("2.000"))


def test_sub_millimetre_move_is_unchanged() -> None:
    result = run([new("A", (10.0004, 10))], [old(1, "A", (10, 10))])
    assert entry(result, "A").change == "unchanged"


def test_reshaped_route_by_hausdorff() -> None:
    result = run(
        [new("R", (0, 0), (50, 1), (100, 0), kind="route")],
        [old(1, "R", (0, 0), (50, 0), (100, 0), kind="route")],
    )
    e = entry(result, "R")
    assert (e.change, e.feature_id, e.distance_m) == ("reshaped", IDS[1], Decimal("1.000"))


def test_reversed_route_is_unchanged() -> None:
    result = run(
        [new("R2", (100, 0), (0, 0), kind="route")], [old(1, "R1", (0, 0), (100, 0), kind="route")]
    )
    assert entry(result, "R2").change == "unchanged"


def test_route_with_extra_collinear_detour_length_is_reshaped() -> None:
    # Same Hausdorff (0) but the length changes: a doubled-back segment.
    result = run(
        [new("R", (0, 0), (100, 0), (50, 0), (100, 0), kind="route")],
        [old(1, "R", (0, 0), (100, 0), kind="route")],
    )
    assert entry(result, "R").change == "reshaped"


def test_code_change_only_is_attributes_changed() -> None:
    result = run([new("A", (0, 0), code="1-2")], [old(1, "A", (0, 0), code="1-1")])
    e = entry(result, "A")
    assert (e.change, e.code, e.previous_code) == ("attributes_changed", "1-2", "1-1")


def test_far_move_without_code_is_removed_and_added() -> None:
    result = run([new("A", (20, 0))], [old(1, "B", (0, 0))])
    assert entry(result, "A").change == "added"
    removed = [e for e in result.entries if e.change == "removed"]
    assert [(e.feature_id, e.key) for e in removed] == [(IDS[1], None)]
    assert diff_counts(result.entries) == {
        "added": 1,
        "removed": 1,
        "unchanged": 0,
        "moved": 0,
        "reshaped": 0,
        "attributes_changed": 0,
        "conflict": 0,
    }


def test_unique_code_matches_beyond_the_tolerance() -> None:
    result = run([new("X", (50, 0), code="3-1")], [old(1, "Y", (0, 0), code="3-1")])
    e = entry(result, "X")
    assert (e.change, e.feature_id, e.distance_m) == ("moved", IDS[1], Decimal("50.000"))


def test_duplicate_codes_do_not_match_by_code() -> None:
    result = run(
        [new("X", (50, 0), code="3-1"), new("Z", (80, 0), code="3-1")],
        [old(1, "Y", (0, 0), code="3-1")],
    )
    assert entry(result, "X").change == "added" and entry(result, "Z").change == "added"


def test_same_handle_has_priority_over_a_nearer_feature() -> None:
    result = run([new("A", (0, 0))], [old(1, "A", (3, 0)), old(2, "B", (0.5, 0))])
    e = entry(result, "A")
    assert (e.change, e.feature_id) == ("moved", IDS[1])
    assert [x.feature_id for x in result.entries if x.change == "removed"] == [IDS[2]]


def test_same_handle_beyond_tolerance_is_not_a_match() -> None:
    result = run([new("A", (0, 0))], [old(1, "A", (30, 0)), old(2, "B", (1, 0))])
    assert entry(result, "A").feature_id == IDS[2]


def test_conflict_when_another_candidate_is_almost_as_near() -> None:
    result = run([new("N", (0, 0))], [old(1, "P", (1.0, 0)), old(2, "Q", (-1.3, 0))])
    e = entry(result, "N")
    assert (e.change, e.feature_id, e.candidate_ids) == ("conflict", IDS[1], (IDS[2],))
    assert e.distance_m == Decimal("1.000")


def test_no_conflict_when_the_second_is_clearly_farther() -> None:
    result = run([new("N", (0, 0))], [old(1, "P", (1.0, 0)), old(2, "Q", (-1.6, 0))])
    assert entry(result, "N").change == "moved"


def test_greedy_matching_by_ascending_distance() -> None:
    # A is nearest to P; B then takes Q even though P is nearer to it as well.
    result = run(
        [new("A", (0, 0)), new("B", (2, 0))],
        [old(1, "P", (0.2, 0)), old(2, "Q", (4.0, 0))],
    )
    assert entry(result, "A").feature_id == IDS[1]
    b = entry(result, "B")
    assert b.feature_id == IDS[2] and b.change == "moved"


def test_types_never_cross_match() -> None:
    result = run([new("A", (0, 0), kind="hhi")], [old(1, "A", (0, 0), kind="box")])
    assert entry(result, "A").change == "added"
    assert [e.feature_type for e in result.entries if e.change == "removed"] == ["box"]


def test_extended_route_keeps_its_id() -> None:
    """Regression from the 1b end-to-end run: a 80 m route extended to 90 m (Hausdorff 10 m) was
    reported as removed + added and lost its id."""
    result = run(
        [new("R2", (100, 0), (100, 90), kind="route")],
        [old(1, "R1", (100, 0), (100, 80), kind="route")],
    )
    e = entry(result, "R2")
    assert (e.change, e.feature_id, e.distance_m) == ("reshaped", IDS[1], Decimal("0.000"))
    assert result.new_ids == frozenset()


def test_shortened_route_keeps_its_id() -> None:
    result = run(
        [new("R2", (0, 0), (85, 0), kind="route")],
        [old(1, "R1", (0, 0), (100, 0), kind="route")],
    )
    assert entry(result, "R2").feature_id == IDS[1]


def test_route_overlapping_only_a_small_part_is_a_new_route() -> None:
    """A new 100 m route that shares only its first 20 m with an old one is not the same route."""
    result = run(
        [new("R2", (0, 0), (20, 0), (20, 80), kind="route")],
        [old(1, "R1", (0, 0), (100, 0), kind="route")],
    )
    assert entry(result, "R2").change == "added"
