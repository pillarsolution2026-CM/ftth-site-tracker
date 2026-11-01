import type { OutboxEntry } from '@ftth/sync';
import type { RecordAsBuiltEditOp } from '@ftth/shared';
import { buildOps, startEditor } from './editor';
import {
  applyLabelText,
  deleteSelectedVertex,
  finishDrawing,
  liveLengthM,
  pointerDown,
  pointerMove,
  pointerUp,
  redoUi,
  setTool,
  startEditorUi,
  tap,
  undoUi,
  type EditorUi,
} from './editor-ui';
import { ownEditRows, rejectionKey } from './own-edits';
import { buildRenderModel } from './render-model';
import {
  BOX,
  ctxOf,
  E,
  N,
  REVISION,
  remoteEdit,
  ROUTE,
  stateOf,
  USER,
  uuid,
} from './test-fixtures';
import { polylineLength } from '@ftth/geo';

const ctx = ctxOf();
const MPP = 0.5;
const at = (x: number, y: number) => ({ world: { x, y }, metresPerPixel: MPP });

function opFor(
  payload: RecordAsBuiltEditOp['payload'],
  state: OutboxEntry['state'] = 'pending',
): OutboxEntry {
  return {
    clientOpId: uuid(),
    op: {
      kind: 'asbuilt_edit.record',
      clientOpId: uuid(),
      capturedAt: '2026-10-31T09:00:00.000Z',
      payload,
    },
    state,
    attempts: 0,
    updateId: null,
    rejection: null,
  };
}

