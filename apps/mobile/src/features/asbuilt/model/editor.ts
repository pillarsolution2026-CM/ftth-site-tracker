import {
  applyToSession,
  canRedo as routeCanRedo,
  distance,
  distanceToSegment,
  gripsOf,
  polylineLength,
  redoEdit,
  routeFromCoordinates,
  routeToCoordinates,
  sameRoute,
  snap,
  SNAP_TOLERANCE_PX,
  startEditSession,
  toAsBuiltRoute,
  toleranceFromPixels,
  undoEdit,
  type EditOperation,
  type EditSession,
  type Grip,
  type Point,
  type Polyline,
  type SnapResult,
  type SnapTarget,
} from '@ftth/geo';
import {
  AsBuiltLabelSchema,
  POINT_FEATURE_TYPES,
  RecordAsBuiltEditOpSchema,
  type FeatureType,
  type GpsFix,
  type PointFeatureType,
  type RecordAsBuiltEditOp,
} from '@ftth/shared';
import { labelOf, type AsBuiltState, type StateFeature } from './asbuilt-state';

/**
 * Editor model of the As-Built tools (roadmap Phase 4): pure functions over an immutable session.
 * Snap, grips, length and undo come from `@ftth/geo`; this module only combines them per tool.
 * Nothing here touches the design or the approved state: a session ends as one
 * `asbuilt_edit.record` op per changed feature (`buildOps`).
 */

/**
 * RESTRICTIVE ASSUMPTION until the Phase 2 `type_rules` exist: every point feature type may be
 * inserted (box, hhi, joint, mh). The owner narrows this list per project when the rules land.
 */
export const ALLOWED_SYMBOL_TYPES: readonly PointFeatureType[] = POINT_FEATURE_TYPES;

/** Half of the 44 dp touch target: a grip is hit when the finger is within this many pixels. */
export const GRIP_HIT_RADIUS_PX = 22;

export type AsBuiltTool = 'move' | 'reshape' | 'draw' | 'symbol' | 'label';
export const ASBUILT_TOOLS: readonly AsBuiltTool[] = ['move', 'reshape', 'draw', 'symbol', 'label'];

export type EditorErrorCode =
  | 'UNKNOWN_FEATURE'
  | 'NOT_A_ROUTE'
  | 'NOT_A_SYMBOL'
  | 'SYMBOL_TYPE_NOT_ALLOWED'
  | 'LABEL_INVALID'
  | 'NEED_TWO_VERTICES'
  | 'DRAFT_UNFINISHED'
  | 'NOTHING_TO_SAVE'
  | 'STALE_BASE'
  | 'NO_REVISION'
  | 'INVALID_OP';

export class EditorError extends Error {
  constructor(
    readonly code: EditorErrorCode,
    message: string,
    /** Features concerned (STALE_BASE). */
    readonly featureIds: readonly string[] = [],
  ) {
    super(message);
    this.name = 'EditorError';
  }
}

export interface EditorContext {
  state: AsBuiltState;
  /** The published revision of the bundle the supervisor draws on (null: nothing to edit). */
  revisionId: string | null;
}

type Entry =
  | { type: 'reshape'; id: string; op: EditOperation }
  | { type: 'move'; id: string; before: Point | null; after: Point }
  | { type: 'label'; id: string; before: string | undefined; after: string }
  | { type: 'draftVertex'; point: Point }
  | { type: 'finishRoute'; id: string; draft: readonly Point[]; route: Polyline }
  | { type: 'addSymbol'; id: string; featureType: PointFeatureType; at: Point };

interface AddedInfo {
  kind: 'route' | 'symbol';
  featureType: FeatureType;
}

export interface EditorSession {
  /** Approved versions seen when a feature was first touched; a pulled approval makes it stale. */
  bases: Readonly<Record<string, { geometry: number; label: number }>>;
  /** Final routes of reshaped existing routes and of routes drawn in this session. */
  routes: Readonly<Record<string, EditSession>>;
  /** Final positions of moved existing symbols and of symbols inserted in this session. */
  points: Readonly<Record<string, Point>>;
  labels: Readonly<Record<string, string>>;
  /** Features created in this session, in creation order. */
  added: Readonly<Record<string, AddedInfo>>;
  addedOrder: readonly string[];
  /** Vertices of the route being drawn (PLINE) that is not finished yet. */
  draft: readonly Point[];
  history: readonly Entry[];
  future: readonly Entry[];
}

