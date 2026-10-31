import { z } from 'zod';
import {
  Decimal4StringSchema,
  Decimal6StringSchema,
  DecimalStringSchema,
} from '../common/decimal.js';
import {
  MAX_WORK_ORDER_ITEMS,
  WorkOrderHeaderInputSchema,
  WorkTypeSchema,
  type WorkType,
} from './work-order.schemas.js';

/**
 * Excel import of work-order items: preview (no writes) → user confirms mapping → commit (atomic).
 * Both requests are multipart: field `file` (xlsx) and field `payload` (JSON string of the schema below).
 * The commit re-parses the same file server-side; nothing is cached between the two calls.
 */

export const MAX_IMPORT_ROWS = MAX_WORK_ORDER_ITEMS;
/** Header detection scans this many rows from the top of the sheet. */
export const HEADER_SCAN_ROWS = 30;
/** A row is accepted as the header row only if at least this many fields match a synonym. */
export const HEADER_MIN_MATCHES = 3;

export const IMPORT_FIELDS = [
  'code',
  'description',
  'unit',
  'quantity',
  'unitPrice',
  'workType',
  'amount',
] as const;
export const ImportFieldSchema = z.enum(IMPORT_FIELDS);
export type ImportField = z.infer<typeof ImportFieldSchema>;

/** Required fields (ADR-011, ADR-016). `amount` is optional and only cross-checked. */
export const REQUIRED_IMPORT_FIELDS: readonly ImportField[] = [
  'code',
  'description',
  'unit',
  'quantity',
  'unitPrice',
  'workType',
];

/**
 * Cell values accepted for each work type, compared after the same normalisation as headers.
 * Arabic labels are the owner's terms (ADR-016); the codes and the English/French labels shown
 * by the app are accepted too.
 */
export const WORK_TYPE_SYNONYMS: Readonly<Record<WorkType, readonly string[]>> = {
  civil: ['مدني', 'civil', 'génie civil'],
  installation: ['تركيبات', 'installation', 'installations'],
  planning: ['تخطيط', 'planning', 'planification'],
};

/**
 * Header synonyms used to suggest a mapping. Compared after normalisation: trim, lower-case,
 * collapse whitespace, strip Arabic diacritics/tatweel, unify أ/إ/آ→ا, ة→ه, ى→ي.
 * Exact match after normalisation wins over "contains".
 */
export const IMPORT_HEADER_SYNONYMS: Readonly<Record<ImportField, readonly string[]>> = {
  // 'مسلسل' is the code column of the owner's BOQ and work-order sheets (owner, 2026-10-31).
  code: ['كود', 'الكود', 'كود البند', 'البند', 'رقم البند', 'مسلسل', 'code', 'item', 'item code'],
  description: ['الوصف', 'البيان', 'وصف البند', 'description', 'désignation', 'designation'],
  unit: ['الوحدة', 'وحدة', 'unit', 'uom', 'unité', 'unite'],
  quantity: ['الكمية', 'كمية', 'quantity', 'qty', 'quantité', 'quantite'],
  unitPrice: ['السعر', 'سعر الوحدة', 'الفئة', 'unit price', 'price', 'rate', 'prix unitaire'],
  workType: ['نوع الأعمال', 'نوع العمل', 'work type', 'type of work', 'type de travaux'],
  amount: ['القيمة', 'الإجمالي', 'الاجمالي', 'amount', 'total', 'montant'],
};

/** 0-based column index (A = 0). */
const ColumnIndexSchema = z.number().int().min(0).max(16383);

/** Field → column. `null` = not mapped. Used for suggestions and preview overrides. */
export const ColumnMappingSchema = z.object({
  code: ColumnIndexSchema.nullable(),
  description: ColumnIndexSchema.nullable(),
  unit: ColumnIndexSchema.nullable(),
  quantity: ColumnIndexSchema.nullable(),
  unitPrice: ColumnIndexSchema.nullable(),
  workType: ColumnIndexSchema.nullable(),
  amount: ColumnIndexSchema.nullable(),
});
export type ColumnMapping = z.infer<typeof ColumnMappingSchema>;

/** Mapping confirmed by the user for commit: required fields mapped, no column used twice. */
export const ConfirmedColumnMappingSchema = z
  .object({
    code: ColumnIndexSchema,
    description: ColumnIndexSchema,
    unit: ColumnIndexSchema,
    quantity: ColumnIndexSchema,
    unitPrice: ColumnIndexSchema,
    workType: ColumnIndexSchema,
    amount: ColumnIndexSchema.nullable().default(null),
  })
  .superRefine((mapping, ctx) => {
    const used = Object.values(mapping).filter((value): value is number => value !== null);
    if (new Set(used).size !== used.length) {
      ctx.addIssue({ code: 'custom', message: 'A column is mapped to more than one field' });
    }
  });
