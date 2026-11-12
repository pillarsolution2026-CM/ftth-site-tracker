/**
 * Mapping and design-revision part of the Playwright mock API. Started with plain `node` (type
 * stripping), so it only uses erasable TypeScript. Responses are parsed with the shared schemas
 * before they are sent, so the mock cannot drift from `docs/phase-1b-contracts.md`.
 *
 * Simplifications (not the real implementation): the build is simulated by time
 * (queued -> building -> draft), there is no base revision (every feature is `added`), and the
 * features, text links and counts are fixed fixtures.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  BoxTypeStateSchema,
  BoxTypesReportSchema,
  CadMappingInputSchema,
  CadMappingSchema,
  CadMappingViewSchema,
  CreateDesignRevisionRequestSchema,
  CreateTrenchMarkRequestSchema,
  DesignFeaturePageSchema,
  DesignRevisionDetailSchema,
  DesignRevisionListResponseSchema,
  DesignRevisionSummarySchema,
  DiffPageSchema,
  DrawingProblemListSchema,
  InstallationAnswerRecordSchema,
  InstallationReportSchema,
  InstallationStateSchema,
  METRES_PER_UNIT,
  PublishBlockedDetailsSchema,
  PublishDesignRevisionRequestSchema,
  PublishReadinessSchema,
  SetBoxTypesRequestSchema,
  ReviewTextLinkRequestSchema,
  SecondaryPlacementSuggestionSchema,
  SetInstallationAnswerRequestSchema,
  TEXT_LINK_TARGETS,
  TextLinkPageSchema,
  TextLinkSchema,
  TrenchMarkSchema,
  boxTypeLabel,
  boxTypesApply,
  boxTypesChangedSince,
  evaluateBoxTypes,
  evaluateInstallation,
  latestChoicePerShape,
  generalCabinetPointId,
  installationQuestionApplies,
  mappingKindProblems,
  readingModeOf,
  suggestBlockTarget,
  suggestLayerTarget,
  suggestTextTarget,
  type BoxShapeGallery,
  type FrozenBoxTypes,
  type FrozenInstallation,
  type MappingRule,
  otherDrawingKind,
  type DrawingKind,
} from '@ftth/shared';

export interface Helpers {
  send: (res: ServerResponse, status: number, body?: unknown) => void;
  sendError: (res: ServerResponse, status: number, code: string, details?: unknown) => void;
  readJson: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  page: <T>(items: T[], url: URL) => { items: T[]; page: number; pageSize: number; total: number };
}

export interface MockCadFile {
  id: string;
  projectId: string;
  originalName: string;
  processed: boolean;
  drawingKind: DrawingKind;
  /** A newer version of the same kind exists: nothing can be built from it. */
  superseded: boolean;
  userId: string;
  layers: { name: string; aciColor: number; counts: Record<string, number> }[];
  inserts: { blockName: string; layer: string }[];
  texts: { layer: string; text: string; readable: boolean }[];
}

// ---------- mapping ----------

interface StoredMapping {
  rules: MappingRule[];
  crsEpsg: number;
  drawingUnit: keyof typeof METRES_PER_UNIT;
  version: number;
}

const mappings = new Map<string, StoredMapping>();

// The Qalyub situation (ADR-018): the file declares inches, the extents are UTM metres.
const DETECTION = {
  kind: 'projected_utm',
  reason: 'MATCHES_PROJECT_CRS',
  suggestedEpsg: 32636,
  projectEpsg: 32636,
  impliedUnit: 'm',
  insUnits: 1,
  declaredUnit: 'in',
  unitsConflict: true,
} as const;

export const MOCK_DETECTION = DETECTION;

function mappingOut(cad: MockCadFile, stored: StoredMapping) {
  return CadMappingSchema.parse({
    cadFileId: cad.id,
    rules: stored.rules,
    crsEpsg: stored.crsEpsg,
    drawingUnit: stored.drawingUnit,
    metresPerUnit: METRES_PER_UNIT[stored.drawingUnit],
    version: stored.version,
    updatedById: cad.userId,
    updatedAt: new Date().toISOString(),
  });
}

function mappingView(cad: MockCadFile) {
  const processed = cad.processed;
  const blocks = new Map<string, { count: number; layers: Set<string> }>();
  for (const insert of cad.inserts) {
    const entry = blocks.get(insert.blockName) ?? { count: 0, layers: new Set<string>() };
    entry.count += 1;
    entry.layers.add(insert.layer);
    blocks.set(insert.blockName, entry);
  }
  const texts = new Map<string, { layer: string; text: string; count: number }>();
  for (const text of cad.texts.filter((entry) => entry.readable)) {
    const key = `${text.layer}\u0000${text.text}`;
    const entry = texts.get(key) ?? { layer: text.layer, text: text.text, count: 0 };
    entry.count += 1;
    texts.set(key, entry);
  }
  const stored = mappings.get(cad.id);
  return CadMappingViewSchema.parse({
    cadFileId: cad.id,
    fileStatus: processed ? 'processed' : 'queued',
    projectEpsg: 32636,
    insUnits: 1,
    crsDetection: processed ? DETECTION : null,
    layers: processed
      ? cad.layers.map((layer) => {
          const suggestion = suggestLayerTarget(layer.name);
          return {
            name: layer.name,
            aciColor: layer.aciColor,
            trueColor: null,
            isOn: true,
            entityCounts: layer.counts,
            entityTotal: Object.values(layer.counts).reduce((a, b) => a + b, 0),
            suggestedTarget: suggestion.target,
            suggestionSource: suggestion.source,
          };
        })
      : [],
    blocks: processed
      ? [...blocks.entries()].map(([name, entry]) => ({
          name,
          count: entry.count,
          layers: [...entry.layers],
          suggestedTarget: suggestBlockTarget(name),
        }))
      : [],
    texts: processed
      ? [...texts.values()].map((entry) => ({
          ...entry,
          suggestedTarget: suggestTextTarget(entry.text),
        }))
      : [],
    mapping: stored ? mappingOut(cad, stored) : null,
  });
}

