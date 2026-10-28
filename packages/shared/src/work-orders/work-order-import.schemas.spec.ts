import { describe, expect, it } from 'vitest';
import {
  ColumnMappingSchema,
  ConfirmedColumnMappingSchema,
  IMPORT_FIELDS,
  IMPORT_HEADER_SYNONYMS,
  IMPORT_ROW_ISSUE_CODES,
  IMPORT_ROW_ISSUE_SEVERITY,
  REQUIRED_IMPORT_FIELDS,
  WORK_TYPE_SYNONYMS,
  ImportInvalidDetailsSchema,
  ImportPreviewRowSchema,
  WorkOrderImportCommitPayloadSchema,
  WorkOrderImportPreviewOptionsSchema,
} from './work-order-import.schemas.js';

const SHA = 'a'.repeat(64);
const mapping = { code: 0, description: 1, unit: 2, quantity: 3, unitPrice: 4, workType: 5 };

describe('column mapping', () => {
  it('allows unmapped (null) fields in a suggestion', () => {
    const suggestion = {
      code: 0,
      description: null,
      unit: null,
      quantity: 3,
      unitPrice: null,
      workType: null,
      amount: null,
    };
    expect(ColumnMappingSchema.safeParse(suggestion).success).toBe(true);
  });

  it('requires the six required fields when confirming; amount defaults to null', () => {
    expect(ConfirmedColumnMappingSchema.parse(mapping).amount).toBeNull();
    const missing = { code: 0, description: 1, unit: 2, quantity: 3, unitPrice: 4 };
    expect(ConfirmedColumnMappingSchema.safeParse(missing).success).toBe(false);
  });

  it('makes the work type a required field (ADR-016)', () => {
    expect(REQUIRED_IMPORT_FIELDS).toContain('workType');
  });

  it('rejects a column mapped to two fields', () => {
    expect(ConfirmedColumnMappingSchema.safeParse({ ...mapping, amount: 4 }).success).toBe(false);
    expect(ConfirmedColumnMappingSchema.safeParse({ ...mapping, amount: 6 }).success).toBe(true);
  });

  it('rejects negative column indexes', () => {
    expect(ConfirmedColumnMappingSchema.safeParse({ ...mapping, code: -1 }).success).toBe(false);
  });
});

describe('header synonyms', () => {
  it('has Arabic and English synonyms for every field', () => {
    for (const field of IMPORT_FIELDS) {
      const synonyms = IMPORT_HEADER_SYNONYMS[field];
      expect(synonyms.some((s) => /[؀-ۿ]/.test(s))).toBe(true);
      expect(synonyms.some((s) => /^[a-z ]+$/.test(s))).toBe(true);
    }
  });

  it('includes the agreed headers', () => {
    expect(IMPORT_HEADER_SYNONYMS.code).toEqual(expect.arrayContaining(['كود', 'البند', 'code']));
    expect(IMPORT_HEADER_SYNONYMS.description).toEqual(
      expect.arrayContaining(['الوصف', 'البيان', 'description']),
    );
    expect(IMPORT_HEADER_SYNONYMS.quantity).toEqual(expect.arrayContaining(['الكمية', 'qty']));
    expect(IMPORT_HEADER_SYNONYMS.unitPrice).toEqual(
      expect.arrayContaining(['السعر', 'سعر الوحدة', 'unit price']),
    );
    expect(IMPORT_HEADER_SYNONYMS.amount).toEqual(expect.arrayContaining(['القيمة', 'amount']));
    expect(IMPORT_HEADER_SYNONYMS.workType).toEqual(
      expect.arrayContaining(['نوع الأعمال', 'work type']),
    );
  });

  it('accepts the Arabic work type labels set by the owner (ADR-016)', () => {
    expect(WORK_TYPE_SYNONYMS.civil).toContain('مدني');
    expect(WORK_TYPE_SYNONYMS.installation).toContain('تركيبات');
    expect(WORK_TYPE_SYNONYMS.planning).toContain('تخطيط');
  });

  it('never maps one synonym to two fields', () => {
    const all = IMPORT_FIELDS.flatMap((field) => IMPORT_HEADER_SYNONYMS[field]);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('issue severities', () => {
  it('defines a severity for every row issue code', () => {
    for (const code of IMPORT_ROW_ISSUE_CODES) {
      expect(['error', 'warning']).toContain(IMPORT_ROW_ISSUE_SEVERITY[code]);
    }
  });

  it('treats duplicate codes as warnings, never errors', () => {
    expect(IMPORT_ROW_ISSUE_SEVERITY.DUPLICATE_CODE).toBe('warning');
  });
});

describe('preview', () => {
  it('accepts an empty options payload', () => {
    expect(WorkOrderImportPreviewOptionsSchema.parse({})).toEqual({});
  });

  it('accepts a row with an invalid number kept as raw text', () => {
    const row = {
      rowNumber: 7,
      raw: {
        code: 'C-1',
        description: 'كابل',
        unit: 'm',
        quantity: '12,5x',
        unitPrice: '10',
        workType: 'مدني',
        amount: null,
      },
      code: 'C-1',
      description: 'كابل',
      unit: 'm',
      quantity: null,
      unitPrice: '10',
      workType: 'civil',
      sheetAmount: null,
      amount: null,
      issues: [{ code: 'INVALID_NUMBER', severity: 'error', field: 'quantity' }],
    };
    expect(ImportPreviewRowSchema.safeParse(row).success).toBe(true);
  });
});

describe('commit payload', () => {
  const payload = {
    fileSha256: SHA,
    sheetName: 'BOQ',
    headerRow: 3,
    mapping,
    workOrder: { number: 'WO-7' },
  };

  it('applies defaults for exclusions and accepted duplicates', () => {
    const parsed = WorkOrderImportCommitPayloadSchema.parse(payload);
    expect(parsed.excludedRowNumbers).toEqual([]);
    expect(parsed.acceptedDuplicateCodes).toEqual([]);
    expect(parsed.mapping.amount).toBeNull();
  });

  it('rejects a bad sha256 and a missing work order number', () => {
    expect(
      WorkOrderImportCommitPayloadSchema.safeParse({ ...payload, fileSha256: 'abc' }).success,
    ).toBe(false);
    expect(
      WorkOrderImportCommitPayloadSchema.safeParse({ ...payload, workOrder: {} }).success,
    ).toBe(false);
  });

  it('describes IMPORT_INVALID details', () => {
    const details = ImportInvalidDetailsSchema.parse({ reason: 'UNRESOLVED_DUPLICATES' });
    expect(details.duplicateCodes).toEqual([]);
  });
});
