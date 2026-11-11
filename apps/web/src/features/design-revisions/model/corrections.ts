import type { MessageKey } from '@ftth/i18n';
import {
  isPointFeatureType,
  type CadMappingView,
  type CreateDrawingCorrectionRequest,
  type DrawingCorrection,
  type DrawingCorrectionInput,
  type DrawingProblemCode,
  type DrawingProblemItem,
  type PointFeatureType,
  moveLayerTargets,
} from '@ftth/shared';
import type { ClientErrorCode } from '@/shared/api/bff-client';
import type { ErrorMessage } from './revision-errors';

/** `problem.handle` of a correction is at most 64 characters; a long "A/B/C…" place is cut. */
const MAX_HANDLE = 64;
/** A missing label is typed this far (in metres) above its item, so it does not sit on it. */
const LABEL_OFFSET_M = 0.5;

export type FixToolKind =
  | 'move_layer'
  | 'add_text'
  | 'label_type_mismatch'
  | 'set_text'
  | 'add_item'
  | 'merge_routes'
  | 'none';

/**
 * Which tool a problem code uses (ADR-038, ADR-041). `RING_LABEL_MISMATCH`, `BOX_NOT_REACHED` and
 * `CABINET_ZONE_MISSING` are fixed in AutoCAD. A route's LABEL_TYPE_MISMATCH (its place carries
 * `params.role`; its handle is the text) is fixed by editing that text; a point's by the older
 * edit-or-place-an-item tool.
 */
export function toolOf(
  code: DrawingProblemCode,
  place?: Pick<DrawingProblemItem, 'params'>,
): FixToolKind {
  switch (code) {
    case 'WRONG_LAYER':
      return 'move_layer';
    case 'LABEL_MISSING':
    case 'HANDHOLE_TYPE_MISSING':
      return 'add_text';
    case 'LABEL_TYPE_MISMATCH':
      return place?.params?.role !== undefined ? 'set_text' : 'label_type_mismatch';
    case 'LABEL_LENGTH_MISSING':
    case 'HANDHOLE_TYPE_UNKNOWN':
    case 'BOX_NUMBER_DUPLICATE':
    case 'BOX_CABINET_UNKNOWN':
    case 'CABINET_NAME_DUPLICATE':
    case 'CABINET_BOX_COUNT_MISMATCH':
    case 'SPARE_CORES_MISMATCH':
    case 'CABLE_SLACK_TOO_SHORT':
    case 'CABLE_SLACK_TOO_LONG':
      return 'set_text';
    case 'CONNECTOR_SIZE_MISSING':
      // The place is the 1way label when the check found one (its route is `featureHandle`).
      return place?.params?.featureHandle !== undefined ? 'set_text' : 'none';
    case 'HANDHOLE_NOT_DRAWN':
      return 'add_item';
    case 'ROUTE_SPLIT':
      return 'merge_routes';
    case 'RING_LABEL_MISMATCH':
    case 'BOX_NOT_REACHED':
    case 'CABINET_ZONE_MISSING':
      return 'none';
  }
}

export const problemHandle = (handle: string) => handle.slice(0, MAX_HANDLE);

/** Pieces of a ROUTE_SPLIT place ("A/B" becomes ["A", "B"]). */
export const routePieces = (handle: string) => handle.split('/').filter((h) => h.length > 0);

export function placeKey(code: DrawingProblemCode, handle: string): string {
  return `${code}:${problemHandle(handle)}`;
}

/** Places answered by a correction still in force: fixed, but only gone after a rebuild. */
export function pendingPlaces(items: readonly DrawingCorrection[]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const item of items) {
    if (item.withdrawnAt !== null || item.problem === null) continue;
    keys.add(placeKey(item.problem.code, item.problem.handle));
  }
  return keys;
}

function request(
  code: DrawingProblemCode,
  place: DrawingProblemItem,
  correction: DrawingCorrectionInput,
): CreateDrawingCorrectionRequest {
  return { correction, problem: { code, handle: problemHandle(place.handle) } };
}

export const moveLayerRequest = (
  code: DrawingProblemCode,
  place: DrawingProblemItem,
  toLayer: string,
) => request(code, place, { kind: 'move_layer', handle: place.handle, toLayer });

