import {
  IMPORT_FIELDS,
  IMPORT_ROW_ISSUE_SEVERITY,
  ITEM_TEXT_LIMITS,
  MAX_IMPORT_ROWS,
  QUANTITY_MAX_DECIMALS,
  REQUIRED_IMPORT_FIELDS,
  UNIT_PRICE_MAX_DECIMALS,
  WORK_TYPE_SYNONYMS,
  WORK_TYPES,
  type ColumnMapping,
  type WorkType,
  type ImportColumn,
  type ImportFileIssue,
  type ImportPreviewRow,
  type ImportRowIssue,
  type ImportRowIssueCode,
  type WorkOrderImportPreviewOptions,
  type WorkOrderImportPreviewResponse,
} from '@ftth/shared';
import { Decimal } from '../decimal.js';
import { cellText, parseInputDecimal, parseSheetAmount } from './cell-values.js';
import {
  detectHeaderRow,
  EMPTY_MAPPING,
  matchHeaderRow,
  normalizeHeader,
} from './header-matching.js';
import { annotateDuplicateCodes, summarize } from './import-summary.js';
import {
  columnLetter,
  isBlank,
  sheetRowCount,
  type RawCell,
  type RawSheet,
  type RawWorkbook,
} from './raw-workbook.js';

export type ParsedImport = Omit<WorkOrderImportPreviewResponse, 'file'>;

/** Longest accepted text per field (same limits as the work_order_items CHECK constraints). */
const TEXT_LIMITS = ITEM_TEXT_LIMITS;

const MAX_DECIMALS = {
  quantity: QUANTITY_MAX_DECIMALS,
  unitPrice: UNIT_PRICE_MAX_DECIMALS,
} as const;

/** Normalised cell text → work type, built from WORK_TYPE_SYNONYMS (ADR-016). */
const WORK_TYPE_BY_TEXT: ReadonlyMap<string, WorkType> = new Map(
  WORK_TYPES.flatMap((type) =>
    WORK_TYPE_SYNONYMS[type].map((text) => [normalizeHeader(text), type] as const),
  ),
);

const issue = (
  code: ImportRowIssueCode,
  field: ImportRowIssue['field'],
  params?: ImportRowIssue['params'],
): ImportRowIssue => ({
  code,
  severity: IMPORT_ROW_ISSUE_SEVERITY[code],
  field,
  ...(params ? { params } : {}),
});

function chooseSheet(workbook: RawWorkbook, requested: string | undefined): RawSheet | null {
  if (requested !== undefined)
    return workbook.sheets.find((sheet) => sheet.name === requested) ?? null;
  return workbook.sheets.find((sheet) => sheetRowCount(sheet) > 0) ?? workbook.sheets[0] ?? null;
}

function mappingIssues(mapping: ColumnMapping): ImportFileIssue[] {
  const issues: ImportFileIssue[] = [];
  const seen = new Set<number>();
  for (const field of IMPORT_FIELDS) {
    const column = mapping[field];
    if (column === null) {
      if (REQUIRED_IMPORT_FIELDS.includes(field))
        issues.push({ code: 'REQUIRED_FIELD_UNMAPPED', field });
    } else if (seen.has(column)) {
      issues.push({ code: 'COLUMN_MAPPED_TWICE', field });
    } else {
      seen.add(column);
    }
  }
  return issues;
}

function buildColumns(sheet: RawSheet, headerRow: number, lastRow: number): ImportColumn[] {
  let width = 0;
  for (let rowNumber = headerRow; rowNumber <= lastRow; rowNumber++) {
    const cells = sheet.rows.get(rowNumber) ?? [];
    for (let index = cells.length - 1; index >= width; index--) {
      if (!isBlank(cells[index])) {
        width = index + 1;
        break;
      }
    }
  }
  const headerCells = sheet.rows.get(headerRow) ?? [];
  return Array.from({ length: width }, (_, index) => ({
    index,
    letter: columnLetter(index),
    header: cellText(headerCells[index]) ?? '',
  }));
}

