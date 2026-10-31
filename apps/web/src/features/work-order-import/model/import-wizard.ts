import {
  ConfirmedColumnMappingSchema,
  IMPORT_FIELDS,
  REQUIRED_IMPORT_FIELDS,
  type ColumnMapping,
  type ContractImportCommitPayload,
  type ImportField,
  type ImportPreviewRow,
  type WorkOrderImportCommitPayload,
  type WorkOrderImportPreviewOptions,
  type WorkOrderImportPreviewResponse,
} from '@ftth/shared';
import { sumDecimals } from '@/shared/lib/decimal';
import {
  EMPTY_HEADER_FORM,
  headerPayload,
  validateHeader,
  type HeaderFormValues,
} from '@/features/work-orders/model/header-form';

/**
 * Import wizard state machine (pure). The server re-parses the file on commit, so the client
 * only records decisions: which rows to leave out, which duplicate codes to keep as separate lines.
 */

export type DuplicateDecision = 'exclude' | 'keep';

export interface WizardState {
  /** Preview of the file with the *applied* sheet/header row/mapping. */
  preview: WorkOrderImportPreviewResponse | null;
  /** Editable draft; differs from the preview until the user re-reads the file. */
  draft: { sheetName: string; headerRow: number | null; mapping: ColumnMapping } | null;
  /** Rows the user unchecked by hand. */
  excludedRows: number[];
  /** "Exclude rows with errors". */
  excludeErrorRows: boolean;
  decisions: Record<string, DuplicateDecision>;
  header: HeaderFormValues;
}

export const INITIAL_WIZARD_STATE: WizardState = {
  preview: null,
  draft: null,
  excludedRows: [],
  excludeErrorRows: false,
  decisions: {},
  header: EMPTY_HEADER_FORM,
};

export type WizardAction =
  | { type: 'previewLoaded'; preview: WorkOrderImportPreviewResponse }
  | { type: 'setSheet'; sheetName: string }
  | { type: 'setHeaderRow'; headerRow: number | null }
  | { type: 'setMapping'; field: ImportField; column: number | null }
  | { type: 'toggleRow'; rowNumber: number }
  | { type: 'setExcludeErrorRows'; value: boolean }
  | { type: 'decide'; code: string; decision: DuplicateDecision | null }
  | { type: 'setHeaderField'; field: keyof HeaderFormValues; value: string }
  | { type: 'reset' };

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'previewLoaded':
      // A new read changes the rows, so earlier row decisions no longer apply; the header stays.
      return {
        ...state,
        preview: action.preview,
        draft: {
          sheetName: action.preview.sheetName,
          headerRow: action.preview.headerRow,
          mapping: action.preview.mapping,
        },
        excludedRows: [],
        excludeErrorRows: false,
        decisions: {},
      };
    case 'setSheet':
      // Another sheet has its own header row and columns: fall back to auto-detection.
      return state.draft
        ? {
            ...state,
            draft: {
              sheetName: action.sheetName,
              headerRow: null,
              mapping: state.draft.mapping,
            },
          }
        : state;
    case 'setHeaderRow':
      return state.draft
        ? { ...state, draft: { ...state.draft, headerRow: action.headerRow } }
        : state;
    case 'setMapping':
      return state.draft
        ? {
            ...state,
            draft: {
              ...state.draft,
              mapping: { ...state.draft.mapping, [action.field]: action.column },
            },
          }
        : state;
    case 'toggleRow':
      return {
        ...state,
        excludedRows: state.excludedRows.includes(action.rowNumber)
          ? state.excludedRows.filter((row) => row !== action.rowNumber)
          : [...state.excludedRows, action.rowNumber],
      };
    case 'setExcludeErrorRows':
      return { ...state, excludeErrorRows: action.value };
    case 'decide': {
      const decisions = Object.fromEntries(
        Object.entries(state.decisions).filter(([code]) => code !== action.code),
      ) as Record<string, DuplicateDecision>;
      if (action.decision) decisions[action.code] = action.decision;
      return { ...state, decisions };
    }
    case 'setHeaderField':
      return { ...state, header: { ...state.header, [action.field]: action.value } };
    case 'reset':
      return INITIAL_WIZARD_STATE;
  }
}