export async function handleMapping(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  cad: MockCadFile,
  h: Helpers,
): Promise<void> {
  if (method === 'GET') return h.send(res, 200, mappingView(cad));
  if (method !== 'PUT') return h.sendError(res, 404, 'NOT_FOUND');
  const parsed = CadMappingInputSchema.safeParse(await h.readJson(req));
  if (!parsed.success) return h.sendError(res, 422, 'VALIDATION_FAILED');
  // Like the API (ADR-041): a text role or zone layer the file's drawing kind does not read.
  const kindProblem = mappingKindProblems(parsed.data.rules, cad.drawingKind)[0];
  if (kindProblem) {
    return h.sendError(res, 422, 'VALIDATION_FAILED', { reason: kindProblem.reason });
  }
  if (!cad.processed) return h.sendError(res, 409, 'CONFLICT', { reason: 'NOT_PROCESSED' });
  const current = mappings.get(cad.id);
  if (parsed.data.version !== (current?.version ?? null)) {
    return h.sendError(res, 409, 'CONFLICT', { reason: 'VERSION_MISMATCH' });
  }
  const stored: StoredMapping = {
    rules: parsed.data.rules,
    crsEpsg: parsed.data.crsEpsg,
    drawingUnit: parsed.data.drawingUnit,
    version: (current?.version ?? 0) + 1,
  };
  mappings.set(cad.id, stored);
  h.send(res, 200, mappingOut(cad, stored));
}

// ---------- design revisions ----------

const QUEUED_MS = 800;
const BUILDING_MS = 1500;

type LinkRecord = {
  id: string;
  handle: string;
  layer: string;
  text: string | null;
  rawText: string;
  kind: 'cable' | 'duct' | 'length' | 'box_id' | 'box_bpu' | 'other' | 'unreadable';
  status: 'auto' | 'review' | 'confirmed' | 'rejected' | 'unlinked';
  featureId: string | null;
  distanceM: string | null;
  confidence: string;
};

const FEATURE_IDS = {
  r1: 'f0000000-0000-4000-8000-000000000001',
  r2: 'f0000000-0000-4000-8000-000000000002',
  b1: 'f0000000-0000-4000-8000-000000000003',
  b2: 'f0000000-0000-4000-8000-000000000004',
  h1: 'f0000000-0000-4000-8000-000000000005',
};

const FEATURES = [
  {
    id: FEATURE_IDS.r1,
    featureType: 'route',
    code: null,
    layer: 'N_DUC_CBL',
    handle: 'A1',
    len: '120.5',
  },
  {
    id: FEATURE_IDS.r2,
    featureType: 'route',
    code: null,
    layer: 'N_DUC_CBL',
    handle: 'A2',
    len: '241',
  },
  { id: FEATURE_IDS.b1, featureType: 'box', code: '1-1', layer: 'sub', handle: 'B1', len: null },
  { id: FEATURE_IDS.b2, featureType: 'box', code: '1-2', layer: 'sub', handle: 'B2', len: null },
  { id: FEATURE_IDS.h1, featureType: 'hhi', code: null, layer: 'RRR', handle: 'C1', len: null },
] as const;

interface RevisionRecord {
  id: string;
  cad: MockCadFile;
  mapping: StoredMapping;
  createdAtMs: number;
  discarded: boolean;
  publishedRevNo: number | null;
  publishedAt: string | null;
  links: LinkRecord[];
  /** ADR-042: the General's answer and marks frozen at creation (null on a Secondary). */
  installation: FrozenInstallation | null;
  /** ADR-043: the box-type choices frozen at creation (null on a General). */
  boxTypes: FrozenBoxTypes | null;
}

const revisions = new Map<string, RevisionRecord>();
let nextId = 1;