function textField(
  cell: RawCell | undefined,
  field: 'code' | 'description' | 'unit',
): { value: string | null; issue?: ImportRowIssue } {
  if (cell?.kind === 'unresolved')
    return { value: null, issue: issue('FORMULA_WITHOUT_RESULT', field) };
  const value = cellText(cell);
  if (value === null || value === '') return { value: null, issue: issue('MISSING_VALUE', field) };
  if (value.length > TEXT_LIMITS[field]) {
    return { value: null, issue: issue('TEXT_TOO_LONG', field, { max: TEXT_LIMITS[field] }) };
  }
  return { value };
}

function numberField(
  cell: RawCell | undefined,
  field: 'quantity' | 'unitPrice',
): { value: string | null; issue?: ImportRowIssue } {
  const parsed = parseInputDecimal(cell, MAX_DECIMALS[field]);
  if (parsed.ok) return { value: parsed.value };
  return { value: null, issue: issue(parsed.code, field, parsed.params) };
}

/** One of the fixed work types; the cell must name one exactly (after normalisation). */
function workTypeField(cell: RawCell | undefined): {
  value: WorkType | null;
  issue?: ImportRowIssue;
} {
  if (cell?.kind === 'unresolved')
    return { value: null, issue: issue('FORMULA_WITHOUT_RESULT', 'workType') };
  const text = cellText(cell);
  if (text === null || text === '')
    return { value: null, issue: issue('MISSING_VALUE', 'workType') };
  const type = WORK_TYPE_BY_TEXT.get(normalizeHeader(text));
  return type
    ? { value: type }
    : { value: null, issue: issue('INVALID_WORK_TYPE', 'workType', { value: text }) };
}

function decimalsOf(text: string): number {
  return text.split('.')[1]?.length ?? 0;
}

/** Cross-check of the sheet's own amount; informative only, never stored. */
function amountCheck(
  cell: RawCell | undefined,
  computed: Decimal | null,
): { sheetAmount: string | null; issue?: ImportRowIssue } {
  const sheetAmount = parseSheetAmount(cell);
  if (sheetAmount === null) {
    // Text that is not a number cannot be compared; say so instead of hiding it.
    const raw = cellText(cell);
    const unreadable = cell?.kind !== 'unresolved' && raw !== null && raw !== '';
    return unreadable
      ? { sheetAmount, issue: issue('AMOUNT_MISMATCH', 'amount', { sheetAmount: raw }) }
      : { sheetAmount };
  }
  if (computed === null) return { sheetAmount };
  const expected = computed.roundHalfUp(decimalsOf(sheetAmount));
  if (expected.equals(Decimal.parse(sheetAmount))) return { sheetAmount };
  return {
    sheetAmount,
    issue: issue('AMOUNT_MISMATCH', 'amount', {
      sheetAmount,
      computed: expected.toString(),
    }),
  };
}

function parseRow(
  rowNumber: number,
  cells: readonly RawCell[],
  mapping: ColumnMapping,
): ImportPreviewRow {
  const at = (field: keyof ColumnMapping): RawCell | undefined => {
    const column = mapping[field];
    return column === null ? undefined : cells[column];
  };
  const mapped = (field: keyof ColumnMapping): boolean => mapping[field] !== null;
  const issues: ImportRowIssue[] = [];
  const collect = <T extends { issue?: ImportRowIssue }>(
    field: keyof ColumnMapping,
    result: T,
  ): T => {
    // An unmapped required field is reported once for the file; repeating it per row is noise.
    if (result.issue && mapped(field)) issues.push(result.issue);
    return result;
  };

  const code = collect('code', textField(at('code'), 'code'));
  const description = collect('description', textField(at('description'), 'description'));
  const unit = collect('unit', textField(at('unit'), 'unit'));
  const quantity = collect('quantity', numberField(at('quantity'), 'quantity'));
  const unitPrice = collect('unitPrice', numberField(at('unitPrice'), 'unitPrice'));
  const workType = collect('workType', workTypeField(at('workType')));

  const computed =
    quantity.value !== null && unitPrice.value !== null
      ? Decimal.parse(quantity.value).mul(Decimal.parse(unitPrice.value))
      : null;
  const amount: { sheetAmount: string | null; issue?: ImportRowIssue } = mapped('amount')
    ? amountCheck(at('amount'), computed)
    : { sheetAmount: null };
  if (amount.issue) issues.push(amount.issue);

  const raw = (field: keyof ColumnMapping): string | null => cellText(at(field));
  return {
    rowNumber,
    raw: {
      code: raw('code'),
      description: raw('description'),
      unit: raw('unit'),
      quantity: raw('quantity'),
      unitPrice: raw('unitPrice'),
      workType: raw('workType'),
      amount: raw('amount'),
    },
    code: code.value,
    description: description.value,
    unit: unit.value,
    quantity: quantity.value,
    unitPrice: unitPrice.value,
    workType: workType.value,
    sheetAmount: amount.sheetAmount,
    amount: computed?.toString() ?? null,
    issues,
  };
}

