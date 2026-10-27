import {
  WorkOrderImportCommitPayloadSchema,
  type ImportPreviewRow,
  type WorkOrderImportPreviewResponse,
} from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import {
  INITIAL_WIZARD_STATE,
  buildCommitPayload,
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
    raw: { code, description: 'd', unit: 'm', quantity: '1', unitPrice: '1', amount: null },
    code,
    description: 'd',
    unit: 'm',
    quantity: '1',
    unitPrice: '1',
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

function preview(
  overrides: Partial<WorkOrderImportPreviewResponse> = {},
): WorkOrderImportPreviewResponse {
  return {
    file: { name: 'wo.xlsx', sizeBytes: 100, sha256: SHA },
    sheets: [{ name: 'Sheet1', rowCount: 5 }],
    sheetName: 'Sheet1',
    headerRow: 1,
    columns: [],
    suggestedMapping: { code: 0, description: 1, unit: 2, quantity: 3, unitPrice: 4, amount: null },
    mapping: { code: 0, description: 1, unit: 2, quantity: 3, unitPrice: 4, amount: null },
    fileIssues: [],
    rows: [
      row(2, 'A-1', '10.5'),
      row(3, 'B-2', '0.1', [duplicateIssue('4')]),
      row(4, 'B-2', '0.2', [duplicateIssue('3')]),
      row(5, 'C-3', null, [missingQuantity]),
    ],
    summary: {
      rowCount: 4,
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
    expect(selection.counts).toEqual({ total: 4, included: 4, errorRows: 1, warningRows: 2 });
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
      mapping: { code: null, description: 1, unit: 2, quantity: 3, unitPrice: 3, amount: null },
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
      { type: 'setMapping', field: 'amount', column: 5 },
    ]);
    expect(isDraftApplied(state)).toBe(false);
    expect(commitBlockers(state)).toContain('draftNotApplied');

    state = wizardReducer(state, {
      type: 'previewLoaded',
      preview: preview({ mapping: { ...preview().mapping, amount: 5 } }),
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
