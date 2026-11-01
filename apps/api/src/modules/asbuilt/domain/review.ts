import type { AsBuiltEditKind, AsBuiltEditStatus, AsBuiltReviewRefusal } from '@ftth/shared';

/** Which approved version an edit of this kind is drawn on (adds have none). */
export function versionAxisOf(kind: AsBuiltEditKind): 'geometry' | 'label' | null {
  if (kind === 'move' || kind === 'reshape') return 'geometry';
  if (kind === 'label') return 'label';
  return null;
}

export interface ApprovedVersions {
  geometryVersion: number;
  labelVersion: number;
}

export interface ReviewFacts {
  status: AsBuiltEditStatus;
  kind: AsBuiltEditKind;
  baseVersion: number | null;
  /** The user who recorded the edit and the user reviewing it. */
  editorId: string;
  reviewerId: string;
  current: ApprovedVersions;
}

export type ReviewDecision =
  { ok: true; approvedVersion: number } | { ok: false; refusal: AsBuiltReviewRefusal };

/** True while the version the edit was drawn on is still the approved one (adds: always). */
export function isBaseCurrent(
  kind: AsBuiltEditKind,
  baseVersion: number | null,
  current: ApprovedVersions,
): boolean {
  const axis = versionAxisOf(kind);
  if (axis === null) return true;
  const now = axis === 'geometry' ? current.geometryVersion : current.labelVersion;
  return baseVersion === now;
}

/** The version recorded by `base_version`'s axis after approval: current + 1 (1 for an add). */
export function nextVersion(kind: AsBuiltEditKind, current: ApprovedVersions): number {
  const axis = versionAxisOf(kind);
  if (axis === null) return 1;
  return (axis === 'geometry' ? current.geometryVersion : current.labelVersion) + 1;
}

/**
 * Flags for the reviewer (ADR-030): BASE_OUTDATED when another edit of the same feature was
 * approved after the version this edit was drawn on. Never a rejection at record time.
 */
export function isBaseOutdated(
  kind: AsBuiltEditKind,
  baseVersion: number | null,
  current: ApprovedVersions,
): boolean {
  return !isBaseCurrent(kind, baseVersion, current);
}

/**
 * Review rules (phase-4 contracts). Nobody reviews an edit they recorded; only a pending edit
 * can be reviewed; an edit drawn on a version that is no longer current cannot be approved
 * (reject it, the supervisor redraws). Rejecting needs no base check.
 */
export function decideApproval(facts: ReviewFacts): ReviewDecision {
  if (facts.editorId === facts.reviewerId) return { ok: false, refusal: 'SELF_REVIEW' };
  if (facts.status !== 'pending') return { ok: false, refusal: 'NOT_PENDING' };
  if (!isBaseCurrent(facts.kind, facts.baseVersion, facts.current)) {
    return { ok: false, refusal: 'STALE_BASE' };
  }
  return { ok: true, approvedVersion: nextVersion(facts.kind, facts.current) };
}

export function decideRejection(
  facts: Pick<ReviewFacts, 'status' | 'editorId' | 'reviewerId'>,
): { ok: true } | { ok: false; refusal: AsBuiltReviewRefusal } {
  if (facts.editorId === facts.reviewerId) return { ok: false, refusal: 'SELF_REVIEW' };
  if (facts.status !== 'pending') return { ok: false, refusal: 'NOT_PENDING' };
  return { ok: true };
}