function initialLinks(): LinkRecord[] {
  const id = (n: number) => `e0000000-0000-4000-8000-00000000000${n}`;
  return [
    {
      id: id(1),
      handle: '2B1',
      layer: 'tx',
      text: 'F 36 C',
      rawText: 'F 36 C',
      kind: 'cable',
      status: 'review',
      featureId: FEATURE_IDS.r1,
      distanceM: '2.5',
      confidence: '0.612',
    },
    {
      id: id(2),
      handle: '2B2',
      layer: 'tx',
      text: '1-1',
      rawText: '1-1',
      kind: 'box_id',
      status: 'review',
      featureId: FEATURE_IDS.b1,
      distanceM: '1.2',
      confidence: '0.54',
    },
    {
      id: id(3),
      handle: '2B3',
      layer: 'tx',
      text: null,
      rawText: '%%U\\M+ABCD',
      kind: 'unreadable',
      status: 'review',
      featureId: null,
      distanceM: null,
      confidence: '0',
    },
    {
      id: id(4),
      handle: '2B4',
      layer: 'tx',
      text: '150.0M',
      rawText: '150.0M',
      kind: 'length',
      status: 'auto',
      featureId: FEATURE_IDS.r2,
      distanceM: '0.8',
      confidence: '0.931',
    },
  ];
}

function statusOf(rev: RevisionRecord) {
  if (rev.discarded) return 'discarded' as const;
  if (rev.publishedRevNo !== null) return 'published' as const;
  const age = Date.now() - rev.createdAtMs;
  if (age < QUEUED_MS) return 'queued' as const;
  return age < QUEUED_MS + BUILDING_MS ? ('building' as const) : ('draft' as const);
}

function summary(rev: RevisionRecord) {
  const status = statusOf(rev);
  const built = status === 'draft' || status === 'published';
  const statuses = ['auto', 'review', 'confirmed', 'rejected', 'unlinked'] as const;
  return {
    id: rev.id,
    projectId: rev.cad.projectId,
    cadFileId: rev.cad.id,
    cadFileName: rev.cad.originalName,
    drawingKind: rev.cad.drawingKind,
    revNo: rev.publishedRevNo,
    status,
    crsEpsg: rev.mapping.crsEpsg,
    drawingUnit: rev.mapping.drawingUnit,
    metresPerUnit: METRES_PER_UNIT[rev.mapping.drawingUnit],
    insUnits: 1,
    unitsConflict: true,
    baseRevisionId: null,
    counts: built
      ? {
          features: { route: 2, box: 2, hhi: 1, joint: 0, mh: 0 },
          routeLengthM: '361.5',
          // ADR-041: the reading totals exist only when the mapping gives texts a meaning.
          ...(readingModeOf(rev.mapping.rules) === 'roles'
            ? {
                reading: {
                  drawingKind: rev.cad.drawingKind,
                  bundles: [
                    {
                      ways: 1,
                      ductSize: '7/3.5',
                      count: 2,
                      writtenLengthM: '361.500',
                      withoutLength: 0,
                    },
                  ],
                  connectors: [{ ductSize: '7/3.5', count: 2 }],
                  spares: [{ ductSize: '7/3.5', singles: 2, endCaps: 4 }],
                  cables: [],
                  handholes: [],
                },
              }
            : {}),
        }
      : null,
    textLinkCounts: built
      ? Object.fromEntries(
          statuses.map((s) => [s, rev.links.filter((link) => link.status === s).length]),
        )
      : null,
    diffCounts: built
      ? {
          added: FEATURES.length,
          removed: 0,
          unchanged: 0,
          moved: 0,
          reshaped: 0,
          attributes_changed: 0,
          conflict: 0,
        }
      : null,
    hasTiles: built,
    errorCode: null,
    createdById: rev.cad.userId,
    createdAt: new Date(rev.createdAtMs).toISOString(),
    builtAt: built ? new Date(rev.createdAtMs + QUEUED_MS + BUILDING_MS).toISOString() : null,
    publishedAt: rev.publishedAt,
    publishedById: rev.publishedAt ? rev.cad.userId : null,
  };
}

function detail(rev: RevisionRecord) {
  return DesignRevisionDetailSchema.parse({
    ...summary(rev),
    rules: rev.mapping.rules,
    errorMessage: null,
    log: null,
    installation: rev.installation,
    boxTypes: rev.boxTypes,
  });
}

function linkOut(rev: RevisionRecord, link: LinkRecord) {
  const feature = FEATURES.find((candidate) => candidate.id === link.featureId);
  return TextLinkSchema.parse({
    id: link.id,
    revisionId: rev.id,
    textHandle: link.handle,
    layer: link.layer,
    text: link.text,
    rawText: link.rawText,
    readable: link.text !== null,
    kind: link.kind,
    status: link.status,
    featureId: link.featureId,
    featureType: feature?.featureType ?? null,
    featureCode: feature?.code ?? null,
    distanceM: link.distanceM,
    confidence: link.confidence,
    position: { x: 325000, y: 3340000 },
    reviewedById: null,
    reviewedAt: null,
  });
}

function featureOut(rev: RevisionRecord, feature: (typeof FEATURES)[number]) {
  return {
    id: feature.id,
    revisionId: rev.id,
    featureType: feature.featureType,
    code: feature.code,
    layer: feature.layer,
    blockName: null,
    sourceKind: feature.featureType === 'route' ? 'curve' : 'insert',
    sourceHandle: feature.handle,
    lengthM: feature.len,
    anchor: { x: 325000, y: 3340000 },
    attrs: {},
  };
}

