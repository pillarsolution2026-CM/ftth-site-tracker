import {
  PUBLISH_CHECK_KEYS,
  cabinetNameKey,
  compareSiteCabinets,
  type BoxTypesReport,
  type CabinetInOtherSite,
  type DrawingFlow,
  type DrawingKind,
  type DrawingNotReadyState,
  type InstallationReport,
  type Placement,
  type PublishBlockedDetails,
  type PublishCheck,
  type PublishCheckKey,
  type PublishDrawingReadiness,
  type PublishReadiness,
  type SiteCabinetsComparison,
} from '@ftth/shared';
import type { OpenItems } from './design-revision.repository.js';

/** What the publish rules (ADR-038) are decided from, for one draft. */
export interface PublishFacts {
  status: string;
  drawingKind: DrawingKind;
  drawingId: string;
  ordinal: number;
  placement: Placement | null;
  /** Places of BLOCKING problems only (`problemTotals`, ADR-041). */
  problemTotal: number;
  /** Places of non-blocking problems (warnings); shown, never block. */
  warningTotal: number;
  /** The installation check (ADR-042): `applies` false and ok on a Secondary. */
  installation: InstallationReport;
  /** The box-types check (ADR-043): `applies` false and ok on a General / legacy-mode Secondary. */
  boxTypes: BoxTypesReport;
  open: OpenItems;
}

/** One non-withdrawn drawing of the site and what it brings to a site publication (ADR-049 B). */
export interface SiteDrawingFacts {
  drawingId: string;
  kind: DrawingKind;
  ordinal: number;
  /** The draft that would be published; null when the drawing has none. */
  draft: { revisionId: string; facts: PublishFacts } | null;
  hasPublished: boolean;
  /** Set when the drawing has no draft and no published revision, or is queued / building. */
  notReady: DrawingNotReadyState | null;
  /** `code` of each sub cabinet of the EFFECTIVE revision (draft, else latest published); null: none. */
  subCabinets: (string | null)[] | null;
}

export interface OtherSiteCabinets {
  siteId: string;
  siteName: string;
  names: (string | null)[];
}

/** Everything the site rules are decided from. Drawings are in General-first order. */
export interface SiteFacts {
  siteId: string;
  drawings: SiteDrawingFacts[];
  /** Generals of the other sites of the work order with their effective sub cabinets. */
  otherSites: OtherSiteCabinets[];
}

const pointsInUse = (placement: Placement | null): number =>
  placement ? placement.points.filter((p) => !p.excluded).length : 0;

const openTotalOf = (open: OpenItems): number => open.textLinksToReview + open.diffConflicts;

export const draftsOf = (site: SiteFacts) =>
  site.drawings.flatMap((d) => (d.draft ? [{ drawing: d, ...d.draft }] : []));

/** The kinds the site lacks (its drawings are the non-withdrawn ones). */
export const siteMissingKinds = (site: SiteFacts): DrawingKind[] => {
  const kinds: DrawingKind[] = [];
  if (!site.drawings.some((d) => d.kind === 'general')) kinds.push('general');
  if (!site.drawings.some((d) => d.kind === 'secondary')) kinds.push('secondary');
  return kinds;
};

/** The General's sub cabinets against the union of the Secondaries' (null without a General). */
export function siteCabinetsOf(site: SiteFacts): SiteCabinetsComparison | null {
  const general = site.drawings.find((d) => d.kind === 'general');
  if (!general) return null;
  return compareSiteCabinets(
    { drawingId: general.drawingId, names: general.subCabinets ?? [] },
    site.drawings
      .filter((d) => d.kind === 'secondary')
      .map((d) => ({ drawingId: d.drawingId, ordinal: d.ordinal, names: d.subCabinets ?? [] })),
  );
}

const unmatchedCabinets = (c: SiteCabinetsComparison): number =>
  c.general.unnamed +
  c.secondaries.reduce((sum, s) => sum + s.side.unnamed, 0) +
  c.inSeveralSecondaries.length +
  c.missingInGeneral.length +
  c.missingInSecondaries.length;

