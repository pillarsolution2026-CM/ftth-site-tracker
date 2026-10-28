import pytest

from cad_worker.domain.text_decoder import Decoded, ShxTable, TextDecoder
from tests.support.dxf_samples import ARABIC, LEGACY_SHX, MOJIBAKE


@pytest.fixture
def decoder() -> TextDecoder:
    return TextDecoder()


# Lowercase keys of the Windows Arabic 101 layout, confirmed by the owner on 2026-10-28 (ADR-019).
ARABIC_101_LOWERCASE = "qwertyuiop[]asdfghjkl;'zxcvbnm,./"


def test_default_table_is_the_confirmed_lowercase_arabic_101_layout() -> None:
    table = ShxTable.load()
    assert set(table.mappings) == set(ARABIC_101_LOWERCASE)
    assert len(table.mappings) == 33
    assert table.mappings["q"] == "ض" and table.mappings["/"] == "ظ" and table.mappings["b"] == "لا"
    assert "`" not in table.mappings  # ذ: not observed in the drawings, deliberately absent
    assert not any(k.isupper() for k in table.mappings)
    assert table.is_legacy_arabic("xarb.shx")
    assert table.is_legacy_arabic("C:\\Fonts\\XARAB.SHX")
    assert not table.is_legacy_arabic("arial.ttf")
    assert not table.is_legacy_arabic("ROMANT.SHX")
    assert not table.is_legacy_arabic(None)


@pytest.mark.parametrize(
    ("raw", "decoded"),
    [("lrhfv", "مقابر"), (",vam", "ورشة"), ("fg,; 5", "بلوك 5"), ("lk,v", "منور")],
)
def test_legacy_arabic_shx_lowercase_keys_are_decoded(
    decoder: TextDecoder, raw: str, decoded: str
) -> None:
    assert decoder.decode(raw, "xarb.shx") == Decoded(decoded, True)


@pytest.mark.parametrize("raw", ["ahvU", "Hlrhfv", "lrhfvF", "`lr", "lr!"])
def test_any_key_outside_the_table_keeps_the_text_unreadable(
    decoder: TextDecoder, raw: str
) -> None:
    """Upper-case keys select other glyph forms that are not confirmed: never guessed."""
    assert decoder.decode(raw, "xarb.shx") == Decoded(None, False)


@pytest.mark.parametrize("text", ["F 36 C", "190.0M", "1X2Way16/12", "", "  "])
def test_ascii_passes_through(decoder: TextDecoder, text: str) -> None:
    assert decoder.decode(text, "arial.ttf") == Decoded(text, True)


def test_real_arabic_passes_through(decoder: TextDecoder) -> None:
    assert decoder.decode(ARABIC, "arial.ttf") == Decoded(ARABIC, True)
    assert decoder.decode(ARABIC, None) == Decoded(ARABIC, True)


def test_roman_shx_ascii_is_readable(decoder: TextDecoder) -> None:
    assert decoder.decode("3003", "ROMANT.SHX") == Decoded("3003", True)


def test_legacy_arabic_shx_text_with_uppercase_is_unreadable(decoder: TextDecoder) -> None:
    assert decoder.decode("ahvU sud]fhah", "xarab.shx") == Decoded(None, False)
    assert decoder.decode(LEGACY_SHX, "arial.ttf") == Decoded(LEGACY_SHX, True)  # not a legacy font


def test_legacy_font_digits_and_spaces_only_stay_readable(decoder: TextDecoder) -> None:
    assert decoder.decode("12 34", "xarb.shx") == Decoded("12 34", True)
    assert decoder.decode("", "xarb.shx") == Decoded("", True)


def test_mojibake_is_unreadable(decoder: TextDecoder) -> None:
    assert decoder.decode(MOJIBAKE, "arial.ttf") == Decoded(None, False)
    assert decoder.decode("bad \ufffd char", None) == Decoded(None, False)
    assert decoder.decode("ctrl \x01", None) == Decoded(None, False)


def test_legitimate_latin_accents_are_not_mojibake(decoder: TextDecoder) -> None:
    assert decoder.decode("Éléctricité", "arial.ttf") == Decoded("Éléctricité", True)


def test_percent_codes(decoder: TextDecoder) -> None:
    assert decoder.decode("45%%d", None) == Decoded("45\u00b0", True)
    assert decoder.decode("%%c20 %%p1 %%%", None) == Decoded("\u00d820 \u00b11 %", True)
    assert decoder.decode("%%uunder%%o", None) == Decoded("under", True)
    assert decoder.decode("x%%141", None) == Decoded(None, False)


def test_table_is_extensible_but_requires_full_coverage() -> None:
    table = ShxTable(fonts=frozenset({"xarb.shx"}), mappings={"l": "م", "r": "ق"})
    decoder = TextDecoder(table)
    assert decoder.decode("lr 2", "xarb.shx") == Decoded("مق 2", True)
    assert decoder.decode("lrz", "xarb.shx") == Decoded(None, False)
