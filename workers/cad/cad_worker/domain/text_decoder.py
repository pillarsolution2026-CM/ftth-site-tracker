"""Conservative decoding of drawing text (ADR-013 `readable` flag).

* Valid Unicode (ASCII, real Arabic) passes through with `readable=True`.
* Text in a legacy Arabic SHX font (xarb.shx ...) is ASCII key codes drawn as Arabic glyphs. It is
  decoded only through the owner-confirmed table in `shx_arabic.json`, and only if EVERY
  character is covered; otherwise `readable=False` and `text=None`.
* Mojibake (UTF-8 bytes read as a legacy code page, replacement or control characters) is
  `readable=False`.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from importlib import resources
from pathlib import PurePath

_PASSTHROUGH_IN_LEGACY = frozenset("0123456789 \t")
_PERCENT_CODES = {"d": "°", "p": "±", "c": "Ø", "%": "%"}
_PERCENT_RE = re.compile(r"%%([dDpPcC%uUoO]|\d{3})")
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f�-]")


@dataclass(frozen=True, slots=True)
class Decoded:
    text: str | None
    readable: bool


@dataclass(frozen=True, slots=True)
class ShxTable:
    fonts: frozenset[str] = frozenset()
    font_name_markers: tuple[str, ...] = ()
    mappings: dict[str, str] = field(default_factory=dict)

    @classmethod
    def load(cls) -> ShxTable:
        raw = resources.files("cad_worker.domain").joinpath("shx_arabic.json").read_text("utf-8")
        data = json.loads(raw)
        return cls(
            fonts=frozenset(str(f).lower() for f in data["fonts"]),
            font_name_markers=tuple(str(m).lower() for m in data["font_name_markers"]),
            mappings={str(k): str(v) for k, v in data["mappings"].items()},
        )

    def is_legacy_arabic(self, font: str | None) -> bool:
        if not font:
            return False
        name = PurePath(font.replace("\\", "/")).name.lower()
        if name in self.fonts:
            return True
        return name.endswith(".shx") and any(m in name for m in self.font_name_markers)


def _is_mojibake(text: str) -> bool:
    if _CONTROL_RE.search(text):
        return True
    if text.isascii():
        return False
    try:
        recovered = text.encode("cp1252").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return False
    return recovered != text and not recovered.isascii()


class TextDecoder:
    def __init__(self, table: ShxTable | None = None) -> None:
        self._table = table if table is not None else ShxTable.load()

    def is_legacy_font(self, font: str | None) -> bool:
        return self._table.is_legacy_arabic(font)

    def decode(self, plain: str, font: str | None = None) -> Decoded:
        """`plain` has MTEXT formatting already removed (the adapter does that)."""
        if self._table.is_legacy_arabic(font):
            return self._decode_legacy(plain)
        expanded = _expand_percent_codes(plain)
        if expanded is None or _is_mojibake(expanded):
            return Decoded(None, False)
        return Decoded(expanded, True)

    def _decode_legacy(self, plain: str) -> Decoded:
        out: list[str] = []
        for ch in plain:
            if ch in _PASSTHROUGH_IN_LEGACY:
                out.append(ch)
            elif ch in self._table.mappings:
                out.append(self._table.mappings[ch])
            else:
                return Decoded(None, False)
        return Decoded("".join(out), True)


def _expand_percent_codes(text: str) -> str | None:
    """AutoCAD `%%d` (degree), `%%p`, `%%c`, `%%%`; underline/overline toggles are dropped.

    `%%nnn` (character by code) depends on the font, so it makes the text unreadable (None).
    """
    if "%%" not in text:
        return text
    unknown = False

    def repl(match: re.Match[str]) -> str:
        nonlocal unknown
        code = match.group(1)
        if code.isdigit():
            unknown = True
            return ""
        return _PERCENT_CODES.get(code.lower(), "")

    result = _PERCENT_RE.sub(repl, text)
    return None if unknown else result