/** Names of the site's General that another site of the work order already has (owner rule). */
export function cabinetsInOtherSites(site: SiteFacts): CabinetInOtherSite[] {
  const general = site.drawings.find((d) => d.kind === 'general');
  const mine = new Map<string, string>();
  for (const name of general?.subCabinets ?? []) {
    if (name !== null) mine.set(cabinetNameKey(name), name);
  }
  const found: CabinetInOtherSite[] = [];
  for (const other of site.otherSites) {
    const seen = new Set<string>();
    for (const name of other.names) {
      if (name === null) continue;
      const key = cabinetNameKey(name);
      if (mine.has(key) && !seen.has(key)) {
        seen.add(key);
        found.push({
          name: mine.get(key) ?? name,
          otherSiteId: other.siteId,
          otherSiteName: other.siteName,
        });
      }
    }
  }
  return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Open items of the drafts of the site, summed. */
export function siteOpenItems(site: SiteFacts): OpenItems {
  return draftsOf(site).reduce<OpenItems>(
    (sum, d) => ({
      textLinksToReview: sum.textLinksToReview + d.facts.open.textLinksToReview,
      diffConflicts: sum.diffConflicts + d.facts.open.diffConflicts,
    }),
    { textLinksToReview: 0, diffConflicts: 0 },
  );
}

/** The first hard blocker of one draft (coordinates, drawing errors, installation, box types). */
export function drawingBlocker(facts: PublishFacts): PublishBlockedDetails | null {
  const ref = {
    drawingKind: facts.drawingKind,
    drawingId: facts.drawingId,
    ordinal: facts.ordinal,
  };
  if (facts.placement === null) return { reason: 'CRS_UNKNOWN', ...ref };
  if (pointsInUse(facts.placement) < 1) return { reason: 'PLACEMENT_MISSING', ...ref };
  if (facts.problemTotal > 0) {
    return { reason: 'PROBLEMS_OPEN', ...ref, problemCount: facts.problemTotal };
  }
  if (!facts.installation.ok) {
    return {
      reason: 'INSTALLATION_UNCLEAR',
      ...ref,
      drawingKind: 'general',
      issueCount: facts.installation.issueCount,
      issues: facts.installation.issues,
    };
  }
  if (!facts.boxTypes.ok) {
    return {
      reason: 'BOX_TYPES_UNCLEAR',
      ...ref,
      drawingKind: 'secondary',
      issueCount: facts.boxTypes.issueCount,
      issues: facts.boxTypes.issues,
    };
  }
  return null;
}

/**
 * The first hard blocker of a site publication, in the order of the contract: SITE_INCOMPLETE,
 * DRAWING_NOT_READY, each draft's own checks (General, Secondary 1, 2, …), the cabinets of the
 * site, the cabinets of other sites. Open items are separate (`siteOpenItems`).
 */
export function siteBlocker(site: SiteFacts): PublishBlockedDetails | null {
  const missing = siteMissingKinds(site);
  if (missing.length > 0) {
    return { reason: 'SITE_INCOMPLETE', siteId: site.siteId, missingKinds: missing };
  }
  for (const d of site.drawings) {
    if (d.notReady !== null) {
      return {
        reason: 'DRAWING_NOT_READY',
        drawingKind: d.kind,
        drawingId: d.drawingId,
        ordinal: d.ordinal,
        state: d.notReady,
      };
    }
  }
  for (const d of site.drawings) {
    const blocker = d.draft ? drawingBlocker(d.draft.facts) : null;
    if (blocker) return blocker;
  }
  const cabinets = siteCabinetsOf(site);
  if (cabinets && !cabinets.ok) return { reason: 'CABINETS_MISMATCH', cabinets };
  const elsewhere = cabinetsInOtherSites(site);
  if (elsewhere.length > 0) return { reason: 'CABINET_IN_OTHER_SITE', cabinets: elsewhere };
  return null;
}

const ownChecks = (facts: PublishFacts): PublishCheck[] => {
  const inUse = pointsInUse(facts.placement);
  return [
    { key: 'crs_known', ok: facts.placement !== null, count: null },
    { key: 'control_point', ok: inUse >= 1, count: inUse },
    { key: 'no_problems', ok: facts.problemTotal === 0, count: facts.problemTotal },
    {
      key: 'installation',
      ok: facts.installation.ok,
      count: facts.installation.applies ? facts.installation.issueCount : null,
    },
    {
      key: 'box_types',
      ok: facts.boxTypes.ok,
      count: facts.boxTypes.applies ? facts.boxTypes.issueCount : null,
    },
  ];
};

const sumCounts = (counts: (number | null)[]): number | null => {
  const present = counts.filter((c): c is number => c !== null);
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0);
};

