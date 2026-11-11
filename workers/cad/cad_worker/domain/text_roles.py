"""Text roles (ADR-041, reading ADR-040 B/C). Pure.

Mirror of `packages/shared/src/cad/text-roles.ts` — change both together; the test table of
`text-roles.spec.ts` is ported to `tests/test_text_roles.py`. A layer rule carries `textRoles`
(what its texts mean); every readable text on that layer is read with the patterns of those roles,
the FIRST role in TEXT_ROLES order (among the layer's roles) whose pattern matches the whole
trimmed text. No match = the text means nothing (never guessed).

JavaScript regular expressions differ from Python's: `\\d` is ASCII-only in JS (spelled `[0-9]`
here), `\\s` / `trim()` use the JS white-space set (`_WS`), the `i` flag folds ASCII letters only
(`re.ASCII`), `\\b` is an ASCII word boundary and the anchors are replaced by `fullmatch`.
"""

from __future__ import annotations

import re
from collections.abc import Collection, Mapping
from dataclasses import dataclass
from typing import Literal

from cad_worker.domain.design import FeatureType

TextRole = Literal[
    "cable_spare",
    "bundle_spare",
    "cable_label",
    "bundle_label",
    "box_cable_type",
    "box_cable_length",
    "box_cabinet",
    "box_number",
    "handhole_type",
    "handhole_number",
    "cabinet_info",
]
TEXT_ROLES: tuple[TextRole, ...] = (
    "cable_spare",
    "bundle_spare",
    "cable_label",
    "bundle_label",
    "box_cable_type",
    "box_cable_length",
    "box_cabinet",
    "box_number",
    "handhole_type",
    "handhole_number",
    "cabinet_info",
)

TEXT_ROLE_FEATURE: Mapping[TextRole, FeatureType] = {
    "cable_spare": "route",
    "bundle_spare": "route",
    "cable_label": "route",
    "bundle_label": "route",
    "box_cable_type": "box",
    "box_cable_length": "box",
    "box_cabinet": "box",
    "box_number": "box",
    "handhole_type": "hhi",
    "handhole_number": "hhi",
    "cabinet_info": "cabinet",
}

DrawingKind = Literal["general", "secondary"]
DRAWING_KINDS: tuple[DrawingKind, ...] = ("general", "secondary")

TEXT_ROLES_BY_KIND: Mapping[DrawingKind, tuple[TextRole, ...]] = {
    "general": (
        "cable_spare",
        "cable_label",
        "bundle_label",
        "handhole_type",
        "handhole_number",
        "cabinet_info",
    ),
    "secondary": (
        "bundle_spare",
        "bundle_label",
        "box_cable_type",
        "box_cable_length",
        "box_cabinet",
        "box_number",
        "cabinet_info",
    ),
}

MAX_BUNDLE_WAYS = 288


def text_role_fits_target(role: TextRole, target: str) -> bool:
    """A layer rule may carry a role when its target is `label` or the role's feature type."""
    return target == "label" or TEXT_ROLE_FEATURE[role] == target


# ---------- handhole types (owner list, ADR-040) ----------

HandholeType = Literal["DH", "HH-I", "HH-II", "MH-I", "MH-II", "MH-III", "MH-IV"]
HANDHOLE_TYPES: tuple[HandholeType, ...] = (
    "DH",
    "HH-I",
    "HH-II",
    "MH-I",
    "MH-II",
    "MH-III",
    "MH-IV",
)
_HANDHOLE_TYPE_ALIASES: Mapping[str, HandholeType] = {
    "DH": "DH",
    "HHI": "HH-I",
    "HH1": "HH-I",
    "HHII": "HH-II",
    "CH": "HH-II",
    "MHI": "MH-I",
    "MHII": "MH-II",
    "MHIII": "MH-III",
    "MHIV": "MH-IV",
}

# JavaScript `\s` (and the characters `String.prototype.trim` removes).
_WS_CODES = (0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, *range(0x2000, 0x200B))
_WS_CHARS = "".join(map(chr, (*_WS_CODES, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF)))
_WS = "[" + re.escape(_WS_CHARS) + "]"
_WS_RUN = re.compile(_WS + "+")
_WS_OR_HYPHEN_RUN = re.compile("[" + re.escape(_WS_CHARS) + "-]+")


