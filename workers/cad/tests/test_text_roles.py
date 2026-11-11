"""The same test table as `packages/shared/src/cad/text-roles.spec.ts` (ADR-041)."""

from __future__ import annotations

import time

import pytest

from cad_worker.domain.text_roles import (
    MAX_DUCT_SIZE_LENGTH,
    MAX_READ_CORES,
    MAX_READ_COUNT,
    MAX_ROLE_TEXT_LENGTH,
    MAX_WRITTEN_LENGTH_M,
    TEXT_ROLES,
    TEXT_ROLES_BY_KIND,
    RoleReading,
    box_code,
    cabinet_name_key,
    handhole_type_of,
    read_role_text,
    suggest_bundle_ways,
    text_role_fits_target,
    written_metres3,
)

NBSP = chr(0xA0)


def test_reads_the_secondary_box_texts() -> None:
    assert read_role_text("9", ["box_number"]) == RoleReading("box_number", number="9")
    assert read_role_text(" 1 - 3 ", ["box_cabinet"]) == RoleReading("box_cabinet", cabinet="1-3")
    assert read_role_text("F4C", ["box_cable_type"]) == RoleReading("box_cable_type", cores=4)
    assert read_role_text("398M", ["box_cable_length"]) == RoleReading(
        "box_cable_length", length_m="398.000"
    )


def test_reads_secondary_bundle_labels_type_and_length_apart() -> None:
    assert read_role_text("1way 7/3.5", ["bundle_label"]) == RoleReading(
        "bundle_label", ways=1, duct_size="7/3.5", length_m=None
    )
    reading = read_role_text("12way 7/3.5", ["bundle_label"])
    assert reading is not None and reading.ways == 12
    assert read_role_text("455.0M", ["bundle_label"]) == RoleReading(
        "bundle_label", ways=None, duct_size=None, length_m="455.000"
    )


def test_reads_spares_on_a_bundle_and_on_a_cable() -> None:
    assert read_role_text("SP3(7/3.5)", ["bundle_spare"]) == RoleReading(
        "bundle_spare", count=3, duct_size="7/3.5"
    )
    assert read_role_text("SP 48", ["cable_spare"]) == RoleReading("cable_spare", cores=48)


def test_reads_the_general_segment_labels_on_one_layer_with_several_roles() -> None:
    exch = ["bundle_label", "cable_label", "cable_spare"]
    assert read_role_text("500M/4way 16/12", exch) == RoleReading(
        "bundle_label", ways=4, duct_size="16/12", length_m="500.000"
    )
    assert read_role_text("520M/144Core F.O(elfath)", exch) == RoleReading(
        "cable_label", cores=144, length_m="520.000"
    )
    assert read_role_text("SP 48", exch) == RoleReading("cable_spare", cores=48)
    assert read_role_text("street name", exch) is None
    # Al-Fath General writes one bundle as «1x4 way» (one bundle of 4 ways).
    assert read_role_text("450m/1x4 way 16/12", exch) == RoleReading(
        "bundle_label", ways=4, duct_size="16/12", length_m="450.000"
    )


def test_reads_handholes_type_list_first_then_the_number() -> None:
    roles = ["handhole_number", "handhole_type"]
    assert read_role_text("04A", roles) == RoleReading("handhole_number", number="04A")
    assert read_role_text("CH01", roles) == RoleReading("handhole_number", number="CH01")
    assert read_role_text("HH1", roles) == RoleReading(
        "handhole_type", handhole_type="HH-I", written="HH1"
    )
    for written, expected in (("DH", "DH"), ("CH", "HH-II"), ("MH-IV", "MH-IV")):
        reading = read_role_text(written, roles)
        assert reading is not None and reading.handhole_type == expected
    # Looks like a type, not in the list -> HANDHOLE_TYPE_UNKNOWN later.
    assert read_role_text("HH3", roles) == RoleReading(
        "handhole_type", handhole_type=None, written="HH3"
    )