export type ConfirmedColumnMapping = z.infer<typeof ConfirmedColumnMappingSchema>;

// ---------- issues ----------

export const IMPORT_ROW_ISSUE_CODES = [
  'MISSING_VALUE',
  'INVALID_NUMBER',
  'NEGATIVE_NUMBER',
  'TOO_MANY_DECIMALS',
  'NUMBER_OUT_OF_RANGE',
  'TEXT_TOO_LONG',
  'FORMULA_WITHOUT_RESULT',
  'INVALID_WORK_TYPE',
  'DUPLICATE_CODE',
  'AMOUNT_MISMATCH',
  'UNIT_FORM_VARIANT',
] as const;
export const ImportRowIssueCodeSchema = z.enum(IMPORT_ROW_ISSUE_CODES);
export type ImportRowIssueCode = z.infer<typeof ImportRowIssueCodeSchema>;

export const ImportIssueSeveritySchema = z.enum(['error', 'warning']);
export type ImportIssueSeverity = z.infer<typeof ImportIssueSeveritySchema>;

/** Fixed severity per code. Errors block the row; warnings need an explicit user decision or are informative. */
export const IMPORT_ROW_ISSUE_SEVERITY: Readonly<Record<ImportRowIssueCode, ImportIssueSeverity>> =
  {
    MISSING_VALUE: 'error',
    INVALID_NUMBER: 'error',
    NEGATIVE_NUMBER: 'error',
    TOO_MANY_DECIMALS: 'error',
    NUMBER_OUT_OF_RANGE: 'error',
    TEXT_TOO_LONG: 'error',
    FORMULA_WITHOUT_RESULT: 'error',
    /** Work type cell is not one of WORK_TYPE_SYNONYMS (ADR-016). */
    INVALID_WORK_TYPE: 'error',
    /** Must be resolved: exclude rows or list the code in `acceptedDuplicateCodes`. Never merged. */
    DUPLICATE_CODE: 'warning',
    /** Sheet amount ≠ quantity × unitPrice (rounded to the sheet value's decimals). Informative only. */
    AMOUNT_MISMATCH: 'warning',
    /**
     * The unit equals another row's unit once spaces and line breaks are collapsed, but is typed
     * differently (e.g. `BULDING (1 to 8…)` vs `BULDING⏎(1 to 8…)`). Informative only: the value is
     * kept exactly as typed (owner, 2026-10-31). `params.otherRows` lists the other rows.
     */
    UNIT_FORM_VARIANT: 'warning',
  };

/**
 * Kind of a data row. `heading` = a section title: the unit and the unit price are both empty and
 * the quantity and amount are empty or zero (owner, 2026-10-31). A heading needs only a code; it has
 * no other checks, is not counted in the total, and is never stored as a work-order item (the
 * contract import stores it as a heading line). Every other row is an `item`.
 */
export const IMPORT_ROW_KINDS = ['item', 'heading'] as const;
export const ImportRowKindSchema = z.enum(IMPORT_ROW_KINDS);
export type ImportRowKind = z.infer<typeof ImportRowKindSchema>;

export const ImportRowIssueSchema = z.object({
  code: ImportRowIssueCodeSchema,
  severity: ImportIssueSeveritySchema,
  field: ImportFieldSchema.nullable(),
  /** Values for the client-side message template (e.g. { max: 4 }, { otherRows: "12,30" }). */
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});
export type ImportRowIssue = z.infer<typeof ImportRowIssueSchema>;

export const IMPORT_FILE_ISSUE_CODES = [
  'SHEET_NOT_FOUND',
  'SHEET_EMPTY',
  'HEADER_ROW_NOT_FOUND',
  'REQUIRED_FIELD_UNMAPPED',
  'COLUMN_MAPPED_TWICE',
  'TOO_MANY_ROWS',
  'NO_ITEM_ROWS',
] as const;
export const ImportFileIssueCodeSchema = z.enum(IMPORT_FILE_ISSUE_CODES);
export type ImportFileIssueCode = z.infer<typeof ImportFileIssueCodeSchema>;

export const ImportFileIssueSchema = z.object({
  code: ImportFileIssueCodeSchema,
  field: ImportFieldSchema.nullable(),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});
export type ImportFileIssue = z.infer<typeof ImportFileIssueSchema>;

// ---------- preview ----------

/** `payload` of POST …/work-orders/import/preview. All optional: first call sends `{}`. */
export const WorkOrderImportPreviewOptionsSchema = z.object({
  /** Defaults to the first non-empty sheet. */
  sheetName: z.string().min(1).max(255).optional(),
  /** 1-based Excel row number of the header row. Defaults to auto-detection. */
  headerRow: z.number().int().min(1).optional(),
  /** User override; replaces the suggestion when present. */
  mapping: ColumnMappingSchema.optional(),
});
export type WorkOrderImportPreviewOptions = z.infer<typeof WorkOrderImportPreviewOptionsSchema>;

