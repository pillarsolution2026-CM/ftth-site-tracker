import {
  HEADER_MIN_MATCHES,
  HEADER_SCAN_ROWS,
  IMPORT_FIELDS,
  IMPORT_HEADER_SYNONYMS,
  type ColumnMapping,
  type ImportField,
} from '@ftth/shared';
import { cellText } from './cell-values.js';
import { sheetRowCount, type RawCell, type RawSheet } from './raw-workbook.js';

/**
 * Header text normalisation (see IMPORT_HEADER_SYNONYMS): trim, lower-case, collapse whitespace,
 * strip Arabic diacritics/tatweel and Latin accents, unify أ/إ/آ→ا, ة→ه, ى→ي. (NFD splits أ/إ/آ into ا
 * plus a combining mark, and removing combining marks leaves the bare alef.)
 */
export function normalizeHeader(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\p{M}\u0640]/gu, '')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const EXACT_BONUS = 10_000;

const SYNONYMS: ReadonlyArray<
  readonly [ImportField, ReadonlyArray<{ text: string; pattern: RegExp }>]
> = IMPORT_FIELDS.map((field) => [
  field,
  IMPORT_HEADER_SYNONYMS[field].map((synonym) => {
    const text = normalizeHeader(synonym);
    const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // A synonym "contained" in a header must be whole words: "rate" must not match "separate".
    return { text, pattern: new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u') };
  }),
]);

/** Exact match beats containment; among contained synonyms the longest wins. 0 = no match. */
function scoreHeader(
  header: string,
  synonyms: ReadonlyArray<{ text: string; pattern: RegExp }>,
): number {
  let best = 0;
  for (const synonym of synonyms) {
    if (header === synonym.text) best = Math.max(best, EXACT_BONUS + synonym.text.length);
    else if (synonym.pattern.test(header)) best = Math.max(best, synonym.text.length);
  }
  return best;
}

export const EMPTY_MAPPING: ColumnMapping = {
  code: null,
  description: null,
  unit: null,
  quantity: null,
  unitPrice: null,
  amount: null,
};

export interface HeaderMatch {
  mapping: ColumnMapping;
  matched: number;
}

/** Assigns fields to the columns of one row, best scores first; a column and a field are used once. */
export function matchHeaderRow(cells: readonly RawCell[]): HeaderMatch {
  const candidates: Array<{ field: ImportField; column: number; score: number }> = [];
  cells.forEach((cell, column) => {
    const text = cellText(cell);
    if (text === null) return;
    const header = normalizeHeader(text);
    for (const [field, synonyms] of SYNONYMS) {
      const score = scoreHeader(header, synonyms);
      if (score > 0) candidates.push({ field, column, score });
    }
  });
  candidates.sort((a, b) => b.score - a.score || a.column - b.column);

  const mapping: { -readonly [K in ImportField]: number | null } = { ...EMPTY_MAPPING };
  const usedColumns = new Set<number>();
  let matched = 0;
  for (const { field, column } of candidates) {
    if (mapping[field] !== null || usedColumns.has(column)) continue;
    mapping[field] = column;
    usedColumns.add(column);
    matched += 1;
  }
  return { mapping, matched };
}

/** The row among the first HEADER_SCAN_ROWS with the most matched fields (≥ HEADER_MIN_MATCHES). */
export function detectHeaderRow(sheet: RawSheet): { rowNumber: number; match: HeaderMatch } | null {
  let best: { rowNumber: number; match: HeaderMatch } | null = null;
  const last = Math.min(HEADER_SCAN_ROWS, sheetRowCount(sheet));
  for (let rowNumber = 1; rowNumber <= last; rowNumber++) {
    const cells = sheet.rows.get(rowNumber);
    if (!cells) continue;
    const match = matchHeaderRow(cells);
    if (match.matched >= HEADER_MIN_MATCHES && (!best || match.matched > best.match.matched)) {
      best = { rowNumber, match };
    }
  }
  return best;
}