export async function handleDesignRevisions(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  [id, sub, subId]: (string | undefined)[],
  h: Helpers,
  findCad: (id: string) => MockCadFile | undefined,
): Promise<void> {
  if (id === undefined) {
    if (method === 'GET') {
      const items = [...revisions.values()].reverse().map(summary);
      return h.send(res, 200, DesignRevisionListResponseSchema.parse({ items }));
    }
    if (method === 'POST') {
      const body = CreateDesignRevisionRequestSchema.safeParse(await h.readJson(req));
      if (!body.success) return h.sendError(res, 422, 'VALIDATION_FAILED');
      const cad = findCad(body.data.cadFileId);
      if (!cad) return h.sendError(res, 404, 'NOT_FOUND');
      if (!cad.processed) return h.sendError(res, 409, 'CONFLICT', { reason: 'NOT_PROCESSED' });
      if (cad.superseded) {
        return h.sendError(res, 409, 'CONFLICT', { reason: 'NOT_CURRENT_VERSION' });
      }
      const mapping = mappings.get(cad.id);
      if (!mapping) return h.sendError(res, 409, 'CONFLICT', { reason: 'NO_MAPPING' });
      if (mapping.version !== body.data.mappingVersion) {
        return h.sendError(res, 409, 'CONFLICT', { reason: 'MAPPING_VERSION_MISMATCH' });
      }
      // One open revision per kind (ADR-040): a General and a Secondary draft can exist together.
      const open = [...revisions.values()].some(
        (rev) =>
          rev.cad.drawingKind === cad.drawingKind &&
          ['queued', 'building', 'draft'].includes(statusOf(rev)),
      );
      if (open) return h.sendError(res, 409, 'CONFLICT', { reason: 'REVISION_IN_PROGRESS' });
      const rev: RevisionRecord = {
        id: `d0000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`,
        cad,
        mapping,
        createdAtMs: Date.now(),
        discarded: false,
        publishedRevNo: null,
        publishedAt: null,
        links: initialLinks(),
        installation: frozenInstallation(cad),
        boxTypes: frozenBoxTypes(cad),
      };
      revisions.set(rev.id, rev);
      return h.send(res, 202, DesignRevisionSummarySchema.parse(summary(rev)));
    }
    return h.sendError(res, 404, 'NOT_FOUND');
  }

  const rev = revisions.get(id);
  if (!rev) return h.sendError(res, 404, 'NOT_FOUND');
  const status = statusOf(rev);
  const built = status === 'draft' || status === 'published';

  if (sub === undefined && method === 'GET') return h.send(res, 200, detail(rev));

  if (sub === 'text-links' && method === 'GET') {
    const wanted = url.searchParams.get('status');
    const kind = url.searchParams.get('kind');
    const items = built
      ? rev.links
          .filter((link) => (!wanted || link.status === wanted) && (!kind || link.kind === kind))
          .map((link) => linkOut(rev, link))
          .sort((a, b) => Number(a.confidence) - Number(b.confidence))
      : [];
    return h.send(res, 200, TextLinkPageSchema.parse(h.page(items, url)));
  }

  if (sub === 'text-links' && method === 'PATCH' && subId) {
    if (status !== 'draft') return h.sendError(res, 409, 'CONFLICT', { reason: 'REVISION_LOCKED' });
    const link = rev.links.find((candidate) => candidate.id === subId);
    if (!link) return h.sendError(res, 404, 'NOT_FOUND');
    const body = ReviewTextLinkRequestSchema.safeParse(await h.readJson(req));
    if (!body.success) return h.sendError(res, 422, 'VALIDATION_FAILED');
    if (body.data.action === 'reject') {
      link.status = 'rejected';
    } else {
      const featureId = body.data.featureId ?? link.featureId;
      if (!featureId)
        return h.sendError(res, 422, 'VALIDATION_FAILED', { reason: 'FEATURE_REQUIRED' });
      const feature = FEATURES.find((candidate) => candidate.id === featureId);
      if (!feature)
        return h.sendError(res, 422, 'VALIDATION_FAILED', { reason: 'FEATURE_REQUIRED' });
      const allowed: readonly string[] = TEXT_LINK_TARGETS[link.kind];
      if (!allowed.includes(feature.featureType)) {
        return h.sendError(res, 422, 'VALIDATION_FAILED', { reason: 'FEATURE_TYPE_NOT_ALLOWED' });
      }
      if (featureId !== link.featureId) link.distanceM = '3.1';
      link.featureId = featureId;
      link.status = 'confirmed';
    }
    return h.send(res, 200, linkOut(rev, link));
  }

  if (sub === 'features' && method === 'GET') {
    const type = url.searchParams.get('featureType');
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const items = built
      ? FEATURES.filter(
          (feature) =>
            (!type || feature.featureType === type) &&
            (!q || (feature.code ?? '').toLowerCase().includes(q)),
        ).map((feature) => featureOut(rev, feature))
      : [];
    return h.send(res, 200, DesignFeaturePageSchema.parse(h.page(items, url)));
  }

  if (sub === 'diff' && method === 'GET') {
    const change = url.searchParams.get('change');
    const items = built
      ? FEATURES.map((feature) => ({
          id: feature.id.replace('f0000000', 'c0000000'),
          featureId: feature.id,
          featureType: feature.featureType,
          change: 'added',
          code: feature.code,
          previousCode: null,
          distanceM: null,
          lengthDeltaM: null,
          candidateFeatureIds: [],
        })).filter((item) => !change || item.change === change)
      : [];
    return h.send(res, 200, DiffPageSchema.parse(h.page(items, url)));
  }

  if (sub === 'problems' && method === 'GET') {
    return h.send(
      res,
      200,
      DrawingProblemListSchema.parse({ items: [], total: 0, warningTotal: 0 }),
    );
  }

  // ADR-040: publishing is a PAIR. The mock revisions are all placed (CRS chosen, one control
  // point) with no drawing errors, so the pair only needs both drafts and the open items.
  const otherDraft = [...revisions.values()].find(
    (candidate) =>
      candidate.cad.drawingKind !== rev.cad.drawingKind && statusOf(candidate) === 'draft',
  );
  const ownInstallation = reportOf(rev);
  const ownBoxTypes = boxTypesReportOf(rev);
  const openOf = (r: RevisionRecord) => r.links.filter((link) => link.status === 'review').length;
  const openItems = openOf(rev) + (otherDraft ? openOf(otherDraft) : 0);

  if (sub === 'publish-readiness' && method === 'GET') {
    return h.send(
      res,
      200,
      PublishReadinessSchema.parse({
        checks: [
          { key: 'crs_known', ok: true, count: null },
          { key: 'control_point', ok: true, count: 1 },
          { key: 'no_problems', ok: true, count: 0 },
          { key: 'open_items', ok: openItems === 0, count: openItems },
          {
            key: 'other_drawing',
            ok:
              otherDraft !== undefined &&
              reportOf(otherDraft).ok &&
              boxTypesReportOf(otherDraft).ok,
            count: otherDraft ? 0 : null,
          },
          // ADR-041: the mock drawings carry the same (sub) cabinets, so the pair matches.
          { key: 'cabinets_match', ok: otherDraft !== undefined, count: otherDraft ? 0 : null },
          // ADR-042: the General's installation (always ok, no count, on a Secondary).
          {
            key: 'installation',
            ok: ownInstallation.ok,
            count: ownInstallation.applies ? ownInstallation.issueCount : null,
          },
          // ADR-043: the Secondary's box types (always ok, no count, on a General).
          {
            key: 'box_types',
            ok: ownBoxTypes.ok,
            count: ownBoxTypes.applies ? ownBoxTypes.issueCount : null,
          },
        ],
        canPublish:
          status === 'draft' &&
          otherDraft !== undefined &&
          ownInstallation.ok &&
          ownBoxTypes.ok &&
          reportOf(otherDraft).ok &&
          boxTypesReportOf(otherDraft).ok,
        drawingKind: rev.cad.drawingKind,
        otherRevisionId: otherDraft?.id ?? null,
        needsAcknowledgement: openItems > 0,
        cabinets: otherDraft
          ? {
              ok: true,
              general: { count: 2, unnamed: 0, missingInOther: [] },
              secondary: { count: 2, unnamed: 0, missingInOther: [] },
            }
          : null,
        warningCount: 0,
        installation: ownInstallation.applies ? ownInstallation : null,
        boxTypes: ownBoxTypes.applies ? ownBoxTypes : null,
      }),
    );
  }

  if (sub === 'box-types' && method === 'GET') {
    return h.send(res, 200, BoxTypesReportSchema.parse(boxTypesReportOf(rev)));
  }

  if (sub === 'installation' && method === 'GET') {
    return h.send(res, 200, InstallationReportSchema.parse(reportOf(rev)));
  }

  if (sub === 'publish' && method === 'POST') {
    const body = PublishDesignRevisionRequestSchema.safeParse(await h.readJson(req));
    if (!body.success) return h.sendError(res, 422, 'VALIDATION_FAILED');
    if (status !== 'draft') return h.sendError(res, 409, 'CONFLICT', { reason: 'NOT_DRAFT' });
    if (!otherDraft) {
      return h.sendError(
        res,
        409,
        'CONFLICT',
        PublishBlockedDetailsSchema.parse({
          reason: 'OTHER_DRAWING_MISSING',
          drawingKind: otherDrawingKind(rev.cad.drawingKind),
        }),
      );
    }
    for (const candidate of [rev, otherDraft]) {
      const report = reportOf(candidate);
      if (!report.ok) {
        return h.sendError(
          res,
          409,
          'CONFLICT',
          PublishBlockedDetailsSchema.parse({
            reason: 'INSTALLATION_UNCLEAR',
            drawingKind: 'general',
            issueCount: report.issueCount,
            issues: report.issues,
          }),
        );
      }
    }
    for (const candidate of [rev, otherDraft]) {
      const report = boxTypesReportOf(candidate);
      if (!report.ok) {
        return h.sendError(
          res,
          409,
          'CONFLICT',
          PublishBlockedDetailsSchema.parse({
            reason: 'BOX_TYPES_UNCLEAR',
            drawingKind: 'secondary',
            issueCount: report.issueCount,
            issues: report.issues,
          }),
        );
      }
    }
    if (openItems > 0 && !body.data.acknowledgeOpenItems) {
      return h.sendError(
        res,
        409,
        'CONFLICT',
        PublishBlockedDetailsSchema.parse({
          reason: 'OPEN_ITEMS',
          textLinksToReview: openItems,
          diffConflicts: 0,
        }),
      );
    }
    const revNo = Math.max(0, ...[...revisions.values()].map((r) => r.publishedRevNo ?? 0)) + 1;
    const publishedAt = new Date().toISOString();
    for (const published of [rev, otherDraft]) {
      published.publishedRevNo = revNo;
      published.publishedAt = publishedAt;
    }
    return h.send(res, 200, detail(rev));
  }

  if (sub === 'discard' && method === 'POST') {
    if (status === 'published' || status === 'discarded') {
      return h.sendError(res, 409, 'CONFLICT', { reason: 'NOT_DISCARDABLE' });
    }
    rev.discarded = true;
    return h.send(res, 200, detail(rev));
  }

  return h.sendError(res, 404, 'NOT_FOUND');
}

