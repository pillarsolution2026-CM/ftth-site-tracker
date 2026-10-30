import { CLOCK_SKEW_TOLERANCE_MS, type UpdateFlag } from '@ftth/shared';

export interface FlagFacts {
  capturedAt: Date;
  receivedAt: Date;
  /** Publication time of the revision the device worked on. */
  revisionPublishedAt: Date;
  /** Distance from the GPS fix to the feature in metres, or null without a fix. */
  gpsDistanceM: number | null;
  gpsWarningDistanceM: number;
  /** At least one item's recorded quantity (incl. this update) exceeds its work-order quantity. */
  itemOverrun: boolean;
  revisionIsLatest: boolean;
  featureInLatestRevision: boolean;
}

/**
 * Flags for QC (ADR-024). Never a reason to reject: the supervisor already saw the client-side
 * warnings, and only QC can judge the case.
 */
export function computeUpdateFlags(facts: FlagFacts): UpdateFlag[] {
  const flags: UpdateFlag[] = [];
  if (facts.capturedAt.getTime() > facts.receivedAt.getTime() + CLOCK_SKEW_TOLERANCE_MS) {
    flags.push('CLOCK_AHEAD');
  }
  if (facts.capturedAt.getTime() < facts.revisionPublishedAt.getTime()) flags.push('CLOCK_BEHIND');
  if (facts.gpsDistanceM === null) flags.push('GPS_MISSING');
  else if (facts.gpsDistanceM > facts.gpsWarningDistanceM) flags.push('GPS_FAR');
  if (facts.itemOverrun) flags.push('ITEM_OVERRUN');
  if (!facts.revisionIsLatest) flags.push('REVISION_OUTDATED');
  if (!facts.featureInLatestRevision) flags.push('FEATURE_REMOVED');
  return flags;
}
