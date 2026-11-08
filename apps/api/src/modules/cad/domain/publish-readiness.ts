import {
  PUBLISH_CHECK_KEYS,
  type Placement,
  type PublishBlockedDetails,
  type PublishCheck,
  type PublishReadiness,
} from '@ftth/shared';
import type { OpenItems } from './design-revision.repository.js';

/** What the publish rules (ADR-038) are decided from; the one input to readiness and the gate. */
export interface PublishFacts {
  status: string;
  placement: Placement | null;
  /** Sum of every problem's `count` (each place). */
  problemTotal: number;
  open: OpenItems;
}

const pointsInUse = (placement: Placement | null): number =>
  placement ? placement.points.filter((p) => !p.excluded).length : 0;

/** The checklist shown before publishing, in PUBLISH_CHECK_KEYS order. */
export function publishReadiness(facts: PublishFacts): PublishReadiness {
  const inUse = pointsInUse(facts.placement);
  const openTotal = facts.open.textLinksToReview + facts.open.diffConflicts;
  const byKey: Record<(typeof PUBLISH_CHECK_KEYS)[number], PublishCheck> = {
    crs_known: { key: 'crs_known', ok: facts.placement !== null, count: null },
    control_point: { key: 'control_point', ok: inUse >= 1, count: inUse },
    no_problems: { key: 'no_problems', ok: facts.problemTotal === 0, count: facts.problemTotal },
    open_items: { key: 'open_items', ok: openTotal === 0, count: openTotal },
  };
  const checks = PUBLISH_CHECK_KEYS.map((key) => byKey[key]);
  return {
    checks,
    canPublish: facts.status === 'draft' && checks.slice(0, 3).every((c) => c.ok),
    needsAcknowledgement: openTotal > 0,
  };
}

/** The first hard blocker (coordinates, then drawing errors), or null. Open items are separate. */
export function publishBlocker(facts: PublishFacts): PublishBlockedDetails | null {
  if (facts.placement === null) return { reason: 'CRS_UNKNOWN' };
  if (pointsInUse(facts.placement) < 1) return { reason: 'PLACEMENT_MISSING' };
  if (facts.problemTotal > 0) return { reason: 'PROBLEMS_OPEN', problemCount: facts.problemTotal };
  return null;
}