def js_trim(value: str) -> str:
    return value.strip(_WS_CHARS)


def handhole_type_of(written: str) -> HandholeType | None:
    key = _WS_OR_HYPHEN_RUN.sub("", js_trim(written).upper())
    return _HANDHOLE_TYPE_ALIASES.get(key)


# ---------- reading one text ----------

CabinetInfoField = Literal["name", "type", "box_count", "ports"]
CABINET_INFO_FIELDS: tuple[CabinetInfoField, ...] = ("name", "type", "box_count", "ports")


@dataclass(frozen=True, slots=True)
class RoleReading:
    """One read text. Only the fields of its role are set (see `text-roles.ts` RoleReading)."""

    role: TextRole
    cores: int | None = None
    count: int | None = None
    duct_size: str | None = None
    length_m: str | None = None  # WrittenLength: metres with 3 decimals
    ways: int | None = None
    cabinet: str | None = None
    number: str | None = None
    handhole_type: HandholeType | None = None
    written: str | None = None
    field: CabinetInfoField | None = None
    value: str | None = None


_S = _WS + "*"
_NUM = r"[0-9]+(?:\.[0-9]+)?"
_LEN = rf"({_NUM}){_S}M"
_DUCT = rf"({_NUM}){_S}/{_S}({_NUM})"
# JS `\b` after `s?`: an ASCII word character must not follow.
_JS_WORD_END = r"(?![A-Za-z0-9_])"


def _re(source: str) -> re.Pattern[str]:
    return re.compile(source, re.IGNORECASE | re.ASCII)


_P_CABLE_SPARE = _re(rf"SP{_S}([0-9]+)")
_P_BUNDLE_SPARE = _re(rf"SP{_S}([0-9]+){_S}\({_S}{_DUCT}{_S}\)")
_P_CABLE = _re(rf"(?:{_LEN}{_S}/{_S})?([0-9]+){_S}-?{_S}Cores?{_JS_WORD_END}.*")
# «4way 16/12», «500M/4way 16/12», «450m/1x4 way 16/12» (one bundle of 4 ways).
_P_BUNDLE = _re(
    rf"(?:{_LEN}{_S}/{_S})?(?:[0-9]+{_S}x{_S})?([0-9]+){_S}-?{_S}ways?(?:{_WS}+{_DUCT})?"
)
_P_LENGTH_ONLY = _re(_LEN)
_P_BOX_CABLE_TYPE = _re(rf"F{_S}([0-9]+){_S}C")
_P_CABINET_NAME = _re(rf"([0-9]+){_S}-{_S}([0-9]+)")
_P_BOX_NUMBER = _re(r"([0-9]{1,4})")
# Letters with at most one digit or a Roman numeral: «HH1», «MH-IV», «XX». Not «CH01».
_P_HANDHOLE_TYPE_LIKE = _re(rf"[A-Z]{{1,3}}(?:[{re.escape(_WS_CHARS)}-]?(?:[IVX]{{1,4}}|[0-9]))?")
# «04A», «CH01», «12».
_P_HANDHOLE_NUMBER = _re(rf"[A-Z]{{0,3}}[{re.escape(_WS_CHARS)}-]?[0-9]{{1,4}}[A-Z]?")
_P_CABINET_TYPE = _re(rf"([0-9]+){_S}U")
_P_CABINET_BOXES = _re(rf"([0-9]+){_S}B")
_P_CABINET_PORTS = _re(rf"([0-9]+){_S}P")


def written_metres3(written: str) -> str:
    """ "10.0" -> "10.000"; more than 3 decimals rounds half up (strings only, never floats)."""
    int_part, _, frac = written.partition(".")
    int_part = int_part or "0"
    if len(frac) <= 3:
        return f"{int(int_part)}.{frac.ljust(3, '0')}"
    scaled = int(int_part + frac[:3]) + (1 if int(frac[3]) >= 5 else 0)
    digits = str(scaled).rjust(4, "0")
    return f"{digits[:-3]}.{digits[-3:]}"


def _duct(outer: str, inner: str) -> str:
    return f"{outer}/{inner}"


def _cabinet_name(a: str, b: str) -> str:
    return f"{int(a)}-{int(b)}"


