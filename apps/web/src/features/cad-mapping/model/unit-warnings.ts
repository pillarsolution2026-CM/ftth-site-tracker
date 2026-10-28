import type { CrsDetection, DrawingUnit } from '@ftth/shared';

export type UnitWarning =
  | { kind: 'conflict'; declared: DrawingUnit | null; implied: DrawingUnit | null }
  | { kind: 'differsDeclared'; chosen: DrawingUnit; declared: DrawingUnit }
  | { kind: 'differsImplied'; chosen: DrawingUnit; implied: DrawingUnit };

/**
 * Warnings about the drawing unit (ADR-018). The unit has no default, so it is the PM's choice;
 * we only point out when it disagrees with what the file declares (`$INSUNITS`) or with what the
 * extents imply (UTM = metres), and when the file itself already contradicts its coordinates.
 * Nothing here blocks saving.
 */
export function unitWarnings(
  detection: CrsDetection | null,
  chosen: DrawingUnit | null,
): UnitWarning[] {
  if (!detection) return [];
  const warnings: UnitWarning[] = [];
  if (detection.unitsConflict) {
    warnings.push({
      kind: 'conflict',
      declared: detection.declaredUnit,
      implied: detection.impliedUnit,
    });
  }
  if (chosen && detection.declaredUnit && chosen !== detection.declaredUnit) {
    warnings.push({ kind: 'differsDeclared', chosen, declared: detection.declaredUnit });
  }
  if (chosen && detection.impliedUnit && chosen !== detection.impliedUnit) {
    warnings.push({ kind: 'differsImplied', chosen, implied: detection.impliedUnit });
  }
  return warnings;
}