function parseRows(sheet: RawSheet, headerRow: number, mapping: ColumnMapping) {
  const rows: ImportPreviewRow[] = [];
  const fileIssues: ImportFileIssue[] = [];
  const rowNumbers = [...sheet.rows.keys()].filter((n) => n > headerRow).sort((a, b) => a - b);
  for (const rowNumber of rowNumbers) {
    const cells = sheet.rows.get(rowNumber) ?? [];
    if (cells.every((cell) => isBlank(cell))) continue; // fully empty rows are skipped
    if (rows.length >= MAX_IMPORT_ROWS) {
      fileIssues.push({ code: 'TOO_MANY_ROWS', field: null, params: { max: MAX_IMPORT_ROWS } });
      break;
    }
    rows.push(parseRow(rowNumber, cells, mapping));
  }
  return { rows, fileIssues };
}

const emptyResult = (
  sheets: ParsedImport['sheets'],
  sheetName: string,
  fileIssues: ImportFileIssue[],
  mapping: ColumnMapping = EMPTY_MAPPING,
): ParsedImport => ({
  sheets,
  sheetName,
  headerRow: null,
  columns: [],
  suggestedMapping: EMPTY_MAPPING,
  mapping,
  fileIssues,
  rows: [],
  summary: summarize([]),
});

/**
 * Preview/commit parser. Stateless: the same workbook and options always give the same result,
 * which is what lets the commit re-parse instead of trusting client-sent rows.
 */
export function parseImport(
  workbook: RawWorkbook,
  options: WorkOrderImportPreviewOptions,
): ParsedImport {
  const sheets = workbook.sheets.map((sheet) => ({
    name: sheet.name,
    rowCount: sheetRowCount(sheet),
  }));
  const sheet = chooseSheet(workbook, options.sheetName);
  if (!sheet) {
    const code = options.sheetName === undefined ? 'SHEET_EMPTY' : 'SHEET_NOT_FOUND';
    return emptyResult(sheets, options.sheetName ?? '', [{ code, field: null }]);
  }
  const lastRow = sheetRowCount(sheet);
  if (lastRow === 0) return emptyResult(sheets, sheet.name, [{ code: 'SHEET_EMPTY', field: null }]);

  const detected = options.headerRow === undefined ? detectHeaderRow(sheet) : null;
  const headerRow = options.headerRow ?? detected?.rowNumber ?? null;
  if (headerRow === null) {
    return emptyResult(
      sheets,
      sheet.name,
      [{ code: 'HEADER_ROW_NOT_FOUND', field: null }],
      options.mapping,
    );
  }

  const suggestedMapping = (detected?.match ?? matchHeaderRow(sheet.rows.get(headerRow) ?? []))
    .mapping;
  const mapping = options.mapping ?? suggestedMapping;
  const { rows, fileIssues: rowFileIssues } = parseRows(sheet, headerRow, mapping);
  const annotated = annotateDuplicateCodes(rows);
  const fileIssues = [...mappingIssues(mapping), ...rowFileIssues];
  if (annotated.length === 0) fileIssues.push({ code: 'NO_ITEM_ROWS', field: null });

  return {
    sheets,
    sheetName: sheet.name,
    headerRow,
    columns: buildColumns(sheet, headerRow, lastRow),
    suggestedMapping,
    mapping,
    fileIssues,
    rows: annotated,
    summary: summarize(annotated),
  };
}