export function startEditor(): EditorSession {
  return {
    bases: {},
    routes: {},
    points: {},
    labels: {},
    added: {},
    addedOrder: [],
    draft: [],
    history: [],
    future: [],
  };
}

// ---- effective geometry --------------------------------------------------------------------

const toPolyline = (coords: readonly (readonly [number, number])[]): Polyline =>
  routeFromCoordinates(coords);
const toPoint = (c: readonly [number, number]): Point => ({ x: c[0], y: c[1] });

export interface EditorFeature {
  id: string;
  type: FeatureType;
  kind: 'route' | 'symbol';
  label: string | null;
  /** Routes only. */
  route: Polyline | null;
  /** Symbols only. */
  at: Point | null;
  /** Created in this session or approved earlier as an added feature. */
  added: boolean;
  /** Touched by the open session. */
  touched: boolean;
}

function approvedFeature(ctx: EditorContext, id: string): StateFeature {
  const f = ctx.state.byId.get(id);
  if (!f) throw new EditorError('UNKNOWN_FEATURE', `Unknown feature ${id}`);
  return f;
}

/** Features as they look now: approved As-Built (or design) with the open session applied. */
export function editorFeatures(ctx: EditorContext, s: EditorSession): EditorFeature[] {
  const out: EditorFeature[] = ctx.state.features.map((f) => {
    const isRoute = f.geometry.type === 'LineString';
    return {
      id: f.id,
      type: f.type,
      kind: isRoute ? 'route' : 'symbol',
      label: s.labels[f.id] ?? labelOf(f),
      route:
        f.geometry.type === 'LineString'
          ? (s.routes[f.id]?.present ?? toPolyline(f.geometry.coordinates))
          : null,
      at: f.geometry.type === 'Point' ? (s.points[f.id] ?? toPoint(f.geometry.coordinates)) : null,
      added: f.added,
      touched: f.id in s.routes || f.id in s.points || f.id in s.labels,
    };
  });
  for (const id of s.addedOrder) {
    const info = s.added[id];
    if (!info) continue;
    out.push({
      id,
      type: info.featureType,
      kind: info.kind,
      label: s.labels[id] ?? null,
      route: info.kind === 'route' ? (s.routes[id]?.present ?? null) : null,
      at: info.kind === 'symbol' ? (s.points[id] ?? null) : null,
      added: true,
      touched: true,
    });
  }
  return out;
}

function featureOf(ctx: EditorContext, s: EditorSession, id: string): EditorFeature {
  const f = editorFeatures(ctx, s).find((candidate) => candidate.id === id);
  if (!f) throw new EditorError('UNKNOWN_FEATURE', `Unknown feature ${id}`);
  return f;
}

// ---- snap and picking ----------------------------------------------------------------------

export function snapTolerance(metresPerPixel: number): number {
  return toleranceFromPixels(SNAP_TOLERANCE_PX, metresPerPixel);
}

export function snapTargets(ctx: EditorContext, s: EditorSession): SnapTarget[] {
  return editorFeatures(ctx, s).flatMap((f): SnapTarget[] => {
    if (f.kind === 'symbol' && f.at) return [{ featureId: f.id, kind: 'symbol', at: f.at }];
    if (f.kind === 'route' && f.route)
      return [{ featureId: f.id, kind: 'route', vertices: f.route }];
    return [];
  });
}

/**
 * Where a dragged point lands: the nearest endpoint, vertex or symbol within 14 px at the current
 * zoom, else the cursor itself. `exclude` keeps the dragged feature (or vertex) from snapping to
 * itself.
 */
export function snapCursor(
  ctx: EditorContext,
  s: EditorSession,
  cursor: Point,
  metresPerPixel: number,
  exclude?: { featureId: string; vertexIndex?: number },
): { point: Point; snapped: SnapResult | null } {
  const found = snap(
    cursor,
    snapTargets(ctx, s),
    snapTolerance(metresPerPixel),
    exclude ? { exclude } : {},
  );
  return { point: found ? found.point : cursor, snapped: found };
}