const minOf = (checks: PublishCheck[]): number | null => {
  const counts = checks.flatMap((c) => (c.count === null ? [] : [c.count]));
  return counts.length === 0 ? null : Math.min(...counts);
};

/**
 * The checklist shown before publishing a site (ADR-038, ADR-049 part B), in PUBLISH_CHECK_KEYS
 * order: every check is the site's, summed over the drafts that are published together.
 */
export function siteReadiness(
  site: SiteFacts,
  flow: DrawingFlow,
  requested: { revisionId: string; drawingKind: DrawingKind } | null,
): PublishReadiness {
  const drafts = draftsOf(site);
  const missing = siteMissingKinds(site);
  const notReady = site.drawings.filter((d) => d.notReady !== null).length + missing.length;
  const open = siteOpenItems(site);
  const openTotal = openTotalOf(open);
  const cabinets = siteCabinetsOf(site);
  const elsewhere = cabinetsInOtherSites(site);
  const perDraft = drafts.map((d) => ownChecks(d.facts));
  const all = (key: PublishCheckKey): PublishCheck[] =>
    perDraft.flatMap((checks) => checks.filter((c) => c.key === key));
  const aggregate = (key: PublishCheckKey, sum: boolean): PublishCheck => {
    const checks = all(key);
    return {
      key,
      ok: checks.every((c) => c.ok),
      count: sum ? sumCounts(checks.map((c) => c.count)) : minOf(checks),
    };
  };
  const byKey: Record<PublishCheckKey, PublishCheck> = {
    crs_known: { ...aggregate('crs_known', true), count: null },
    control_point: aggregate('control_point', false),
    no_problems: aggregate('no_problems', true),
    open_items: { key: 'open_items', ok: openTotal === 0, count: openTotal },
    site_drawings: { key: 'site_drawings', ok: notReady === 0, count: notReady },
    cabinets_match: {
      key: 'cabinets_match',
      ok: cabinets?.ok ?? false,
      count: cabinets ? unmatchedCabinets(cabinets) : null,
    },
    cabinets_other_site: {
      key: 'cabinets_other_site',
      ok: elsewhere.length === 0,
      count: elsewhere.length,
    },
    installation: aggregate('installation', true),
    box_types: aggregate('box_types', true),
  };
  const checks = PUBLISH_CHECK_KEYS.map((key) => byKey[key]);
  const drawings: PublishDrawingReadiness[] = site.drawings.map((d) => ({
    drawingId: d.drawingId,
    drawingKind: d.kind,
    ordinal: d.ordinal,
    draftRevisionId: d.draft?.revisionId ?? null,
    state: d.draft ? 'draft' : d.notReady === null && d.hasPublished ? 'published' : 'not_ready',
    checks: d.draft ? ownChecks(d.draft.facts) : [],
    warningCount: d.draft?.facts.warningTotal ?? 0,
    installation: d.draft?.facts.installation.applies ? d.draft.facts.installation : null,
    boxTypes: d.draft?.facts.boxTypes.applies ? d.draft.facts.boxTypes : null,
  }));
  return {
    siteId: site.siteId,
    checks,
    canPublish:
      drafts.length > 0 &&
      missing.length === 0 &&
      checks.every((c) => c.key === 'open_items' || c.ok),
    revisionId: requested?.revisionId ?? null,
    drawingKind: requested?.drawingKind ?? null,
    siteRevisionIds: drafts.map((d) => d.revisionId),
    drawings,
    needsAcknowledgement: openTotal > 0,
    cabinets,
    cabinetsInOtherSites: elsewhere,
    warningCount: drafts.reduce((sum, d) => sum + d.facts.warningTotal, 0),
    // ADR-045: the checks of the steps switched off; the web hides them while they are ok.
    switchedOff: [
      ...(flow.installationQuestion ? [] : (['installation'] as const)),
      ...(flow.boxTypes ? [] : (['box_types'] as const)),
    ],
  };
}
