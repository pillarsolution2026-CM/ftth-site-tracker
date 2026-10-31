import {
  WorkOrderImportCommitPayloadSchema,
  type ImportPreviewRow,
  type WorkOrderImportPreviewResponse,
} from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import {
  INITIAL_WIZARD_STATE,
  buildCommitPayload,
  buildContractCommitPayload,
  commitBlockers,
  deriveSelection,
  isDraftApplied,
  wizardReducer,
  type WizardAction,
  type WizardState,
} from './import-wizard';

const SHA = 'a'.repeat(64);

function row(
  rowNumber: number,
  code: string | null,
  amount: string | null,
  issues: ImportPreviewRow['issues'] = [],
): ImportPreviewRow {
  return {
    rowNumber,
    kind: 'item',
    raw: {
      code,
      description: 'd',
      unit: 'm',
      quantity: '1',
      unitPrice: '1',
      workType: 'مدني',
      amount: null,
    },
    code,
    description: 'd',
    unit: 'm',
    quantity: '1',
    unitPrice: '1',
    workType: 'civil',
    sheetAmount: null,
    amount,
    issues,
  };
}

const duplicateIssue = (otherRows: string): ImportPreviewRow['issues'][number] => ({
  code: 'DUPLICATE_CODE',
  severity: 'warning',
  field: 'code',
  params: { otherRows },
});
const missingQuantity: ImportPreviewRow['issues'][number] = {
  code: 'MISSING_VALUE',
  severity: 'error',
  field: 'quantity',
};

const MAPPING = {
  code: 0,
  description: 1,
  unit: 2,
  quantity: 3,
  unitPrice: 4,
  workType: 5,
  amount: null,
};

function preview(
  overrides: Partial<WorkOrderImportPreviewResponse> = {},
): WorkOrderImportPreviewResponse {
  return {
    file: { name: 'wo.xlsx', sizeBytes: 100, sha256: SHA },
    sheets: [{ name: 'Sheet1', rowCount: 5 }],
    sheetName: 'Sheet1',
    headerRow: 1,
    columns: [],
    suggestedMapping: MAPPING,
    mapping: MAPPING,
    fileIssues: [],
    rows: [
      row(2, 'A-1', '10.5'),
      row(3, 'B-2', '0.1', [duplicateIssue('4')]),
      row(4, 'B-2', '0.2', [duplicateIssue('3')]),
      row(5, 'C-3', null, [missingQuantity]),
    ],
    summary: {
      rowCount: 4,
      headingCount: 0,
      errorRowCount: 1,
      warningRowCount: 2,
      duplicateCodes: [{ code: 'B-2', rowNumbers: [3, 4] }],
      total: '10.8',
    },
    ...overrides,
  };
}

function run(actions: WizardAction[], start: WizardState = INITIAL_WIZARD_STATE): WizardState {
  return actions.reduce(wizardReducer, start);
}

const withHeader: WizardAction = { type: 'setHeaderField', field: 'number', value: 'WO-1' };

describe('import wizard selection', () => {
  it('counts rows and sums only rows without errors, exactly', () => {
    const state = run([{ type: 'previewLoaded', preview: preview() }]);
    const selection = deriveSelection(state);
    expect(selection.counts).toEqual({
      total: 4,
      included: 4,
      headingRows: 0,
      errorRows: 1,
      warningRows: 2,
    });
    expect(selection.total).toBe('10.8');
    expect(selection.blockingErrorRows).toEqual([5]);
  });

  it('"exclude rows with errors" removes them from the commit and the total', () => {
    const state = run([
      { type: 'previewLoaded', preview: preview() },
      { type: 'setExcludeErrorRows', value: true },
    ]);
    const selection = deriveSelection(state);
    expect(selection.counts.included).toBe(3);
    expect([...selection.excluded]).toEqual([5]);
    expect(selection.blockingErrorRows).toEqual([]);
  });

  it('manual row toggles change the total', () => {
    const state = run([
      { type: 'previewLoaded', preview: preview() },
      { type: 'toggleRow', rowNumber: 2 },
    ]);
    expect(deriveSelection(state).total).toBe('0.3');
    const back = wizardReducer(state, { type: 'toggleRow', rowNumber: 2 });
    expect(deriveSelection(back).total).toBe('10.8');
  });
});