// ---------- derived values ----------

export const hasErrors = (row: ImportPreviewRow): boolean =>
  row.issues.some((issue) => issue.severity === 'error');
export const isHeadingRow = (row: ImportPreviewRow): boolean => row.kind === 'heading';
export const hasWarnings = (row: ImportPreviewRow): boolean =>
  row.issues.some((issue) => issue.severity === 'warning');

export interface Selection {
  excluded: ReadonlySet<number>;
  included: ImportPreviewRow[];
  counts: {
    total: number;
    included: number;
    /** Section-heading rows of the sheet (contract BOQ; skipped by the work-order import). */
    headingRows: number;
    errorRows: number;
    warningRows: number;
  };
  /** Σ amount of included rows without errors (exact decimal string). */
  total: string;
  /** Included rows that still have errors: they block the commit. */
  blockingErrorRows: number[];
  /** Duplicate codes with two or more included rows and no "keep" decision. */
  unresolvedDuplicates: string[];
}

export function deriveSelection(state: WizardState): Selection {
  const rows = state.preview?.rows ?? [];
  const excluded = new Set<number>(state.excludedRows);
  if (state.excludeErrorRows) {
    for (const row of rows) if (hasErrors(row)) excluded.add(row.rowNumber);
  }
  for (const duplicate of state.preview?.summary.duplicateCodes ?? []) {
    if (state.decisions[duplicate.code] === 'exclude') {
      for (const rowNumber of duplicate.rowNumbers) excluded.add(rowNumber);
    }
  }
  const included = rows.filter((row) => !excluded.has(row.rowNumber));
  const includedNumbers = new Set(included.map((row) => row.rowNumber));
  const unresolvedDuplicates = (state.preview?.summary.duplicateCodes ?? [])
    .filter(
      (duplicate) =>
        duplicate.rowNumbers.filter((n) => includedNumbers.has(n)).length >= 2 &&
        state.decisions[duplicate.code] !== 'keep',
    )
    .map((duplicate) => duplicate.code);

  return {
    excluded,
    included,
    counts: {
      total: rows.length,
      included: included.length,
      headingRows: state.preview?.summary.headingCount ?? rows.filter(isHeadingRow).length,
      errorRows: rows.filter(hasErrors).length,
      warningRows: rows.filter(hasWarnings).length,
    },
    total: sumDecimals(
      included.flatMap((row) => (!hasErrors(row) && row.amount !== null ? [row.amount] : [])),
    ),
    blockingErrorRows: included.filter(hasErrors).map((row) => row.rowNumber),
    unresolvedDuplicates,
  };
}

export function isDraftApplied(state: WizardState): boolean {
  const { preview, draft } = state;
  if (!preview || !draft) return true;
  return (
    draft.sheetName === preview.sheetName &&
    draft.headerRow === preview.headerRow &&
    IMPORT_FIELDS.every((field) => draft.mapping[field] === preview.mapping[field])
  );
}

export function mappingProblems(mapping: ColumnMapping): {
  unmapped: ImportField[];
  duplicated: number[];
} {
  const unmapped = REQUIRED_IMPORT_FIELDS.filter((field) => mapping[field] === null);
  const used = IMPORT_FIELDS.flatMap((field) => (mapping[field] === null ? [] : [mapping[field]]));
  const duplicated = [...new Set(used.filter((value, index) => used.indexOf(value) !== index))];
  return { unmapped, duplicated: duplicated.filter((v): v is number => v !== null) };
}