describe('pointer flows', () => {
  it('move tool: grabs a symbol, follows the finger with snap, commits one step on release', () => {
    let ui = setTool(startEditorUi(), 'move');
    const down = pointerDown(ctx, ui, at(E + 1, N + 1));
    expect(down.grabbed).toBe(true);
    ui = pointerMove(ctx, down.ui, at(E + 40, N - 20));
    expect(ui.drag).toMatchObject({ kind: 'symbol', moved: true, snapped: null });
    // Near the route vertex at (E+50, N+30): snaps to it.
    ui = pointerMove(ctx, ui, at(E + 51, N + 31));
    expect(ui.drag?.snapped).toMatchObject({ kind: 'vertex' });
    expect(ui.drag?.at).toEqual({ x: E + 50, y: N + 30 });
    ui = pointerUp(ctx, ui);
    expect(ui.drag).toBeNull();
    expect(ui.session.history).toHaveLength(1);
    expect(
      buildOps(ctx, ui.session, { newClientOpId: uuid, now: new Date() })[0]?.payload,
    ).toMatchObject({
      kind: 'move',
      geometry: { coordinates: [E + 50, N + 30] },
    });
    // Empty ground: nothing grabbed (the screen pans).
    expect(pointerDown(ctx, ui, at(E + 500, N + 500)).grabbed).toBe(false);
  });

  it('a touch on a symbol without travel moves nothing', () => {
    let ui = setTool(startEditorUi(), 'move');
    ui = pointerDown(ctx, ui, at(E, N)).ui;
    ui = pointerUp(ctx, ui);
    expect(ui.session.history).toHaveLength(0);
  });

  it('reshape: select a route by tap, drag a vertex grip, live length equals polylineLength', () => {
    let ui = tap(ctx, startEditorUi(), at(E + 25, N + 15), uuid);
    expect(ui.selectedId).toBe(ROUTE);
    const down = pointerDown(ctx, ui, at(E + 50, N + 30));
    expect(down.grabbed).toBe(true);
    ui = pointerMove(ctx, down.ui, at(E + 50, N + 60));
    const live = liveLengthM(ctx, ui);
    expect(live).toBeCloseTo(2 * Math.hypot(50, 60), 9);
    ui = pointerUp(ctx, ui);
    const route = buildRenderModel(ctx, ui).features.find((f) => f.id === ROUTE)?.coords ?? [];
    expect(liveLengthM(ctx, ui)).toBe(polylineLength(route.map(([x, y]) => ({ x, y }))));
    expect(ui.session.history).toHaveLength(1);
  });

  it('reshape: dragging a segment-midpoint grip inserts a vertex; tap a vertex then delete it', () => {
    let ui: EditorUi = tap(ctx, startEditorUi(), at(E + 25, N + 15), uuid);
    ui = pointerDown(ctx, ui, at(E + 25, N + 15)).ui; // midpoint of segment 0
    expect(ui.drag).toMatchObject({ kind: 'grip', grip: { kind: 'midpoint', segmentIndex: 0 } });
    ui = pointerUp(ctx, pointerMove(ctx, ui, at(E + 20, N + 40)));
    expect(buildRenderModel(ctx, ui).features.find((f) => f.id === ROUTE)?.coords).toHaveLength(4);
    // Tap the new vertex (index 1) to select it, then delete.
    ui = pointerUp(ctx, pointerDown(ctx, ui, at(E + 20, N + 40)).ui);
    expect(ui.selectedVertex).toBe(1);
    ui = deleteSelectedVertex(ctx, ui);
    expect(buildRenderModel(ctx, ui).features.find((f) => f.id === ROUTE)?.coords).toHaveLength(3);
    expect(ui.selectedVertex).toBeNull();
    // Undo / redo through the UI.
    ui = undoUi(ui);
    expect(buildRenderModel(ctx, ui).features.find((f) => f.id === ROUTE)?.coords).toHaveLength(4);
    ui = redoUi(ui);
    expect(buildRenderModel(ctx, ui).features.find((f) => f.id === ROUTE)?.coords).toHaveLength(3);
  });

  it('deleting from a 2-vertex route is refused with an error, session unchanged', () => {
    let ui: EditorUi = tap(ctx, startEditorUi(), at(E + 25, N + 15), uuid);
    ui = deleteSelectedVertex(ctx, { ...ui, selectedVertex: 1 }); // 3 → 2 vertices
    expect(ui.error).toBeNull();
    const before = ui.session;
    ui = deleteSelectedVertex(ctx, { ...ui, selectedVertex: 0 });
    expect(ui.error).toBe('NEED_TWO_VERTICES');
    expect(ui.session).toBe(before);
  });

  it('draw: taps add snapped vertices, finish needs 2 distinct, then one add_route', () => {
    let ui = setTool(startEditorUi(), 'draw');
    ui = tap(ctx, ui, at(E + 1, N + 1), uuid); // snaps to (E, N)
    expect(ui.session.draft).toEqual([{ x: E, y: N }]);
    ui = finishDrawing(ui, uuid());
    expect(ui.error).toBe('NEED_TWO_VERTICES');
    ui = tap(ctx, ui, at(E + 200, N + 100), uuid);
    const id = uuid();
    ui = finishDrawing(ui, id);
    expect(ui.error).toBeNull();
    expect(ui.selectedId).toBe(id);
    expect(buildOps(ctx, ui.session, { newClientOpId: uuid, now: new Date() })).toHaveLength(1);
  });

  it('symbol: a tap inserts the chosen type at the snapped point', () => {
    let ui = setTool(startEditorUi(), 'symbol');
    ui = { ...ui, symbolType: 'mh' };
    const id = uuid();
    ui = tap(ctx, ui, at(E + 300, N + 300), () => id);
    expect(ui.selectedId).toBe(id);
    expect(
      buildOps(ctx, ui.session, { newClientOpId: uuid, now: new Date() })[0]?.payload,
    ).toMatchObject({
      kind: 'add_symbol',
      featureType: 'mh',
      featureId: id,
    });
  });

  it('label: a tap selects, the text is validated, an invalid text keeps the session', () => {
    let ui = setTool(startEditorUi(), 'label');
    ui = tap(ctx, ui, at(E, N + 0.5), uuid);
    expect(ui.selectedId).toBeDefined();
    const bad = applyLabelText(ctx, ui, '   ');
    expect(bad.error).toBe('LABEL_INVALID');
    expect(bad.session).toBe(ui.session);
    ui = applyLabelText(ctx, ui, 'جديد');
    expect(ui.error).toBeNull();
    expect(ui.session.history).toHaveLength(1);
    expect(startEditor().history).toHaveLength(0);
  });
});