// ---------- installation question, trench marks, General-cabinet points (ADR-042) ----------

interface AnswerRow {
  id: string;
  answer: 'pull_only' | 'has_trench';
  answeredAt: string;
}
interface MarkRow {
  id: string;
  routeHandle: string;
  lengthM: string;
  createdAt: string;
  withdrawnAt: string | null;
}

/** Append-only per General file, like the API: latest answer in force, withdrawn marks kept. */
const installations = new Map<string, { answers: AnswerRow[]; marks: MarkRow[] }>();

function storeOf(cadId: string) {
  const existing = installations.get(cadId);
  if (existing) return existing;
  const created = { answers: [], marks: [] };
  installations.set(cadId, created);
  return created;
}

const MOCK_USER = (cad: MockCadFile) => ({ id: cad.userId, name: 'Mona' });

function answerOut(cad: MockCadFile, row: AnswerRow) {
  return InstallationAnswerRecordSchema.parse({
    id: row.id,
    cadFileId: cad.id,
    answer: row.answer,
    answeredBy: MOCK_USER(cad),
    answeredAt: row.answeredAt,
  });
}

function markOut(cad: MockCadFile, row: MarkRow) {
  return TrenchMarkSchema.parse({
    id: row.id,
    cadFileId: cad.id,
    routeHandle: row.routeHandle,
    lengthM: row.lengthM,
    createdBy: MOCK_USER(cad),
    createdAt: row.createdAt,
    withdrawnBy: row.withdrawnAt ? MOCK_USER(cad) : null,
    withdrawnAt: row.withdrawnAt,
  });
}