const nullableText = z.string().nullable();

export const ImportPreviewRowSchema = z.object({
  /** 1-based Excel row number; the identity of a row between preview and commit. */
  rowNumber: z.number().int().min(1),
  kind: ImportRowKindSchema,
  /** Cell text as displayed, per mapped field (null = empty or unmapped). */
  raw: z.object({
    code: nullableText,
    description: nullableText,
    unit: nullableText,
    quantity: nullableText,
    unitPrice: nullableText,
    workType: nullableText,
    amount: nullableText,
  }),
  /** Parsed values; null when missing or invalid (see issues). */
  code: nullableText,
  description: nullableText,
  unit: nullableText,
  quantity: Decimal4StringSchema.nullable(),
  unitPrice: Decimal6StringSchema.nullable(),
  workType: WorkTypeSchema.nullable(),
  /** Amount read from the sheet (cross-check only, never stored). */
  sheetAmount: DecimalStringSchema.nullable(),
  /** quantity × unitPrice, exact; null if either is invalid. */
  amount: DecimalStringSchema.nullable(),
  issues: z.array(ImportRowIssueSchema),
});
export type ImportPreviewRow = z.infer<typeof ImportPreviewRowSchema>;

export const ImportColumnSchema = z.object({
  index: ColumnIndexSchema,
  /** Excel column letter, e.g. "A", "AB". */
  letter: z.string().regex(/^[A-Z]{1,3}$/),
  header: z.string(),
});
export type ImportColumn = z.infer<typeof ImportColumnSchema>;

export const WorkOrderImportPreviewResponseSchema = z.object({
  file: z.object({
    name: z.string(),
    sizeBytes: z.number().int().positive(),
    /** Echo it in the commit payload; the commit fails with IMPORT_INVALID if the file differs. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  sheets: z.array(z.object({ name: z.string(), rowCount: z.number().int().min(0) })),
  sheetName: z.string(),
  /** null when no header row was found (see fileIssues). */
  headerRow: z.number().int().min(1).nullable(),
  columns: z.array(ImportColumnSchema),
  suggestedMapping: ColumnMappingSchema,
  /** Mapping actually used for `rows` (override if sent, else suggestion). */
  mapping: ColumnMappingSchema,
  fileIssues: z.array(ImportFileIssueSchema),
  /** Data rows below the header; fully empty rows are skipped. */
  rows: z.array(ImportPreviewRowSchema),
  summary: z.object({
    rowCount: z.number().int().min(0),
    /** Rows of kind `heading` (included in rowCount). */
    headingCount: z.number().int().min(0),
    errorRowCount: z.number().int().min(0),
    warningRowCount: z.number().int().min(0),
    duplicateCodes: z.array(
      z.object({ code: z.string(), rowNumbers: z.array(z.number().int().min(1)).min(2) }),
    ),
    /** Σ amount over rows without errors. */
    total: DecimalStringSchema,
  }),
});
export type WorkOrderImportPreviewResponse = z.infer<typeof WorkOrderImportPreviewResponseSchema>;

// ---------- commit ----------

/** `payload` of POST …/work-orders/import. Creates one new work order with the included rows. */
export const WorkOrderImportCommitPayloadSchema = z.object({
  fileSha256: z.string().regex(/^[0-9a-f]{64}$/),
  sheetName: z.string().min(1).max(255),
  headerRow: z.number().int().min(1),
  mapping: ConfirmedColumnMappingSchema,
  /** Rows the user chose to leave out. Every included row must be free of errors. */
  excludedRowNumbers: z.array(z.number().int().min(1)).default([]),
  /** Duplicate codes the user explicitly keeps as separate lines. Others must be excluded. */
  acceptedDuplicateCodes: z.array(z.string()).default([]),
  workOrder: WorkOrderHeaderInputSchema,
});
export type WorkOrderImportCommitPayload = z.infer<typeof WorkOrderImportCommitPayloadSchema>;

/** `details` of an IMPORT_INVALID error returned by the commit. */
export const ImportInvalidDetailsSchema = z.object({
  reason: z.enum([
    'FILE_CHANGED',
    'FILE_ISSUES',
    'ROW_ERRORS',
    'UNRESOLVED_DUPLICATES',
    'NO_ROWS_INCLUDED',
  ]),
  fileIssues: z.array(ImportFileIssueSchema).default([]),
  rows: z
    .array(z.object({ rowNumber: z.number().int().min(1), issues: z.array(ImportRowIssueSchema) }))
    .default([]),
  duplicateCodes: z.array(z.string()).default([]),
});
export type ImportInvalidDetails = z.infer<typeof ImportInvalidDetailsSchema>;
