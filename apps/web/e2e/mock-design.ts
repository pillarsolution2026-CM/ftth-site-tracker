/**
 * Mapping and design-revision part of the Playwright mock API. Started with plain `node` (type
 * stripping), so it only uses erasable TypeScript. Responses are parsed with the shared schemas
 * before they are sent, so the mock cannot drift from `docs/phase-1b-contracts.md`.
 *
 * Simplifications (not the real implementation): the build is simulated by time
 * (queued -> building -> draft), there is no base revision (every feature is `added`), and the
 * features, text links and counts are fixed fixtures.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CadMappingInputSchema,
  CadMappingSchema,
  CadMappingViewSchema,
  CreateDesignRevisionRequestSchema,
  DesignFeaturePageSchema,
  DesignRevisionDetailSchema,
  DesignRevisionListResponseSchema,
  DesignRevisionSummarySchema,
  DiffPageSchema,
  METRES_PER_UNIT,
  PublishDesignRevisionRequestSchema,
  ReviewTextLinkRequestSchema,
  TEXT_LINK_TARGETS,
  TextLinkPageSchema,
  TextLinkSchema,
  suggestBlockTarget,
  suggestLayerTarget,
  suggestTextTarget,
  type MappingRule,
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
      const mapping = mappings.get(cad.id);
      if (!mapping) return h.sendError(res, 409, 'CONFLICT', { reason: 'NO_MAPPING' });
      if (mapping.version !== body.data.mappingVersion) {
        return h.sendError(res, 409, 'CONFLICT', { reason: 'MAPPING_VERSION_MISMATCH' });
      }
      const open = [...revisions.values()].some((rev) =>
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

  if (sub === 'publish' && method === 'POST') {
    const body = PublishDesignRevisionRequestSchema.safeParse(await h.readJson(req));
    if (!body.success) return h.sendError(res, 422, 'VALIDATION_FAILED');
    if (status !== 'draft') return h.sendError(res, 409, 'CONFLICT', { reason: 'NOT_DRAFT' });
    const textLinksToReview = rev.links.filter((link) => link.status === 'review').length;
    if (textLinksToReview > 0 && !body.data.acknowledgeOpenItems) {
      return h.sendError(res, 409, 'CONFLICT', {
        reason: 'OPEN_ITEMS',
        textLinksToReview,
        diffConflicts: 0,
      });
    }
    rev.publishedRevNo =
      [...revisions.values()].filter((r) => r.publishedRevNo !== null).length + 1;
    rev.publishedAt = new Date().toISOString();
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