/** The editable feature nearest to `cursor` within `radiusPx` (symbols win close calls). */
export function pickFeature(
  ctx: EditorContext,
  s: EditorSession,
  cursor: Point,
  metresPerPixel: number,
  kind: 'route' | 'symbol',
  radiusPx = GRIP_HIT_RADIUS_PX,
): EditorFeature | null {
  const tolerance = radiusPx * metresPerPixel;
  let best: { f: EditorFeature; d: number } | null = null;
  for (const f of editorFeatures(ctx, s)) {
    if (f.kind !== kind) continue;
    let d = Infinity;
    if (f.at) d = distance(cursor, f.at);
    if (f.route) {
      for (let i = 1; i < f.route.length; i++) {
        d = Math.min(d, distanceToSegment(cursor, f.route[i - 1] as Point, f.route[i] as Point));
      }
    }
    if (d <= tolerance && (!best || d < best.d)) best = { f, d };
  }
  return best?.f ?? null;
}

// ---- session plumbing ----------------------------------------------------------------------

function touch(ctx: EditorContext, s: EditorSession, id: string): EditorSession {
  if (s.bases[id] || s.added[id]) return s;
  const f = approvedFeature(ctx, id);
  return {
    ...s,
    bases: { ...s.bases, [id]: { geometry: f.geometryVersion, label: f.labelVersion } },
  };
}

function push(s: EditorSession, entry: Entry, next: Partial<EditorSession>): EditorSession {
  return { ...s, ...next, history: [...s.history, entry], future: [] };
}

function routeFeature(ctx: EditorContext, s: EditorSession, id: string): EditorFeature {
  const f = featureOf(ctx, s, id);
  if (f.kind !== 'route' || !f.route) throw new EditorError('NOT_A_ROUTE', `${id} is not a route`);
  return f;
}

function symbolFeature(ctx: EditorContext, s: EditorSession, id: string): EditorFeature {
  const f = featureOf(ctx, s, id);
  if (f.kind !== 'symbol' || !f.at) throw new EditorError('NOT_A_SYMBOL', `${id} is not a symbol`);
  return f;
}

// ---- move ----------------------------------------------------------------------------------

/** Move tool: puts a symbol at `to` (already snapped by the caller). One history step. */
export function moveSymbol(
  ctx: EditorContext,
  s: EditorSession,
  id: string,
  to: Point,
): EditorSession {
  const f = symbolFeature(ctx, s, id);
  const current = f.at as Point;
  if (current.x === to.x && current.y === to.y) return s;
  const touched = touch(ctx, s, id);
  return push(
    touched,
    { type: 'move', id, before: s.points[id] ?? null, after: to },
    { points: { ...touched.points, [id]: to } },
  );
}

// ---- reshape -------------------------------------------------------------------------------

export function gripsFor(ctx: EditorContext, s: EditorSession, routeId: string): Grip[] {
  return gripsOf(routeFeature(ctx, s, routeId).route as Polyline);
}

/** The grip under the finger: vertices win over segment midpoints when both are in reach. */
export function hitGrip(
  grips: readonly Grip[],
  cursor: Point,
  metresPerPixel: number,
): Grip | null {
  const tolerance = GRIP_HIT_RADIUS_PX * metresPerPixel;
  let best: { grip: Grip; d: number } | null = null;
  for (const grip of grips) {
    const d = distance(cursor, grip.at);
    if (d > tolerance) continue;
    const better =
      !best ||
      d < best.d ||
      (d === best.d && grip.kind === 'vertex' && best.grip.kind === 'midpoint');
    if (better) best = { grip, d };
  }
  return best?.grip ?? null;
}

function reshapeWith(
  ctx: EditorContext,
  s: EditorSession,
  id: string,
  op: EditOperation,
): EditorSession {
  const f = routeFeature(ctx, s, id);
  const touched = touch(ctx, s, id);
  const session = touched.routes[id] ?? startEditSession(f.route as Polyline);
  const next = applyToSession(session, op); // throws GeometryError, session unchanged
  return push(touched, { type: 'reshape', id, op }, { routes: { ...touched.routes, [id]: next } });
}

/** Grip drag released: vertex `vertexIndex` goes to `to` (already snapped). */
export function moveGrip(
  ctx: EditorContext,
  s: EditorSession,
  routeId: string,
  vertexIndex: number,
  to: Point,
): EditorSession {
  return reshapeWith(ctx, s, routeId, { type: 'moveVertex', vertexIndex, to });
}

/** Midpoint grip dragged: a new vertex is inserted in the segment at `at` (default: its middle). */
export function insertVertexAt(
  ctx: EditorContext,
  s: EditorSession,
  routeId: string,
  segmentIndex: number,
  at?: Point,
): EditorSession {
  return reshapeWith(
    ctx,
    s,
    routeId,
    at ? { type: 'insertVertex', segmentIndex, at } : { type: 'insertVertex', segmentIndex },
  );
}

