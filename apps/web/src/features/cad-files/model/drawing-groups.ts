import { DRAWING_KINDS, type CadFileSummary, type DrawingKind } from '@ftth/shared';

export function isSuperseded(file: Pick<CadFileSummary, 'supersededAt'>): boolean {
  return file.supersededAt !== null;
}

/**
 * The two sections of the file list (ADR-040): files of each kind, the current version first,
 * then the older versions (newest first).
 */
export function groupByKind(
  files: readonly CadFileSummary[],
): Record<DrawingKind, CadFileSummary[]> {
  const groups = { general: [], secondary: [] } as Record<DrawingKind, CadFileSummary[]>;
  for (const kind of DRAWING_KINDS) {
    groups[kind] = files
      .filter((file) => file.drawingKind === kind)
      .sort((a, b) => {
        if (isSuperseded(a) !== isSuperseded(b)) return isSuperseded(a) ? 1 : -1;
        return b.createdAt.localeCompare(a.createdAt);
      });
  }
  return groups;
}
