import {
  PUBLISH_CHECK_KEYS,
  compareCabinets,
  type CabinetsComparison,
  type DrawingKind,
  type InstallationReport,
  type Placement,
  type PublishBlockedDetails,
  type PublishCheck,
  type PublishReadiness,
} from '@ftth/shared';
import type { OpenItems } from './design-revision.repository.js';

/** What the publish rules (ADR-038) are decided from, for one drawing. */
export interface PublishFacts {
  status: string;
  drawingKind: DrawingKind;
  placement: Placement | null;
  /** Places of BLOCKING problems only (`problemTotals`, ADR-041). */
  problemTotal: number;
  /** Places of non-blocking problems (warnings); shown, never block. */
  warningTotal: number;
  /** `code` (name) of each SUB cabinet of the drawing, null when unnamed (ADR-041). */
  subCabinets: (string | null)[];
  /** The installation check (ADR-042): `applies` false and ok on a Secondary. */
  installation: InstallationReport;
  open: OpenItems;
}

/** The other drawing's open draft with its facts, or null when there is none (ADR-040). */
export interface OtherDraft {
  revisionId: string;
  facts: PublishFacts;
}

const pointsInUse = (placement: Placement | null): number =>
  placement ? placement.points.filter((p) => !p.excluded).length : 0;

const openTotalOf = (open: OpenItems): number => open.textLinksToReview + open.diffConflicts;

/** Coordinates and drawing errors of one drawing: the checks that need no acknowledgement. */
const ownChecksOk = (facts: PublishFacts): boolean =>
  facts.placement !== null &&
  pointsInUse(facts.placement) >= 1 &&
  facts.problemTotal === 0 &&
  facts.installation.ok;

/** The sub cabinets of the pair compared by name, always as general vs secondary. */
export function cabinetsOf(facts: PublishFacts, other: PublishFacts): CabinetsComparison {
  return facts.drawingKind === 'general'
    ? compareCabinets(facts.subCabinets, other.subCabinets)
    : compareCabinets(other.subCabinets, facts.subCabinets);
}

const unmatchedCabinets = (c: CabinetsComparison): number =>
  c.general.unnamed +
  c.secondary.unnamed +
  c.general.missingInOther.length +
  c.secondary.missingInOther.length;

/**
 * The checklist shown before publishing, in PUBLISH_CHECK_KEYS order. The first three checks are
 * this drawing's; `open_items` sums both drawings; `other_drawing` is ok when the other kind has a
 * draft that passes its own first three checks (ADR-040).
 */
export function publishReadiness(facts: PublishFacts, other: OtherDraft | null): PublishReadiness {
  const inUse = pointsInUse(facts.placement);
  const openTotal = openTotalOf(facts.open) + (other ? openTotalOf(other.facts.open) : 0);
  const cabinets = other ? cabinetsOf(facts, other.facts) : null;
  const byKey: Record<(typeof PUBLISH_CHECK_KEYS)[number], PublishCheck> = {
    crs_known: { key: 'crs_known', ok: facts.placement !== null, count: null },
    control_point: { key: 'control_point', ok: inUse >= 1, count: inUse },
    no_problems: { key: 'no_problems', ok: facts.problemTotal === 0, count: facts.problemTotal },
    open_items: { key: 'open_items', ok: openTotal === 0, count: openTotal },
    other_drawing: {
      key: 'other_drawing',
      ok: other !== null && ownChecksOk(other.facts),
      count: other ? other.facts.problemTotal : null,
    },
    cabinets_match: {
      key: 'cabinets_match',
      ok: cabinets?.ok ?? false,
      count: cabinets ? unmatchedCabinets(cabinets) : null,
    },
    installation: {
      key: 'installation',
      ok: facts.installation.ok,
      count: facts.installation.applies ? facts.installation.issueCount : null,
    },
  };
  const checks = PUBLISH_CHECK_KEYS.map((key) => byKey[key]);
  return {
    checks,
    canPublish: facts.status === 'draft' && checks.every((c) => c.key === 'open_items' || c.ok),
    drawingKind: facts.drawingKind,
    otherRevisionId: other?.revisionId ?? null,
    needsAcknowledgement: openTotal > 0,
    cabinets,
    warningCount: facts.warningTotal,
    installation: facts.installation.applies ? facts.installation : null,
  };
}

/** The first hard blocker of one drawing (coordinates, then drawing errors), or null. */
export function drawingBlocker(facts: PublishFacts): PublishBlockedDetails | null {
  const drawingKind = facts.drawingKind;
  if (facts.placement === null) return { reason: 'CRS_UNKNOWN', drawingKind };
  if (pointsInUse(facts.placement) < 1) return { reason: 'PLACEMENT_MISSING', drawingKind };
  if (facts.problemTotal > 0) {
    return { reason: 'PROBLEMS_OPEN', drawingKind, problemCount: facts.problemTotal };
  }
  if (!facts.installation.ok) {
    return {
      reason: 'INSTALLATION_UNCLEAR',
      drawingKind: 'general',
      issueCount: facts.installation.issueCount,
      issues: facts.installation.issues,
    };
  }
  return null;
}

/**
 * The first hard blocker of the pair: this drawing's, then the other's, then the shared cabinets
 * (ADR-041). Open items are separate.
 */
export function publishBlocker(
  facts: PublishFacts,
  other: PublishFacts,
): PublishBlockedDetails | null {
  const own = drawingBlocker(facts) ?? drawingBlocker(other);
  if (own) return own;
  const cabinets = cabinetsOf(facts, other);
  return cabinets.ok ? null : { reason: 'CABINETS_MISMATCH', cabinets };
}

/** Open items of both drawings, summed. */
export function pairOpenItems(facts: PublishFacts, other: PublishFacts): OpenItems {
  return {
    textLinksToReview: facts.open.textLinksToReview + other.open.textLinksToReview,
    diffConflicts: facts.open.diffConflicts + other.open.diffConflicts,
  };
}