def _read_as(role: TextRole, value: str) -> RoleReading | None:
    if role == "cable_spare":
        m = _P_CABLE_SPARE.fullmatch(value)
        return RoleReading(role, cores=int(m[1])) if m else None
    if role == "bundle_spare":
        m = _P_BUNDLE_SPARE.fullmatch(value)
        return RoleReading(role, count=int(m[1]), duct_size=_duct(m[2], m[3])) if m else None
    if role == "cable_label":
        m = _P_CABLE.fullmatch(value)
        if not m:
            return None
        return RoleReading(role, cores=int(m[2]), length_m=written_metres3(m[1]) if m[1] else None)
    if role == "bundle_label":
        m = _P_BUNDLE.fullmatch(value)
        if m:
            return RoleReading(
                role,
                ways=int(m[2]),
                duct_size=_duct(m[3], m[4]) if m[3] and m[4] else None,
                length_m=written_metres3(m[1]) if m[1] else None,
            )
        # Secondary: the length is a text of its own next to the type («10.0M»).
        m = _P_LENGTH_ONLY.fullmatch(value)
        return RoleReading(role, length_m=written_metres3(m[1])) if m else None
    if role == "box_cable_type":
        m = _P_BOX_CABLE_TYPE.fullmatch(value)
        return RoleReading(role, cores=int(m[1])) if m else None
    if role == "box_cable_length":
        m = _P_LENGTH_ONLY.fullmatch(value)
        return RoleReading(role, length_m=written_metres3(m[1])) if m else None
    if role == "box_cabinet":
        m = _P_CABINET_NAME.fullmatch(value)
        return RoleReading(role, cabinet=_cabinet_name(m[1], m[2])) if m else None
    if role == "box_number":
        m = _P_BOX_NUMBER.fullmatch(value)
        return RoleReading(role, number=m[1]) if m else None
    if role == "handhole_type":
        hh_type = handhole_type_of(value)
        if hh_type is not None:
            return RoleReading(role, handhole_type=hh_type, written=value)
        if _P_HANDHOLE_TYPE_LIKE.fullmatch(value):
            return RoleReading(role, written=value)
        return None
    if role == "handhole_number":
        if _P_HANDHOLE_NUMBER.fullmatch(value):
            return RoleReading(role, number=_WS_RUN.sub("", value.upper()))
        return None
    # cabinet_info
    if m := _P_CABINET_NAME.fullmatch(value):
        return RoleReading(role, field="name", value=_cabinet_name(m[1], m[2]))
    if m := _P_CABINET_TYPE.fullmatch(value):
        return RoleReading(role, field="type", value=f"{m[1]}U")
    if m := _P_CABINET_BOXES.fullmatch(value):
        return RoleReading(role, field="box_count", value=m[1])
    if m := _P_CABINET_PORTS.fullmatch(value):
        return RoleReading(role, field="ports", value=m[1])
    return None


def read_role_text(text: str, roles: Collection[str]) -> RoleReading | None:
    """The first role (TEXT_ROLES order, among `roles`) whose pattern matches the whole trimmed
    text; None = the text means nothing for these roles."""
    value = js_trim(text)
    if value == "":
        return None
    for role in TEXT_ROLES:
        if role not in roles:
            continue
        reading = _read_as(role, value)
        if reading is not None:
            return reading
    return None


# ---------- identities ----------


def cabinet_name_key(name: str) -> str:
    """Cabinets are matched by name across the two drawings: «1 - 7» = «1-7»."""
    return _WS_RUN.sub("", js_trim(name).upper())


def box_code(cabinet: str, number: str) -> str:
    """A Secondary box's identity (feature `code`): cabinet 1-3, box 9 -> "1-3/9"."""
    return f"{cabinet_name_key(cabinet)}/{js_trim(number)}"


_P_WAYS_IN_NAME = re.compile(
    rf"([0-9]+){_S}-?{_S}w(?:ays?)?{_JS_WORD_END}", re.IGNORECASE | re.ASCII
)


def suggest_bundle_ways(name: str) -> int | None:
    """Ways suggested from a route layer name («1X12w Line» -> 12); None when it says nothing."""
    m = _P_WAYS_IN_NAME.search(name)
    if not m:
        return None
    ways = int(m[1])
    return ways if 1 <= ways <= MAX_BUNDLE_WAYS else None