/** Options for re-reading the file with the user's draft. */
export function previewOptionsFromDraft(state: WizardState): WorkOrderImportPreviewOptions {
  const { draft } = state;
  if (!draft) return {};
  return {
    sheetName: draft.sheetName,
    ...(draft.headerRow !== null ? { headerRow: draft.headerRow } : {}),
    mapping: draft.mapping,
  };
}

export type CommitBlocker =
  | 'draftNotApplied'
  | 'fileIssues'
  | 'noHeaderRow'
  | 'mappingIncomplete'
  | 'headerInvalid'
  | 'noRows'
  | 'errorRows'
  | 'unresolvedDuplicates';

export interface CommitOptions {
  /**
   * `workOrder` (default) needs the work-order header and at least one item row (headings are
   * skipped). `contract` has no header step and also stores heading rows.
   */
  target?: 'workOrder' | 'contract';
}

export function commitBlockers(state: WizardState, options: CommitOptions = {}): CommitBlocker[] {
  const contract = options.target === 'contract';
  const { preview } = state;
  if (!preview) return ['noRows'];
  const blockers: CommitBlocker[] = [];
  const selection = deriveSelection(state);
  if (!isDraftApplied(state)) blockers.push('draftNotApplied');
  if (preview.fileIssues.length > 0) blockers.push('fileIssues');
  if (preview.headerRow === null) blockers.push('noHeaderRow');
  const problems = mappingProblems(preview.mapping);
  if (problems.unmapped.length > 0 || problems.duplicated.length > 0) {
    blockers.push('mappingIncomplete');
  }
  if (!contract && Object.keys(validateHeader(state.header)).length > 0) {
    blockers.push('headerInvalid');
  }
  const counting = contract
    ? selection.included
    : selection.included.filter((row) => !isHeadingRow(row));
  if (counting.length === 0) blockers.push('noRows');
  if (selection.blockingErrorRows.length > 0) blockers.push('errorRows');
  // Work orders have no duplicate decision since ADR-028: a repeated code is an error row.
  if (contract && selection.unresolvedDuplicates.length > 0) blockers.push('unresolvedDuplicates');
  return blockers;
}

/** The payload for the commit call, or null while something blocks it. */
export function buildCommitPayload(state: WizardState):
  | (Omit<WorkOrderImportCommitPayload, 'workOrder'> & {
      workOrder: ReturnType<typeof headerPayload>;
    })
  | null {
  const { preview } = state;
  if (!preview || preview.headerRow === null || commitBlockers(state).length > 0) return null;
  const mapping = ConfirmedColumnMappingSchema.safeParse(preview.mapping);
  if (!mapping.success) return null;
  const selection = deriveSelection(state);
  return {
    fileSha256: preview.file.sha256,
    sheetName: preview.sheetName,
    headerRow: preview.headerRow,
    mapping: mapping.data,
    excludedRowNumbers: [...selection.excluded].sort((a, b) => a - b),
    // Ignored by the server since ADR-028 (a repeated code is the error CODE_REPEATED).
    acceptedDuplicateCodes: [],
    workOrder: headerPayload(state.header),
  };
}

/** Commit payload of the contract BOQ import (no work-order header; replaces every line). */
export function buildContractCommitPayload(
  state: WizardState,
  expectedVersion: number,
): ContractImportCommitPayload | null {
  const { preview } = state;
  if (!preview || preview.headerRow === null) return null;
  if (commitBlockers(state, { target: 'contract' }).length > 0) return null;
  const mapping = ConfirmedColumnMappingSchema.safeParse(preview.mapping);
  if (!mapping.success) return null;
  const selection = deriveSelection(state);
  return {
    fileSha256: preview.file.sha256,
    sheetName: preview.sheetName,
    headerRow: preview.headerRow,
    mapping: mapping.data,
    excludedRowNumbers: [...selection.excluded].sort((a, b) => a - b),
    acceptedDuplicateCodes: Object.entries(state.decisions)
      .filter(([, decision]) => decision === 'keep')
      .map(([code]) => code),
    expectedVersion,
  };
}