describe('duplicate decisions', () => {
  const loaded = run([
    { type: 'previewLoaded', preview: preview() },
    { type: 'setExcludeErrorRows', value: true },
    withHeader,
  ]);

  it('blocks the commit until every duplicate code has a decision', () => {
    expect(deriveSelection(loaded).unresolvedDuplicates).toEqual(['B-2']);
    expect(commitBlockers(loaded)).toEqual(['unresolvedDuplicates']);
    expect(buildCommitPayload(loaded)).toBeNull();
  });

  it('"keep as separate lines" sends the code in acceptedDuplicateCodes and excludes nothing', () => {
    const state = wizardReducer(loaded, { type: 'decide', code: 'B-2', decision: 'keep' });
    expect(commitBlockers(state)).toEqual([]);
    const payload = buildCommitPayload(state);
    expect(payload?.acceptedDuplicateCodes).toEqual(['B-2']);
    expect(payload?.excludedRowNumbers).toEqual([5]);
    expect(WorkOrderImportCommitPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('"exclude rows" leaves the duplicate rows out of the commit', () => {
    const state = wizardReducer(loaded, { type: 'decide', code: 'B-2', decision: 'exclude' });
    const payload = buildCommitPayload(state);
    expect(payload?.excludedRowNumbers).toEqual([3, 4, 5]);
    expect(payload?.acceptedDuplicateCodes).toEqual([]);
    expect(deriveSelection(state).total).toBe('10.5');
  });

  it('resolves a duplicate by excluding all but one of its rows by hand', () => {
    const state = wizardReducer(loaded, { type: 'toggleRow', rowNumber: 4 });
    expect(deriveSelection(state).unresolvedDuplicates).toEqual([]);
    expect(commitBlockers(state)).toEqual([]);
  });

  it('clearing a decision blocks the commit again', () => {
    const kept = wizardReducer(loaded, { type: 'decide', code: 'B-2', decision: 'keep' });
    const cleared = wizardReducer(kept, { type: 'decide', code: 'B-2', decision: null });
    expect(commitBlockers(cleared)).toEqual(['unresolvedDuplicates']);
  });
});

describe('commit gating', () => {
  it('requires the work-order number', () => {
    const state = run([
      { type: 'previewLoaded', preview: preview() },
      { type: 'setExcludeErrorRows', value: true },
      { type: 'decide', code: 'B-2', decision: 'keep' },
    ]);
    expect(commitBlockers(state)).toEqual(['headerInvalid']);
  });

  it('blocks on rows with errors that are still included', () => {
    const state = run([
      { type: 'previewLoaded', preview: preview() },
      { type: 'decide', code: 'B-2', decision: 'keep' },
      withHeader,
    ]);
    expect(commitBlockers(state)).toEqual(['errorRows']);
  });

  it('blocks when everything is excluded', () => {
    const state = run([
      { type: 'previewLoaded', preview: preview() },
      { type: 'decide', code: 'B-2', decision: 'exclude' },
      { type: 'toggleRow', rowNumber: 2 },
      { type: 'toggleRow', rowNumber: 5 },
      withHeader,
    ]);
    expect(commitBlockers(state)).toEqual(['noRows']);
  });

  it('blocks on file issues, missing header row and unmapped required fields', () => {
    const bad = preview({
      headerRow: null,
      fileIssues: [{ code: 'HEADER_ROW_NOT_FOUND', field: null }],
      mapping: { ...MAPPING, code: null, unitPrice: 3 },
      rows: [],
    });
    const state = run([{ type: 'previewLoaded', preview: bad }, withHeader]);
    expect(commitBlockers(state)).toEqual(
      expect.arrayContaining(['fileIssues', 'noHeaderRow', 'mappingIncomplete', 'noRows']),
    );
  });
});

describe('mapping draft', () => {
  it('blocks the commit while the draft was not re-read, and resets decisions on a new read', () => {
    let state = run([
      { type: 'previewLoaded', preview: preview() },
      { type: 'toggleRow', rowNumber: 2 },
      { type: 'setMapping', field: 'amount', column: 6 },
    ]);
    expect(isDraftApplied(state)).toBe(false);
    expect(commitBlockers(state)).toContain('draftNotApplied');

    state = wizardReducer(state, {
      type: 'previewLoaded',
      preview: preview({ mapping: { ...preview().mapping, amount: 6 } }),
    });
    expect(isDraftApplied(state)).toBe(true);
    expect(state.excludedRows).toEqual([]);
  });

  it('switching sheet asks for header auto-detection again', () => {
    const state = run([
      { type: 'previewLoaded', preview: preview() },
      { type: 'setSheet', sheetName: 'Other' },
    ]);
    expect(state.draft).toMatchObject({ sheetName: 'Other', headerRow: null });
  });
});

describe('heading rows (contract BOQ)', () => {
  const heading = (rowNumber: number, code: string): ImportPreviewRow => ({
    ...row(rowNumber, code, null),
    kind: 'heading',
    unit: null,
    quantity: null,
    unitPrice: null,
    workType: null,
    raw: {
      code,
      description: `Section ${code}`,
      unit: null,
      quantity: null,
      unitPrice: null,
      workType: null,
      amount: null,
    },
  });

  function headingsOnly(): WorkOrderImportPreviewResponse {
    const base = preview();
    return {
      ...base,
      rows: [heading(2, '1'), heading(3, '1-1')],
      summary: {
        ...base.summary,
        rowCount: 2,
        headingCount: 2,
        errorRowCount: 0,
        warningRowCount: 0,
        duplicateCodes: [],
        total: '0',
      },
    };
  }

  it('counts headings from the summary, never as errors, and not in the total', () => {
    const base = preview();
    const state = run([
      {
        type: 'previewLoaded',
        preview: {
          ...base,
          rows: [heading(2, '1'), ...base.rows.slice(0, 1)],
          summary: { ...base.summary, rowCount: 2, headingCount: 1, duplicateCodes: [] },
        },
      },
    ]);
    const selection = deriveSelection(state);
    expect(selection.counts.headingRows).toBe(1);
    expect(selection.counts.errorRows).toBe(0);
    expect(selection.total).toBe('10.5');
  });

  it('a work order needs an item row (headings are skipped); a contract keeps the headings', () => {
    const state = run([{ type: 'previewLoaded', preview: headingsOnly() }, withHeader]);
    expect(commitBlockers(state)).toEqual(['noRows']);
    expect(commitBlockers(state, { target: 'contract' })).toEqual([]);
  });

  it('the contract payload has no work-order header and carries the expected version', () => {
    const state = run([{ type: 'previewLoaded', preview: headingsOnly() }]);
    const payload = buildContractCommitPayload(state, 4);
    expect(payload).toMatchObject({ expectedVersion: 4, excludedRowNumbers: [] });
    expect(payload).not.toHaveProperty('workOrder');
    expect(buildContractCommitPayload(INITIAL_WIZARD_STATE, 4)).toBeNull();
  });
});