export const setTextRequest = (code: DrawingProblemCode, place: DrawingProblemItem, text: string) =>
  request(code, place, { kind: 'set_text', handle: place.handle, text: text.trim() });

/** The offset is half a metre in drawing units (1 unit when the unit is not known yet). */
export function labelOffset(metresPerUnit: number | null): number {
  if (metresPerUnit === null || !(metresPerUnit > 0)) return 1;
  return Math.round((LABEL_OFFSET_M / metresPerUnit) * 1000) / 1000;
}

export function addTextRequest(
  code: DrawingProblemCode,
  place: DrawingProblemItem,
  text: string,
  metresPerUnit: number | null,
) {
  return request(code, place, {
    kind: 'add_text',
    // Type on the layer the checks suggest (one that carries the role), else on the symbol's own.
    layer: place.suggestedLayer ?? place.layer,
    x: place.drawingX,
    y: place.drawingY + labelOffset(metresPerUnit),
    text: text.trim(),
    height: null,
  });
}

export const addItemRequest = (
  code: DrawingProblemCode,
  place: DrawingProblemItem,
  layer: string,
) => request(code, place, { kind: 'add_item', layer, x: place.drawingX, y: place.drawingY });

export const mergeRoutesRequest = (code: DrawingProblemCode, place: DrawingProblemItem) =>
  request(code, place, { kind: 'merge_routes', handles: routePieces(place.handle) });

export interface PointLayer {
  layer: string;
  type: PointFeatureType;
}

/** Layers whose saved layer rule targets a point type: where "put an item here" can go. */
export function pointLayersOf(view: CadMappingView | undefined): PointLayer[] {
  const out: PointLayer[] = [];
  for (const rule of view?.mapping?.rules ?? []) {
    if (rule.source === 'layer' && isPointFeatureType(rule.target)) {
      out.push({ layer: rule.layer, type: rule.target });
    }
  }
  return out;
}

/**
 * Layers a move may target (owner 2026-11-09): only layers whose saved rule makes them a drawing
 * item or label, so an item never drops out of the checks by being moved. Same rule as the API.
 */
export const layerNamesOf = (view: CadMappingView | undefined): string[] =>
  [...moveLayerTargets(view?.mapping?.rules ?? [])].sort((a, b) => a.localeCompare(b));

export function metresPerUnitOf(view: CadMappingView | undefined): number | null {
  const value = Number(view?.mapping?.metresPerUnit);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Corrections made (or withdrawn) after the revision was built: the rebuild has news to apply. */
export function changesSinceBuild(
  items: readonly DrawingCorrection[],
  builtAt: string | null,
): number {
  if (builtAt === null) return 0;
  const built = Date.parse(builtAt);
  return items.filter(
    (item) =>
      Date.parse(item.createdAt) > built ||
      (item.withdrawnAt !== null && Date.parse(item.withdrawnAt) > built),
  ).length;
}

const REASONS = [
  'HANDLE_NOT_FOUND',
  'TOO_MANY_CORRECTIONS',
  'NOT_PROCESSED',
  'ALREADY_WITHDRAWN',
  'NOT_DRAFT',
  // The rebuild route's word for a revision that is not a draft or failed.
  'NOT_REBUILDABLE',
  'LAYER_HAS_NO_RULE',
  'VERSION_MISMATCH',
  'MAPPING_VERSION_MISMATCH',
] as const;
type Reason = (typeof REASONS)[number];

/** 409/422 with a known reason gets its own message; everything else the generic one. */
export function correctionErrorKey(code: ClientErrorCode, reason: string | null): MessageKey {
  if (
    (code === 'CONFLICT' || code === 'VALIDATION_FAILED') &&
    reason !== null &&
    (REASONS as readonly string[]).includes(reason)
  ) {
    return `design.corrections.error.${reason as Reason}`;
  }
  return `errors.${code}`;
}

export const correctionError = (code: ClientErrorCode, reason: string | null): ErrorMessage => ({
  key: correctionErrorKey(code, reason),
  params: {},
});

/** The mapping changed under the user: reload it before trying again. */
export const isMappingMismatch = (reason: string | null) =>
  reason === 'VERSION_MISMATCH' || reason === 'MAPPING_VERSION_MISMATCH';