function installationState(cad: MockCadFile) {
  const store = storeOf(cad.id);
  const asked = installationQuestionApplies(cad.drawingKind);
  const latest = asked ? store.answers.at(-1) : undefined;
  const marks = asked ? [...store.marks].reverse() : [];
  const inForce = marks.filter((mark) => mark.withdrawnAt === null);
  const trenchMm = inForce.reduce((sum, mark) => sum + Math.round(Number(mark.lengthM) * 1000), 0);
  return InstallationStateSchema.parse({
    cadFileId: cad.id,
    drawingKind: cad.drawingKind,
    asked,
    answer: latest ? answerOut(cad, latest) : null,
    answerHistory: asked ? [...store.answers].reverse().map((row) => answerOut(cad, row)) : [],
    marks: marks.map((mark) => markOut(cad, mark)),
    activeMarkCount: inForce.length,
    activeTrenchM: (trenchMm / 1000).toFixed(3),
  });
}

/** What a build freezes: the answer and the marks in force (null on a Secondary). */
function frozenInstallation(cad: MockCadFile): FrozenInstallation | null {
  if (!installationQuestionApplies(cad.drawingKind)) return null;
  const store = storeOf(cad.id);
  const latest = store.answers.at(-1);
  return {
    answer: latest?.answer ?? null,
    answerId: latest?.id ?? null,
    marks: store.marks
      .filter((mark) => mark.withdrawnAt === null)
      .map((mark) => ({ id: mark.id, routeHandle: mark.routeHandle, lengthM: mark.lengthM })),
  };
}

/** The shared evaluation, fed with the mock's fixed routes (A1 and A2 with written lengths). */
function reportOf(rev: RevisionRecord) {
  return evaluateInstallation({
    drawingKind: rev.cad.drawingKind,
    frozen: rev.installation,
    routes: FEATURES.filter((feature) => feature.featureType === 'route').map((feature) => ({
      featureId: feature.id,
      sourceHandle: feature.handle,
      writtenLengthM: feature.len,
    })),
    merges: [],
  });
}

