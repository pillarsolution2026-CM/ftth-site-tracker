import { CLOCK_SKEW_TOLERANCE_MS, type AsBuiltEditFlag, type AsBuiltEditKind } from '@ftth/shared';
import { isBaseOutdated, type ApprovedVersions } from '../../asbuilt/domain/review.js';

/**
 * ADR-054 (security review M2): how far beyond the extent of the design features of a drawing an
 * As-Built geometry may reach before it is flagged OUTSIDE_DRAWING, in metres of the project CRS.
 * Technical tolerance, not a business rule.
 */
export const OUTSIDE_DRAWING_TOLERANCE_M = 50;

export interface AsBuiltFlagFacts {
  kind: AsBuiltEditKind;
  /** Null for `add_*`. */
  baseVersion: number | null;
  /** Approved versions of the feature at receipt (0/0 when nothing is approved). */
  current: ApprovedVersions;
  capturedAt: Date;
  receivedAt: Date;
  revisionIsLatest: boolean;
  featureInLatestRevision: boolean;
  /** A supervisor's proposed geometry reaches outside the drawing it is recorded on. */
  outsideDrawing?: boolean;
}

/**
 * Flags for the reviewer (ADR-030). Never a reason to reject an edit: a business conflict goes to
 * review, where a stale base is refused at approval time.
 */
export function computeAsBuiltFlags(facts: AsBuiltFlagFacts): AsBuiltEditFlag[] {
  const flags: AsBuiltEditFlag[] = [];
  if (isBaseOutdated(facts.kind, facts.baseVersion, facts.current)) flags.push('BASE_OUTDATED');
  if (!facts.revisionIsLatest) flags.push('REVISION_OUTDATED');
  if (!facts.featureInLatestRevision) flags.push('FEATURE_REMOVED');
  if (facts.capturedAt.getTime() > facts.receivedAt.getTime() + CLOCK_SKEW_TOLERANCE_MS) {
    flags.push('CLOCK_AHEAD');
  }
  if (facts.outsideDrawing) flags.push('OUTSIDE_DRAWING');
  return flags;
}