def test_reads_the_cabinet_circle_texts() -> None:
    def r(text: str) -> RoleReading | None:
        return read_role_text(text, ["cabinet_info"])

    assert r("1-7") == RoleReading("cabinet_info", field="name", value="1-7")
    assert r("22U") == RoleReading("cabinet_info", field="type", value="22U")
    assert r("22B") == RoleReading("cabinet_info", field="box_count", value="22")
    assert r("2P") == RoleReading("cabinet_info", field="ports", value="2")
    assert r("Joint 144") is None


def test_ignores_roles_the_layer_does_not_carry_and_empty_texts() -> None:
    assert read_role_text("9", ["box_cabinet"]) is None
    assert read_role_text("   ", TEXT_ROLES) is None


@pytest.mark.parametrize(
    ("written", "expected"),
    [
        ("10", "10.000"),
        ("10.0", "10.000"),
        ("0455.5", "455.500"),
        ("12.3456", "12.346"),
        ("0.0004", "0.000"),
    ],
)
def test_normalises_written_lengths_to_3_decimals_without_floats(
    written: str, expected: str
) -> None:
    assert written_metres3(written) == expected


def test_fits_roles_to_label_layers_or_their_own_feature_layer_only() -> None:
    assert text_role_fits_target("cabinet_info", "label")
    assert text_role_fits_target("cabinet_info", "cabinet")
    assert not text_role_fits_target("cabinet_info", "box")
    assert text_role_fits_target("bundle_label", "route")


def test_splits_roles_by_drawing_kind() -> None:
    assert "box_number" in TEXT_ROLES_BY_KIND["secondary"]
    assert "box_number" not in TEXT_ROLES_BY_KIND["general"]
    assert "handhole_type" in TEXT_ROLES_BY_KIND["general"]
    assert "cable_label" not in TEXT_ROLES_BY_KIND["secondary"]


def test_matches_handhole_types_and_cabinet_names_loosely_builds_box_codes() -> None:
    assert handhole_type_of(" hh-ii ") == "HH-II"
    assert handhole_type_of("HH2") is None
    assert cabinet_name_key(" 1 - 7 ") == cabinet_name_key("1-7")
    assert box_code("1-3", " 9 ") == "1-3/9"


def test_suggests_ways_from_a_layer_name() -> None:
    assert suggest_bundle_ways("1X12w Line") == 12
    assert suggest_bundle_ways("OUTER DUCT 4 WAY PRIMARY") == 4
    assert suggest_bundle_ways("Single 1w Line") == 1
    assert suggest_bundle_ways("CABINA") is None


def test_javascript_semantics_digits_case_and_spaces() -> None:
    # `\d` is ASCII in JS: Arabic-Indic digits are not a box number.
    assert read_role_text(chr(0x669), ["box_number"]) is None
    # Case-insensitive, JS white space (no-break space) inside and around.
    assert read_role_text(NBSP + "sp" + NBSP + "3(7/3.5)" + NBSP, ["bundle_spare"]) == RoleReading(
        "bundle_spare", count=3, duct_size="7/3.5"
    )
    assert read_role_text("25.0m", ["bundle_label"]) == RoleReading(
        "bundle_label", length_m="25.000"
    )
    # `\b` after Core(s): a letter right after is not a cable label.
    assert read_role_text("12Coresx", ["cable_label"]) is None
    assert read_role_text("12-core", ["cable_label"]) == RoleReading("cable_label", cores=12)
    # A trailing newline is not accepted by `fullmatch` (JS `$` without the m flag).
    assert read_role_text("9\nx", ["box_number"]) is None


# ---------- security review (ADR-041): bounded reading ----------


@pytest.mark.parametrize("role", ["cable_label", "bundle_label"])
def test_a_long_run_of_spaces_cannot_backtrack(role: str) -> None:
    """ReDoS: «1» + 1998 spaces + «Z» once took cubic time in the `\\s*-?\\s*` patterns."""
    for evil in ("1" + " " * 1998 + "Z", "1" + " " * 60 + "Z"):
        start = time.perf_counter()
        assert read_role_text(evil, [role]) is None
        assert time.perf_counter() - start < 0.005