/** `…/cad-files/:f/installation[/answer | /trench-marks[/:markId/withdraw]]`. */
export async function handleInstallation(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  cad: MockCadFile,
  [part, markId, action]: (string | undefined)[],
  h: Helpers,
): Promise<void> {
  if (part === undefined && method === 'GET') {
    return h.send(res, 200, installationState(cad));
  }
  const refuse = (status: number, reason: string) =>
    h.sendError(res, status, status === 422 ? 'VALIDATION_FAILED' : 'CONFLICT', { reason });
  if (!installationQuestionApplies(cad.drawingKind)) return refuse(409, 'NOT_GENERAL_DRAWING');
  if (cad.superseded) return refuse(409, 'FILE_SUPERSEDED');
  const store = storeOf(cad.id);
  const inForce = () => store.marks.filter((mark) => mark.withdrawnAt === null);

  if (part === 'answer' && method === 'PUT') {
    const body = SetInstallationAnswerRequestSchema.safeParse(await h.readJson(req));
    if (!body.success) return h.sendError(res, 422, 'VALIDATION_FAILED');
    if (body.data.answer === 'pull_only' && inForce().length > 0) {
      return refuse(409, 'TRENCH_MARKS_ACTIVE');
    }
    const row: AnswerRow = {
      id: randomUUID(),
      answer: body.data.answer,
      answeredAt: new Date().toISOString(),
    };
    store.answers.push(row);
    return h.send(res, 200, answerOut(cad, row));
  }

  if (part === 'trench-marks' && markId === undefined && method === 'POST') {
    const body = CreateTrenchMarkRequestSchema.safeParse(await h.readJson(req));
    if (!body.success) return h.sendError(res, 422, 'VALIDATION_FAILED');
    if (store.answers.at(-1)?.answer !== 'has_trench') return refuse(409, 'ANSWER_NOT_TRENCH');
    const row: MarkRow = {
      id: randomUUID(),
      routeHandle: body.data.routeHandle,
      lengthM: body.data.lengthM,
      createdAt: new Date().toISOString(),
      withdrawnAt: null,
    };
    store.marks.push(row);
    return h.send(res, 201, markOut(cad, row));
  }

  if (part === 'trench-marks' && action === 'withdraw' && method === 'POST') {
    const row = store.marks.find((mark) => mark.id === markId);
    if (!row) return h.sendError(res, 404, 'NOT_FOUND');
    if (row.withdrawnAt !== null) return refuse(409, 'ALREADY_WITHDRAWN');
    row.withdrawnAt = new Date().toISOString();
    return h.send(res, 200, markOut(cad, row));
  }
  return h.sendError(res, 404, 'NOT_FOUND');
}

// ---------- box types by drawn shape (ADR-043) ----------

export interface MockOrderLines {
  exists: boolean;
  lines: { id: string; code: string; description: string }[];
}

let orderLinesSource: () => MockOrderLines = () => ({ exists: false, lines: [] });

/** The mock API server tells this module where the project's work-order lines are. */
export function provideOrderLines(source: () => MockOrderLines): void {
  orderLinesSource = source;
}

/** The mock Secondary draws its two boxes with one symbol: one shape, two boxes. */
export const MOCK_BOX_SHAPE = `v1-${'a'.repeat(64)}`;

const MOCK_GALLERY: BoxShapeGallery = {
  version: 1,
  boxCount: 2,
  shapeCount: 1,
  boxesWithoutShape: 0,
  shapes: [
    {
      shape: MOCK_BOX_SHAPE,
      source: 'block',
      count: 2,
      blockNames: ['box c'],
      sampleHandles: ['B1', 'B2'],
      preview: {
        paths: [[-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5, -0.5, -0.5]],
        texts: [],
        truncated: false,
      },
    },
  ],
};

interface ChoiceRow {
  id: string;
  shape: string;
  workOrderLineId: string | null;
  createdAt: string;
}

/** Append-only per Secondary file, like the API: the latest row per shape is in force. */
const boxChoices = new Map<string, ChoiceRow[]>();

function choicesOf(cadId: string): ChoiceRow[] {
  const existing = boxChoices.get(cadId);
  if (existing) return existing;
  const created: ChoiceRow[] = [];
  boxChoices.set(cadId, created);
  return created;
}

const activeChoices = (cadId: string) =>
  latestChoicePerShape([...choicesOf(cadId)].reverse()).filter(
    (row) => row.workOrderLineId !== null,
  );

function boxTypeStateOf(cad: MockCadFile) {
  const applies = cad.drawingKind === 'secondary';
  const rows = applies ? [...choicesOf(cad.id)].reverse() : [];
  const row = (choice: ChoiceRow) => ({
    id: choice.id,
    cadFileId: cad.id,
    shape: choice.shape,
    workOrderLineId: choice.workOrderLineId,
    createdBy: MOCK_USER(cad),
    createdAt: choice.createdAt,
  });
  return BoxTypeStateSchema.parse({
    cadFileId: cad.id,
    drawingKind: cad.drawingKind,
    applies,
    active: applies ? activeChoices(cad.id).map(row) : [],
    history: rows.map(row),
    previousVersion: null,
  });
}

/** What a creation freezes: the choices in force with a snapshot of their lines. */
function frozenBoxTypes(cad: MockCadFile): FrozenBoxTypes | null {
  if (cad.drawingKind !== 'secondary') return null;
  const lines = orderLinesSource().lines;
  return {
    choices: activeChoices(cad.id).map((choice) => {
      const line = lines.find((candidate) => candidate.id === choice.workOrderLineId);
      return {
        choiceId: choice.id,
        shape: choice.shape,
        workOrderLineId: choice.workOrderLineId as string,
        line: line
          ? {
              code: line.code,
              description: line.description,
              label: boxTypeLabel(line.description),
            }
          : null,
      };
    }),
  };
}