/** Never below 2 vertices: `@ftth/geo` throws `TOO_FEW_VERTICES` and the session is unchanged. */
export function deleteVertex(
  ctx: EditorContext,
  s: EditorSession,
  routeId: string,
  vertexIndex: number,
): EditorSession {
  return reshapeWith(ctx, s, routeId, { type: 'removeVertex', vertexIndex });
}

/** Live length of a route while dragging (metres, planar, as PostGIS ST_Length). */
export function liveLength(route: Polyline): number {
  return polylineLength(route);
}

/** A dragged grip's preview: the route as it would be with the grip at `to`. */
export function previewGrip(
  ctx: EditorContext,
  s: EditorSession,
  routeId: string,
  grip: Grip,
  to: Point,
): Polyline {
  const route = routeFeature(ctx, s, routeId).route as Polyline;
  if (grip.kind === 'vertex') return route.map((p, i) => (i === grip.vertexIndex ? to : p));
  return [...route.slice(0, grip.segmentIndex + 1), to, ...route.slice(grip.segmentIndex + 1)];
}

// ---- draw route ----------------------------------------------------------------------------

/** Tap while drawing: adds a vertex (snapped by the caller). A repeat of the last vertex is ignored. */
export function addDraftVertex(s: EditorSession, at: Point): EditorSession {
  const last = s.draft[s.draft.length - 1];
  if (last && last.x === at.x && last.y === at.y) return s;
  return push(s, { type: 'draftVertex', point: at }, { draft: [...s.draft, at] });
}

export function canFinishRoute(s: EditorSession): boolean {
  return new Set(s.draft.map((p) => `${p.x}:${p.y}`)).size >= 2;
}

/** Finish needs at least 2 distinct vertices; the route gets a new client-generated id. */
export function finishRoute(s: EditorSession, newId: string): EditorSession {
  if (!canFinishRoute(s))
    throw new EditorError('NEED_TWO_VERTICES', 'A route needs 2 distinct vertices');
  const route = toAsBuiltRoute(s.draft);
  return push(
    s,
    { type: 'finishRoute', id: newId, draft: s.draft, route },
    {
      draft: [],
      routes: { ...s.routes, [newId]: startEditSession(route) },
      added: { ...s.added, [newId]: { kind: 'route', featureType: 'route' } },
      addedOrder: [...s.addedOrder, newId],
    },
  );
}

// ---- insert symbol -------------------------------------------------------------------------

export function insertSymbol(
  s: EditorSession,
  featureType: string,
  at: Point,
  newId: string,
): EditorSession {
  if (!(ALLOWED_SYMBOL_TYPES as readonly string[]).includes(featureType)) {
    throw new EditorError('SYMBOL_TYPE_NOT_ALLOWED', `${featureType} cannot be inserted`);
  }
  const type = featureType as PointFeatureType;
  return push(
    s,
    { type: 'addSymbol', id: newId, featureType: type, at },
    {
      points: { ...s.points, [newId]: at },
      added: { ...s.added, [newId]: { kind: 'symbol', featureType: type } },
      addedOrder: [...s.addedOrder, newId],
    },
  );
}

// ---- label ---------------------------------------------------------------------------------

