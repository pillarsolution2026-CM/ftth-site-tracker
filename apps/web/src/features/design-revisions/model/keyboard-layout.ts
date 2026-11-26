/**
 * Commands typed with another keyboard layout (round 2, item 27). AutoCAD users type the command
 * by the position of the keys, whatever the layout: with the Arabic layout, the key of M gives «ة»
 * and the command must still read M. The physical key (`event.code`) is used when the typed
 * character is not Latin; the characters the standard Arabic layout puts on the Latin letters'
 * keys are mapped back for text that arrives without a key event (the command line's input box).
 */

const isLatinOrControl = (key: string) => /^[\x20-\x7e]$/.test(key);

/** The Latin character of a key event for the command line: its own, or the key's letter / digit. */
export function latinKey(event: { key: string; code?: string }): string {
  const { key, code } = event;
  if (key.length !== 1 || isLatinOrControl(key)) return key;
  const letter = /^Key([A-Z])$/.exec(code ?? '');
  if (letter) return (letter[1] as string).toLowerCase();
  const digit = /^Digit([0-9])$/.exec(code ?? '');
  if (digit) return digit[1] as string;
  const numpad = /^Numpad([0-9])$/.exec(code ?? '');
  if (numpad) return numpad[1] as string;
  switch (code) {
    case 'Comma':
      return ',';
    case 'Period':
      return '.';
    case 'Minus':
      return '-';
    case 'Slash':
      return '/';
    default:
      return key;
  }
}

/** The standard Arabic layout: the letter on the key of each Latin letter. */
const ARABIC_ON_KEY: Readonly<Record<string, string>> = {
  ض: 'q',
  ص: 'w',
  ث: 'e',
  ق: 'r',
  ف: 't',
  غ: 'y',
  ع: 'u',
  ه: 'i',
  خ: 'o',
  ح: 'p',
  ش: 'a',
  س: 's',
  ي: 'd',
  ب: 'f',
  ل: 'g',
  ا: 'h',
  ت: 'j',
  ن: 'k',
  م: 'l',
  ئ: 'z',
  ء: 'x',
  ؤ: 'c',
  ر: 'v',
  ى: 'n',
  ة: 'm',
  // The same keys, other forms of the letter.
  أ: 'h',
  إ: 'h',
  آ: 'h',
  ك: ';',
  ط: "'",
  و: ',',
  ز: '.',
  ظ: '/',
  '،': ',',
  '٫': '.',
};

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Text typed with the Arabic layout read as the command line expects it (letters by key, digits). */
export function latinize(text: string): string {
  // The lam-alef ligature is one key (B).
  let out = '';
  for (const char of text.replace(/ل[اأإآ]/g, 'b')) {
    const digit = ARABIC_DIGITS.indexOf(char);
    out += digit >= 0 ? String(digit) : (ARABIC_ON_KEY[char] ?? char);
  }
  return out;
}