def test_ways_in_a_layer_name_cannot_backtrack() -> None:
    start = time.perf_counter()
    assert suggest_bundle_ways("1" + " " * 5000 + "Z") is None
    assert time.perf_counter() - start < 0.05


def test_an_optional_hyphen_between_spaces_still_reads() -> None:
    assert read_role_text("12 - Cores", ["cable_label"]) == RoleReading("cable_label", cores=12)
    assert read_role_text("12 -Core", ["cable_label"]) == RoleReading("cable_label", cores=12)
    assert read_role_text("12- Core", ["cable_label"]) == RoleReading("cable_label", cores=12)
    assert read_role_text("4 - way", ["bundle_label"]) == RoleReading("bundle_label", ways=4)
    assert read_role_text("4 way", ["bundle_label"]) == RoleReading("bundle_label", ways=4)
    assert read_role_text("4--way", ["bundle_label"]) is None
    assert suggest_bundle_ways("1X12 - w Line") == 12


def test_texts_longer_than_64_characters_are_not_read() -> None:
    assert MAX_ROLE_TEXT_LENGTH == 64
    fits = "520M/144Core " + "x" * (64 - 13)
    assert len(fits) == 64
    assert read_role_text(fits, ["cable_label"]) == RoleReading(
        "cable_label", cores=144, length_m="520.000"
    )
    assert read_role_text(fits + "x", ["cable_label"]) is None
    # Trimmed first: surrounding spaces do not count.
    assert read_role_text("  " + fits + "  ", ["cable_label"]) is not None
    # Counted as JavaScript does (UTF-16 code units): an astral character counts 2.
    astral = "520M/144Core " + "x" * (64 - 14) + chr(0x1F600)
    assert len(astral) == 64
    assert read_role_text(astral, ["cable_label"]) is None


def test_core_counts_and_counts_above_the_cap_are_not_read() -> None:
    assert MAX_READ_CORES == 10_000
    assert MAX_READ_COUNT == 10_000
    assert read_role_text("SP 10000", ["cable_spare"]) == RoleReading("cable_spare", cores=10_000)
    assert read_role_text("SP 10001", ["cable_spare"]) is None
    assert read_role_text("10001Core", ["cable_label"]) is None
    assert read_role_text("F10001C", ["box_cable_type"]) is None
    assert read_role_text("F" + "9" * 60 + "C", ["box_cable_type"]) is None
    assert read_role_text("SP10001(7/3.5)", ["bundle_spare"]) is None
    assert read_role_text("10001B", ["cabinet_info"]) is None
    assert read_role_text("10001P", ["cabinet_info"]) is None
    assert read_role_text("10000P", ["cabinet_info"]) == RoleReading(
        "cabinet_info", field="ports", value="10000"
    )


def test_duct_sizes_longer_than_32_characters_are_not_read() -> None:
    assert MAX_DUCT_SIZE_LENGTH == 32
    fits = "1" * 15 + "/" + "2" * 16
    assert len(fits) == 32
    reading = read_role_text("4way " + fits, ["bundle_label"])
    assert reading is not None and reading.duct_size == fits
    assert read_role_text("4way " + fits + "2", ["bundle_label"]) is None
    assert read_role_text("SP3(" + fits + "2)", ["bundle_spare"]) is None


def test_written_lengths_above_a_million_metres_are_not_read() -> None:
    assert MAX_WRITTEN_LENGTH_M == 1_000_000
    assert read_role_text("1000000M", ["box_cable_length"]) == RoleReading(
        "box_cable_length", length_m="1000000.000"
    )
    assert read_role_text("1000000.0004M", ["box_cable_length"]) is not None
    assert read_role_text("1000000.001M", ["box_cable_length"]) is None
    assert read_role_text("1000001M", ["bundle_label"]) is None
    assert read_role_text("1000001M/4way 16/12", ["bundle_label"]) is None
    assert read_role_text("1000001M/144Core", ["cable_label"]) is None
    assert read_role_text("9" * 40 + "." + "9" * 18 + "M", ["box_cable_length"]) is None