/** Label tool (DDEDIT): text validated with the shared `AsBuiltLabelSchema`. */
export function validateLabel(text: string): { ok: true; value: string } | { ok: false } {
  const parsed = AsBuiltLabelSchema.safeParse(text);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

export function setLabel(
  ctx: EditorContext,
  s: EditorSession,
  id: string,
  text: string,
): EditorSession {
  const f = featureOf(ctx, s, id);
  const parsed = validateLabel(text);
  if (!parsed.ok) throw new EditorError('LABEL_INVALID', 'Invalid label');
  if (parsed.value === f.label) return s;
  const touched = touch(ctx, s, id);
  return push(
    touched,
    { type: 'label', id, before: s.labels[id], after: parsed.value },
    { labels: { ...touched.labels, [id]: parsed.value } },
  );
}

// ---- undo / redo ---------------------------------------------------------------------------

export const canUndo = (s: EditorSession): boolean => s.history.length > 0;
export const canRedo = (s: EditorSession): boolean => s.future.length > 0;

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

export function undo(s: EditorSession): EditorSession {
  const entry = s.history[s.history.length - 1];
  if (!entry) return s;
  const base = { history: s.history.slice(0, -1), future: [entry, ...s.future] };
  switch (entry.type) {
    case 'reshape': {
      const route = s.routes[entry.id];
      return route ? { ...s, ...base, routes: { ...s.routes, [entry.id]: undoEdit(route) } } : s;
    }
    case 'move':
      return {
        ...s,
        ...base,
        points: entry.before
          ? { ...s.points, [entry.id]: entry.before }
          : without(s.points, entry.id),
      };
    case 'label':
      return {
        ...s,
        ...base,
        labels:
          entry.before === undefined
            ? without(s.labels, entry.id)
            : { ...s.labels, [entry.id]: entry.before },
      };
    case 'draftVertex':
      return { ...s, ...base, draft: s.draft.slice(0, -1) };
    case 'finishRoute':
      return {
        ...s,
        ...base,
        draft: entry.draft,
        routes: without(s.routes, entry.id),
        added: without(s.added, entry.id),
        addedOrder: s.addedOrder.filter((id) => id !== entry.id),
      };
    case 'addSymbol':
      return {
        ...s,
        ...base,
        points: without(s.points, entry.id),
        added: without(s.added, entry.id),
        addedOrder: s.addedOrder.filter((id) => id !== entry.id),
      };
  }
}

export function redo(s: EditorSession): EditorSession {
  const entry = s.future[0];
  if (!entry) return s;
  const base = { history: [...s.history, entry], future: s.future.slice(1) };
  switch (entry.type) {
    case 'reshape': {
      const route = s.routes[entry.id];
      if (!route) return s;
      const next = routeCanRedo(route) ? redoEdit(route) : applyToSession(route, entry.op);
      return { ...s, ...base, routes: { ...s.routes, [entry.id]: next } };
    }
    case 'move':
      return { ...s, ...base, points: { ...s.points, [entry.id]: entry.after } };
    case 'label':
      return { ...s, ...base, labels: { ...s.labels, [entry.id]: entry.after } };
    case 'draftVertex':
      return { ...s, ...base, draft: [...s.draft, entry.point] };
    case 'finishRoute':
      return {
        ...s,
        ...base,
        draft: [],
        routes: { ...s.routes, [entry.id]: startEditSession(entry.route) },
        added: { ...s.added, [entry.id]: { kind: 'route', featureType: 'route' } },
        addedOrder: [...s.addedOrder, entry.id],
      };
    case 'addSymbol':
      return {
        ...s,
        ...base,
        points: { ...s.points, [entry.id]: entry.at },
        added: { ...s.added, [entry.id]: { kind: 'symbol', featureType: entry.featureType } },
        addedOrder: [...s.addedOrder, entry.id],
      };
  }
}

// ---- save ----------------------------------------------------------------------------------

export type PlannedEdit =
  | { kind: 'add_route'; featureId: string; geometry: Polyline; label: string | null }
  | {
      kind: 'add_symbol';
      featureId: string;
      featureType: PointFeatureType;
      at: Point;
      label: string | null;
    }
  | { kind: 'move'; featureId: string; at: Point; baseVersion: number }
  | { kind: 'reshape'; featureId: string; geometry: Polyline; baseVersion: number }
  | { kind: 'label'; featureId: string; label: string; baseVersion: number };

/** What the session changes against the approved state; moves back to the start are not changes. */
export function plannedEdits(ctx: EditorContext, s: EditorSession): PlannedEdit[] {
  const plan: PlannedEdit[] = [];
  for (const id of s.addedOrder) {
    const info = s.added[id];
    if (!info) continue;
    const label = s.labels[id] ?? null;
    const at = s.points[id];
    const route = s.routes[id];
    if (info.kind === 'route' && route) {
      plan.push({
        kind: 'add_route',
        featureId: id,
        geometry: toAsBuiltRoute(route.present),
        label,
      });
    } else if (info.kind === 'symbol' && at) {
      plan.push({
        kind: 'add_symbol',
        featureId: id,
        featureType: info.featureType as PointFeatureType,
        at,
        label,
      });
    }
  }
  for (const [id, base] of Object.entries(s.bases)) {
    const f = ctx.state.byId.get(id);
    if (!f) continue;
    const route = s.routes[id];
    if (route && f.geometry.type === 'LineString') {
      const final = toAsBuiltRoute(route.present);
      if (!sameRoute(final, toPolyline(f.geometry.coordinates))) {
        plan.push({ kind: 'reshape', featureId: id, geometry: final, baseVersion: base.geometry });
      }
    }
    const at = s.points[id];
    if (at && f.geometry.type === 'Point') {
      const [x, y] = f.geometry.coordinates;
      if (at.x !== x || at.y !== y)
        plan.push({ kind: 'move', featureId: id, at, baseVersion: base.geometry });
    }
    const label = s.labels[id];
    if (label !== undefined && label !== labelOf(f)) {
      plan.push({ kind: 'label', featureId: id, label, baseVersion: base.label });
    }
  }
  return plan;
}

export function hasChanges(ctx: EditorContext, s: EditorSession): boolean {
  return s.draft.length > 0 || plannedEdits(ctx, s).length > 0;
}

/**
 * Features drawn on an approved version that is no longer current (a pulled approval raised it
 * while the session was open). The server would refuse to approve such an edit (STALE_BASE), so
 * saving is blocked: cancel and redraw on the current state.
 */
export function staleFeatures(ctx: EditorContext, s: EditorSession): string[] {
  const stale: string[] = [];
  for (const [id, base] of Object.entries(s.bases)) {
    const f = ctx.state.byId.get(id);
    if (!f) continue;
    const geometryChanged = id in s.routes || id in s.points;
    const labelChanged = id in s.labels;
    if (
      (geometryChanged && f.geometryVersion !== base.geometry) ||
      (labelChanged && f.labelVersion !== base.label)
    ) {
      stale.push(id);
    }
  }
  return stale;
}

export interface SaveInput {
  newClientOpId: () => string;
  now: Date;
  note?: string | null;
  gps?: GpsFix | null;
}

/**
 * One `asbuilt_edit.record` op per changed feature with the FINAL geometry in project-CRS metres,
 * the approved base version, the bundle revision, a new `clientOpId`, and optional note and GPS
 * evidence. Every op is validated with `RecordAsBuiltEditOpSchema` before it is returned.
 */
export function buildOps(
  ctx: EditorContext,
  s: EditorSession,
  input: SaveInput,
): RecordAsBuiltEditOp[] {
  if (!ctx.revisionId) throw new EditorError('NO_REVISION', 'No design revision');
  if (s.draft.length > 0)
    throw new EditorError('DRAFT_UNFINISHED', 'Finish or undo the route being drawn');
  const stale = staleFeatures(ctx, s);
  if (stale.length > 0) throw new EditorError('STALE_BASE', 'The approved state changed', stale);
  let plan: PlannedEdit[];
  try {
    plan = plannedEdits(ctx, s);
  } catch {
    throw new EditorError('INVALID_OP', 'Invalid geometry');
  }
  if (plan.length === 0) throw new EditorError('NOTHING_TO_SAVE', 'Nothing changed');
  const note = input.note?.trim() ? input.note.trim() : null;
  const common = (featureId: string) => ({
    featureId,
    designRevisionId: ctx.revisionId,
    note,
    gps: input.gps ?? null,
  });
  const ops = plan.map((edit) => {
    const payload = (() => {
      switch (edit.kind) {
        case 'add_route':
          return {
            kind: edit.kind,
            ...common(edit.featureId),
            geometry: { type: 'LineString', coordinates: routeToCoordinates(edit.geometry) },
            label: edit.label,
          };
        case 'add_symbol':
          return {
            kind: edit.kind,
            ...common(edit.featureId),
            featureType: edit.featureType,
            geometry: { type: 'Point', coordinates: [edit.at.x, edit.at.y] },
            label: edit.label,
          };
        case 'move':
          return {
            kind: edit.kind,
            ...common(edit.featureId),
            baseVersion: edit.baseVersion,
            geometry: { type: 'Point', coordinates: [edit.at.x, edit.at.y] },
          };
        case 'reshape':
          return {
            kind: edit.kind,
            ...common(edit.featureId),
            baseVersion: edit.baseVersion,
            geometry: { type: 'LineString', coordinates: routeToCoordinates(edit.geometry) },
          };
        case 'label':
          return {
            kind: edit.kind,
            ...common(edit.featureId),
            baseVersion: edit.baseVersion,
            label: edit.label,
          };
      }
    })();
    const parsed = RecordAsBuiltEditOpSchema.safeParse({
      kind: 'asbuilt_edit.record',
      clientOpId: input.newClientOpId(),
      capturedAt: input.now.toISOString(),
      payload,
    });
    if (!parsed.success)
      throw new EditorError('INVALID_OP', parsed.error.message, [edit.featureId]);
    return parsed.data;
  });
  return ops;
}
