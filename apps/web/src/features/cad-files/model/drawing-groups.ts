import { DRAWING_KINDS, type CadFileSummary, type DrawingKind } from '@ftth/shared';

export function isSuperseded(file: Pick<CadFileSummary, 'supersededAt'>): boolean {
  return file.supersededAt !== null;
}

/**
 * The two sections of the file list (ADR-040): the current file(s) of each kind, newest first.
 * Older versions stay in the system as history but are not listed (owner 2026-11-11); the API
 * already leaves them out, this keeps the list right if one ever arrives.
 */
export function groupByKind(
  files: readonly CadFileSummary[],
): Record<DrawingKind, CadFileSummary[]> {
  const groups = { general: [], secondary: [] } as Record<DrawingKind, CadFileSummary[]>;
  for (const kind of DRAWING_KINDS) {
    groups[kind] = files
      .filter((file) => file.drawingKind === kind && !isSuperseded(file))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  return groups;
}
