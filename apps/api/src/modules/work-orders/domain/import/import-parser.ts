import {
  IMPORT_FIELDS,
  IMPORT_ROW_ISSUE_SEVERITY,
  ITEM_TEXT_LIMITS,
  MAX_IMPORT_ROWS,
  QUANTITY_MAX_DECIMALS,
  REQUIRED_IMPORT_FIELDS,
  SCOPE_MAX_LENGTH,
  UNIT_PRICE_MAX_DECIMALS,
  WORK_ORDER_REQUIRED_IMPORT_FIELDS,
  WORK_TYPE_SYNONYMS,
  WORK_TYPES,
  type ColumnMapping,
  type WorkType,
  type ImportColumn,
  type ImportField,
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
import { annotateDuplicateCodes, annotateUnitVariants, summarize } from './import-summary.js';
import {
  columnLetter,
  isBlank,
  sheetRowCount,
  type RawCell,
  type RawSheet,
  type RawWorkbook,
} from './raw-workbook.js';

export type ParsedImport = Omit<WorkOrderImportPreviewResponse, 'file'>;

/**
 * `standard`: contract and work-order sheets (work type required, no scope).
 * `contractor`: a subcontractor's sheet (ADR-036): optional scope column, no work type.
 * `workOrder`: a work-order sheet (ADR-044): only the code and the quantity are taken; the other
 * cells are best-effort values for comparison with the contract and never produce errors.
 */
export type ImportProfile = 'standard' | 'contractor' | 'workOrder';

const CONTRACTOR_REQUIRED_FIELDS: readonly ImportField[] = [
  'code',
  'description',
  'unit',
  'quantity',
  'unitPrice',
];

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

function mappingIssues(
  mapping: ColumnMapping,
  required: readonly ImportField[],
): ImportFileIssue[] {
  const issues: ImportFileIssue[] = [];
  const seen = new Set<number>();
  for (const field of IMPORT_FIELDS) {
    const column = mapping[field];
    if (column === null) {
      if (required.includes(field)) issues.push({ code: 'REQUIRED_FIELD_UNMAPPED', field });
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

/** Optional free text; empty = the whole line (null). */
function scopeField(cell: RawCell | undefined): { value: string | null; issue?: ImportRowIssue } {
  if (cell?.kind === 'unresolved')
    return { value: null, issue: issue('FORMULA_WITHOUT_RESULT', 'scope') };
  const value = cellText(cell)?.trim() ?? '';
  if (value === '') return { value: null };
  if (value.length > SCOPE_MAX_LENGTH) {
    return { value: null, issue: issue('TEXT_TOO_LONG', 'scope', { max: SCOPE_MAX_LENGTH }) };
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

/** Cell is empty (a formula without a cached result counts as empty only when `allowFormula`). */
function isEmptyCell(cell: RawCell | undefined, allowFormula = false): boolean {
  if (cell?.kind === 'unresolved') return allowFormula;
  return cellText(cell) === null;
}

/** Empty, or a number equal to zero. */
function isEmptyOrZero(cell: RawCell | undefined, allowFormula: boolean): boolean {
  if (isEmptyCell(cell, allowFormula)) return true;
  if (cell?.kind === 'unresolved') return false;
  const amount = parseSheetAmount(cell);
  return amount !== null && /^-?0(\.0+)?$/.test(amount);
}

/**
 * A section title: unit and unit price empty, quantity and amount empty or zero (owner,
 * 2026-10-31). The amount is only a cross-check, so a formula without a cached result is accepted.
 */
function isHeadingRow(at: (field: keyof ColumnMapping) => RawCell | undefined): boolean {
  return (
    isEmptyCell(at('unit')) &&
    isEmptyCell(at('unitPrice')) &&
    isEmptyOrZero(at('quantity'), false) &&
    isEmptyOrZero(at('amount'), true)
  );
}

function headingRow(
  rowNumber: number,
  at: (field: keyof ColumnMapping) => RawCell | undefined,
  mapping: ColumnMapping,
): ImportPreviewRow {
  const issues: ImportRowIssue[] = [];
  const code = textField(at('code'), 'code');
  if (code.issue && mapping.code !== null) issues.push(code.issue);
  const cell = at('description');
  const text = cell?.kind === 'unresolved' ? null : cellText(cell);
  let description: string | null = null;
  if (text !== null) {
    if (text.length > TEXT_LIMITS.description) {
      issues.push(issue('TEXT_TOO_LONG', 'description', { max: TEXT_LIMITS.description }));
    } else {
      description = text;
    }
  }
  const raw = (field: keyof ColumnMapping): string | null => cellText(at(field));
  return {
    rowNumber,
    kind: 'heading',
    raw: {
      code: raw('code'),
      description: raw('description'),
      unit: null,
      quantity: raw('quantity'),
      unitPrice: null,
      workType: raw('workType'),
      amount: raw('amount'),
      scope: raw('scope'),
    },
    code: code.value,
    description,
    unit: null,
    quantity: null,
    unitPrice: null,
    workType: null,
    scope: null,
    sheetAmount: null,
    amount: null,
    issues,
  };
}

/** Quantity of a work-order sheet: more than 4 decimals is rounded half-up, never an error (ADR-044). */
function workOrderQuantity(cell: RawCell | undefined): {
  value: string | null;
  issue?: ImportRowIssue;
} {
  const parsed = parseInputDecimal(cell, 40);
  if (!parsed.ok) return { value: null, issue: issue(parsed.code, 'quantity', parsed.params) };
  return { value: Decimal.parse(parsed.value).roundHalfUp(MAX_DECIMALS.quantity).toString() };
}

/** Optional text cell of a work-order sheet: readable text or null, no issue (ADR-044). */
function optionalText(cell: RawCell | undefined, max: number): string | null {
  const value = cell?.kind === 'unresolved' ? null : cellText(cell);
  return value === null || value === '' || value.length > max ? null : value;
}

function optionalNumber(cell: RawCell | undefined, max: number): string | null {
  const parsed = parseInputDecimal(cell, max);
  return parsed.ok ? parsed.value : null;
}

function optionalWorkType(cell: RawCell | undefined): WorkType | null {
  const text = cell?.kind === 'unresolved' ? null : cellText(cell);
  return text ? (WORK_TYPE_BY_TEXT.get(normalizeHeader(text)) ?? null) : null;
}

/**
 * A work-order row (ADR-044). No code = skipped, silently (totals, tax). Otherwise an item: the
 * code and quantity are checked; the optional cells are only read for the comparison with the
 * contract. Headings and empty quantities are decided later, against the contract.
 */
function parseWorkOrderRow(
  rowNumber: number,
  at: (field: keyof ColumnMapping) => RawCell | undefined,
  mapping: ColumnMapping,
): ImportPreviewRow {
  const raw = (field: keyof ColumnMapping): string | null => cellText(at(field));
  const rawAll = {
    code: raw('code'),
    description: raw('description'),
    unit: raw('unit'),
    quantity: raw('quantity'),
    unitPrice: raw('unitPrice'),
    workType: raw('workType'),
    amount: raw('amount'),
    scope: null,
  };
  const empty = {
    code: null,
    description: null,
    unit: null,
    quantity: null,
    unitPrice: null,
    workType: null,
    scope: null,
    sheetAmount: null,
    amount: null,
  };
  const codeCell = at('code');
  if (codeCell?.kind !== 'unresolved' && (cellText(codeCell) ?? '') === '') {
    return { rowNumber, kind: 'skipped', raw: rawAll, ...empty, issues: [] };
  }
  const issues: ImportRowIssue[] = [];
  const code = textField(codeCell, 'code');
  if (code.issue && mapping.code !== null) issues.push(code.issue);
  const quantity = workOrderQuantity(at('quantity'));
  // An empty quantity is judged later (skipped, or a silent contract heading); not an error here.
  if (quantity.issue && quantity.issue.code !== 'MISSING_VALUE' && mapping.quantity !== null) {
    issues.push(quantity.issue);
  }
  return {
    rowNumber,
    kind: 'item',
    raw: rawAll,
    ...empty,
    code: code.value,
    description: optionalText(at('description'), TEXT_LIMITS.description),
    unit: optionalText(at('unit'), TEXT_LIMITS.unit),
    quantity: quantity.value,
    unitPrice: optionalNumber(at('unitPrice'), MAX_DECIMALS.unitPrice),
    workType: optionalWorkType(at('workType')),
    sheetAmount: parseSheetAmount(at('amount')),
    issues,
  };
}

function parseRow(
  rowNumber: number,
  cells: readonly RawCell[],
  mapping: ColumnMapping,
  profile: ImportProfile,
): ImportPreviewRow {
  const at = (field: keyof ColumnMapping): RawCell | undefined => {
    const column = mapping[field];
    return column === null ? undefined : cells[column];
  };
  if (profile === 'workOrder') return parseWorkOrderRow(rowNumber, at, mapping);
  if (isHeadingRow(at)) return headingRow(rowNumber, at, mapping);
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
  const workType: { value: WorkType | null } =
    profile === 'contractor' ? { value: null } : collect('workType', workTypeField(at('workType')));
  const scope =
    profile === 'contractor' ? collect('scope', scopeField(at('scope'))) : { value: null };

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
    kind: 'item',
    raw: {
      code: raw('code'),
      description: raw('description'),
      unit: raw('unit'),
      quantity: raw('quantity'),
      unitPrice: raw('unitPrice'),
      workType: raw('workType'),
      amount: raw('amount'),
      scope: raw('scope'),
    },
    code: code.value,
    description: description.value,
    unit: unit.value,
    quantity: quantity.value,
    unitPrice: unitPrice.value,
    workType: workType.value,
    scope: scope.value,
    sheetAmount: amount.sheetAmount,
    amount: computed?.toString() ?? null,
    issues,
  };
}

function parseRows(
  sheet: RawSheet,
  headerRow: number,
  mapping: ColumnMapping,
  profile: ImportProfile,
) {
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
    rows.push(parseRow(rowNumber, cells, mapping, profile));
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
  profile: ImportProfile = 'standard',
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

  // Only a contractor sheet has a scope column; a header that looks like one is ignored elsewhere.
  const withProfile = (mapping: ColumnMapping): ColumnMapping =>
    profile === 'contractor' ? mapping : { ...mapping, scope: null };
  const suggestedMapping = withProfile(
    (detected?.match ?? matchHeaderRow(sheet.rows.get(headerRow) ?? [])).mapping,
  );
  const mapping = options.mapping ? withProfile(options.mapping) : suggestedMapping;
  const { rows, fileIssues: rowFileIssues } = parseRows(sheet, headerRow, mapping, profile);
  const annotated = annotateUnitVariants(annotateDuplicateCodes(rows));
  const required =
    profile === 'contractor'
      ? CONTRACTOR_REQUIRED_FIELDS
      : profile === 'workOrder'
        ? WORK_ORDER_REQUIRED_IMPORT_FIELDS
        : REQUIRED_IMPORT_FIELDS;
  const fileIssues = [...mappingIssues(mapping, required), ...rowFileIssues];
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