describe('own edits and the pending overlay', () => {
  it('lists my edits with status: queued, sent, approved, rejected with reason, refused on push', () => {
    const queued = opFor({
      kind: 'move',
      featureId: BOX,
      designRevisionId: REVISION,
      baseVersion: 0,
      geometry: { type: 'Point', coordinates: [E + 1, N] },
      note: null,
      gps: null,
    });
    const sent = opFor(
      {
        kind: 'label',
        featureId: BOX,
        designRevisionId: REVISION,
        baseVersion: 0,
        label: 'X',
        note: null,
        gps: null,
      },
      'applied',
    );
    const refused: OutboxEntry = {
      ...opFor(
        {
          kind: 'move',
          featureId: BOX,
          designRevisionId: REVISION,
          baseVersion: 0,
          geometry: { type: 'Point', coordinates: [E + 2, N] },
          note: null,
          gps: null,
        },
        'rejected',
      ),
      rejection: 'GEOMETRY_INVALID',
    };
    const reviewed = opFor(
      {
        kind: 'move',
        featureId: ROUTE,
        designRevisionId: REVISION,
        baseVersion: 0,
        geometry: { type: 'Point', coordinates: [E, N] },
        note: null,
        gps: null,
      } as unknown as RecordAsBuiltEditOp['payload'],
      'applied',
    );
    const state = stateOf({
      entries: [queued, sent, refused, reviewed],
      remote: [
        remoteEdit({
          clientOpId: sent.clientOpId,
          featureId: BOX,
          kind: 'label',
          label: 'X',
          userId: USER,
          status: 'approved',
          approvedVersion: 1,
        }),
        remoteEdit({
          clientOpId: reviewed.clientOpId,
          featureId: ROUTE,
          kind: 'move',
          userId: USER,
          status: 'rejected',
          reviewReason: 'صورة غير واضحة',
        }),
        // Made on another device of mine: listed too; someone else's is not.
        remoteEdit({ featureId: BOX, kind: 'label', label: 'Y', userId: USER, status: 'pending' }),
        remoteEdit({ featureId: BOX, kind: 'label', label: 'Z', status: 'pending' }),
      ],
    });
    const rows = ownEditRows(state);
    expect(rows).toHaveLength(5);
    const byOp = new Map(rows.map((r) => [r.clientOpId, r]));
    expect(byOp.get(queued.clientOpId)).toMatchObject({ status: 'queued', sent: false });
    expect(byOp.get(sent.clientOpId)).toMatchObject({ status: 'approved', sent: true });
    expect(byOp.get(refused.clientOpId)).toMatchObject({
      status: 'rejected',
      syncRejection: 'GEOMETRY_INVALID',
    });
    expect(byOp.get(reviewed.clientOpId)).toMatchObject({
      status: 'rejected',
      reason: 'صورة غير واضحة',
    });
    expect(rejectionKey('GEOMETRY_INVALID')).toBe('asbuilt.rejections.GEOMETRY_INVALID');
    expect(rejectionKey('FEATURE_NOT_FOUND')).toBe('field.pending.rejections.FEATURE_NOT_FOUND');
    // The approved label is part of the approved state; my pending proposal is not.
    expect(state.byId.get(BOX)?.label).toBe('X');
  });

  it('draws my pending edit marked as pending and the design dashed underneath, never as a base', () => {
    const queued = opFor({
      kind: 'move',
      featureId: BOX,
      designRevisionId: REVISION,
      baseVersion: 0,
      geometry: { type: 'Point', coordinates: [E + 7, N] },
      note: null,
      gps: null,
    });
    const state = stateOf({ entries: [queued] });
    const pendingCtx = ctxOf(state);
    const model = buildRenderModel(pendingCtx, startEditorUi());
    const box = model.features.find((f) => f.id === BOX);
    expect(box).toMatchObject({ style: 'pending', coords: [[E + 7, N]] });
    expect(model.design.find((d) => d.id === BOX)?.coords).toEqual([[E, N]]);
    // The approved state (and so the next base) is still the design.
    expect(state.byId.get(BOX)).toMatchObject({
      geometryVersion: 0,
      geometry: { coordinates: [E, N] },
    });
    // An unedited feature is drawn once, in its own colour.
    expect(model.features.find((f) => f.id === ROUTE)?.style).toBe('design');
    expect(model.design.find((d) => d.id === ROUTE)).toBeUndefined();
  });

  it('draws approved As-Built in the As-Built style with the design dashed under it', () => {
    const state = stateOf({
      asBuilt: [
        {
          featureId: ROUTE,
          featureType: 'route',
          added: false,
          geometry: {
            type: 'LineString',
            coordinates: [
              [E, N],
              [E + 100, N + 5],
            ],
          },
          lengthM: '100.125',
          label: null,
          geometryVersion: 1,
          labelVersion: 0,
        },
      ],
    });
    const model = buildRenderModel(ctxOf(state), startEditorUi());
    expect(model.features.find((f) => f.id === ROUTE)?.style).toBe('approved');
    expect(model.design.find((d) => d.id === ROUTE)?.coords).toHaveLength(3);
  });
});