function boxTypesReportOf(rev: RevisionRecord) {
  const order = orderLinesSource();
  const applies = boxTypesApply(rev.cad.drawingKind, readingModeOf(rev.mapping.rules));
  const report = evaluateBoxTypes({
    applies,
    gallery: applies ? MOCK_GALLERY : null,
    frozen: rev.boxTypes,
    workOrderExists: order.exists,
    workOrderLineIds: new Set(order.lines.map((line) => line.id)),
  });
  return {
    ...report,
    changedSinceBuild:
      applies &&
      boxTypesChangedSince(
        rev.boxTypes,
        activeChoices(rev.cad.id).map((choice) => choice.id),
      ),
  };
}

/** `…/cad-files/:f/box-types` — GET the live state, POST a batch of choices. */
export async function handleBoxTypes(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  cad: MockCadFile,
  h: Helpers,
): Promise<void> {
  if (method === 'GET') return h.send(res, 200, boxTypeStateOf(cad));
  if (method !== 'POST') return h.sendError(res, 404, 'NOT_FOUND');
  const refuse = (status: number, reason: string) =>
    h.sendError(res, status, status === 422 ? 'VALIDATION_FAILED' : 'CONFLICT', { reason });
  const body = SetBoxTypesRequestSchema.safeParse(await h.readJson(req));
  if (!body.success) return h.sendError(res, 422, 'VALIDATION_FAILED');
  if (cad.drawingKind !== 'secondary') return refuse(409, 'NOT_SECONDARY_DRAWING');
  if (cad.superseded) return refuse(409, 'FILE_SUPERSEDED');
  const built = [...revisions.values()].some(
    (rev) => rev.cad.id === cad.id && ['draft', 'published'].includes(statusOf(rev)),
  );
  if (!built) return refuse(409, 'NOT_BUILT');
  const order = orderLinesSource();
  if (!order.exists) return refuse(409, 'NO_WORK_ORDER');
  if (body.data.choices.some((choice) => choice.shape !== MOCK_BOX_SHAPE)) {
    return refuse(422, 'SHAPE_NOT_FOUND');
  }
  const known = new Set(order.lines.map((line) => line.id));
  if (body.data.choices.some((c) => c.workOrderLineId !== null && !known.has(c.workOrderLineId))) {
    return refuse(422, 'LINE_NOT_IN_WORK_ORDER');
  }
  const rows = choicesOf(cad.id);
  for (const choice of body.data.choices) {
    const current = latestChoicePerShape([...rows].reverse()).find((r) => r.shape === choice.shape);
    if ((current?.workOrderLineId ?? null) === choice.workOrderLineId) continue;
    rows.push({
      id: randomUUID(),
      shape: choice.shape,
      workOrderLineId: choice.workOrderLineId,
      createdAt: new Date().toISOString(),
    });
  }
  return h.send(res, 200, boxTypeStateOf(cad));
}

/**
 * `GET …/cad-files/:f/placement/general-cabinets` (Secondary): two shared cabinets from the newest
 * General draft or published revision, placed in the same spot as the mock drawing; otherwise the
 * API's clear refusals.
 */
export function handleGeneralCabinets(res: ServerResponse, cad: MockCadFile, h: Helpers): void {
  const refuse = (reason: string) =>
    h.sendError(res, 409, 'CONFLICT', { reason, revisionId: null });
  if (cad.drawingKind !== 'secondary') return refuse('NOT_SECONDARY');
  if (cad.superseded) return refuse('NOT_CURRENT');
  const general = [...revisions.values()]
    .reverse()
    .find(
      (rev) => rev.cad.drawingKind === 'general' && ['draft', 'published'].includes(statusOf(rev)),
    );
  if (!general) return refuse('GENERAL_NOT_BUILT');
  const point = (name: string, x: number, y: number, lat: number, lon: number) => ({
    id: generalCabinetPointId(name),
    drawing: { x, y },
    handle: `C-${name}`,
    label: name,
    lat,
    lon,
    source: 'general_cabinet',
    excluded: false,
  });
  return h.send(
    res,
    200,
    SecondaryPlacementSuggestionSchema.parse({
      cadFileId: cad.id,
      secondaryRevisionId: randomUUID(),
      general: {
        cadFileId: general.cad.id,
        revisionId: general.id,
        status: statusOf(general) === 'published' ? 'published' : 'draft',
        revNo: general.publishedRevNo,
      },
      // About 90 m apart on the ground, as far apart in the drawing, so the fit has no error.
      points: [
        point('1-1', 1000, 2000, 30.984507, 32.783249),
        point('1-2', 1071.7, 2054.8, 30.985, 32.784),
      ],
      matchedCount: 2,
      truncated: false,
      unmatched: {
        onlyInSecondary: ['9-9'],
        onlyInGeneral: [],
        duplicateInSecondary: [],
        duplicateInGeneral: [],
        unnamedSecondary: 0,
        unnamedGeneral: 0,
        withoutDrawingPosition: [],
        unusable: [],
        listCapped: false,
      },
    }),
  );
}
