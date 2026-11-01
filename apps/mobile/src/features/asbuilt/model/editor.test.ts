import { polylineLength } from '@ftth/geo';
import { RecordAsBuiltEditOpSchema, type AsBuiltFeatureState } from '@ftth/shared';
import {
  addDraftVertex,
  ALLOWED_SYMBOL_TYPES,
  buildOps,
  canRedo,
  canUndo,
  deleteVertex,
  EditorError,
  editorFeatures,
  finishRoute,
  gripsFor,
  hasChanges,
  hitGrip,
  insertSymbol,
  insertVertexAt,
  liveLength,
  moveGrip,
  moveSymbol,
  plannedEdits,
  previewGrip,
  redo,
  setLabel,
  snapCursor,
  staleFeatures,
  startEditor,
  undo,
  validateLabel,
} from './editor';
import {
  BOX,
  ctxOf,
  E,
  HHI,
  N,
  PROJECT,
  REVISION,
  remoteEdit,
  ROUTE,
  stateOf,
  USER,
  uuid,
} from './test-fixtures';

const save = (ctx = ctxOf(), s = startEditor(), extra = {}) =>
  buildOps(ctx, s, { newClientOpId: uuid, now: new Date('2026-10-31T09:00:00.000Z'), ...extra });

describe('snap', () => {
  it('snaps within 14 px at the current zoom and not beyond (boundary counts as inside)', () => {
    const ctx = ctxOf();
    const s = startEditor();
    // 0.5 m/px → 7 m tolerance
    const near = snapCursor(ctx, s, { x: E + 100 + 6.9, y: N }, 0.5, { featureId: BOX });
    // The handhole sits on the route's end: endpoint wins the tie (packages/geo G-2).
    expect(near.snapped).toMatchObject({ featureId: ROUTE, kind: 'endpoint' });
    expect(near.point).toEqual({ x: E + 100, y: N });
    const edge = snapCursor(ctx, s, { x: E + 107, y: N }, 0.5, { featureId: BOX });
    expect(edge.snapped?.featureId).toBeDefined();
    const far = snapCursor(ctx, s, { x: E + 107.1, y: N }, 0.5, { featureId: BOX });
    expect(far.snapped).toBeNull();
    expect(far.point).toEqual({ x: E + 107.1, y: N });
    // Zooming in shrinks the metre tolerance.
    expect(snapCursor(ctx, s, { x: E + 106, y: N }, 0.1, { featureId: BOX }).snapped).toBeNull();
  });

  it('snaps to route endpoints and vertices, never to the dragged feature itself', () => {
    const ctx = ctxOf();
    const s = startEditor();
    expect(snapCursor(ctx, s, { x: E + 50, y: N + 31 }, 0.5).snapped).toMatchObject({
      featureId: ROUTE,
      kind: 'vertex',
      vertexIndex: 1,
    });
    // A lone symbol (inserted in the session) snaps as a symbol.
    const lone = insertSymbol(s, 'joint', { x: E + 200, y: N + 200 }, uuid());
    expect(snapCursor(ctx, lone, { x: E + 202, y: N + 200 }, 0.5).snapped).toMatchObject({
      kind: 'symbol',
    });
    // Dragging the box: its own position is not a target (the route endpoint under it is).
    const own = snapCursor(ctx, s, { x: E + 1, y: N }, 0.5, { featureId: BOX });
    expect(own.snapped).toMatchObject({ featureId: ROUTE, kind: 'endpoint' });
    // Dragging that vertex of the route: it does not snap to itself.
    const self = snapCursor(ctx, s, { x: E + 50, y: N + 30.2 }, 0.5, {
      featureId: ROUTE,
      vertexIndex: 1,
    });
    expect(self.snapped).toBeNull();
  });
});

describe('move tool', () => {
  it('moves a symbol and sends one move op with the final point and base version 0', () => {
    const ctx = ctxOf();
    const s = moveSymbol(ctx, startEditor(), BOX, { x: E + 3, y: N + 4 });
    const [op, ...rest] = save(ctx, s);
    expect(rest).toEqual([]);
    expect(op).toMatchObject({
      kind: 'asbuilt_edit.record',
      payload: {
        kind: 'move',
        featureId: BOX,
        designRevisionId: REVISION,
        baseVersion: 0,
        geometry: { type: 'Point', coordinates: [E + 3, N + 4] },
        note: null,
        gps: null,
      },
      capturedAt: '2026-10-31T09:00:00.000Z',
    });
    expect(RecordAsBuiltEditOpSchema.safeParse(op).success).toBe(true);
  });

  it('collapses many drags into the final position; moving back is not a change', () => {
    const ctx = ctxOf();
    let s = moveSymbol(ctx, startEditor(), BOX, { x: E + 3, y: N });
    s = moveSymbol(ctx, s, BOX, { x: E + 9, y: N + 1 });
    expect(plannedEdits(ctx, s)).toHaveLength(1);
    expect(plannedEdits(ctx, s)[0]).toMatchObject({ kind: 'move', at: { x: E + 9, y: N + 1 } });
    s = moveSymbol(ctx, s, BOX, { x: E, y: N });
    expect(hasChanges(ctx, s)).toBe(false);
    expect(() => save(ctx, s)).toThrow(/Nothing changed/);
  });

  it('refuses the move tool on a route', () => {
    expect(() => moveSymbol(ctxOf(), startEditor(), ROUTE, { x: 0, y: 0 })).toThrow(EditorError);
  });
});

describe('reshape tool', () => {
  const ctx = ctxOf();

  it('shows a grip per vertex and one per segment middle', () => {
    const grips = gripsFor(ctx, startEditor(), ROUTE);
    expect(grips.filter((g) => g.kind === 'vertex')).toHaveLength(3);
    expect(grips.filter((g) => g.kind === 'midpoint')).toHaveLength(2);
    const mid = grips.find((g) => g.kind === 'midpoint');
    expect(hitGrip(grips, { x: (mid?.at.x ?? 0) + 3, y: mid?.at.y ?? 0 }, 0.1)).toBeNull();
    expect(hitGrip(grips, { x: (mid?.at.x ?? 0) + 3, y: mid?.at.y ?? 0 }, 0.5)).toEqual(mid);
  });

  it('moves a vertex, inserts at a segment middle and deletes a vertex; length matches polylineLength', () => {
    let s = moveGrip(ctx, startEditor(), ROUTE, 1, { x: E + 50, y: N + 40 });
    const moved = editorFeatures(ctx, s).find((f) => f.id === ROUTE)?.route ?? [];
    expect(liveLength(moved)).toBe(polylineLength(moved));
    expect(liveLength(moved)).toBeCloseTo(2 * Math.hypot(50, 40), 9);
    s = insertVertexAt(ctx, s, ROUTE, 0);
    expect(editorFeatures(ctx, s).find((f) => f.id === ROUTE)?.route).toHaveLength(4);
    s = deleteVertex(ctx, s, ROUTE, 1);
    expect(editorFeatures(ctx, s).find((f) => f.id === ROUTE)?.route).toHaveLength(3);
    const [op] = save(ctx, s);
    expect(op?.payload).toMatchObject({ kind: 'reshape', featureId: ROUTE, baseVersion: 0 });
  });

  it('previews the length while dragging a grip, for a vertex and a midpoint grip', () => {
    const grips = gripsFor(ctx, startEditor(), ROUTE);
    const vertex = grips.find((g) => g.kind === 'vertex' && g.vertexIndex === 1);
    const midpoint = grips.find((g) => g.kind === 'midpoint' && g.segmentIndex === 0);
    if (!vertex || !midpoint) throw new Error('grips');
    const a = previewGrip(ctx, startEditor(), ROUTE, vertex, { x: E + 50, y: N + 40 });
    expect(a).toHaveLength(3);
    const b = previewGrip(ctx, startEditor(), ROUTE, midpoint, { x: E + 10, y: N + 30 });
    expect(b).toHaveLength(4);
    expect(liveLength(b)).toBe(polylineLength(b));
  });

  it('never goes below 2 vertices and leaves the session unchanged', () => {
    let s = deleteVertex(ctx, startEditor(), ROUTE, 1);
    const before = s;
    expect(() => deleteVertex(ctx, s, ROUTE, 0)).toThrow(/two-vertex/);
    expect(s).toBe(before);
    s = undo(s);
    expect(editorFeatures(ctx, s).find((f) => f.id === ROUTE)?.route).toHaveLength(3);
  });

  it('drops repeated consecutive vertices from the final geometry (grip snapped onto its neighbour)', () => {
    const s = moveGrip(ctx, startEditor(), ROUTE, 1, { x: E, y: N });
    const [op] = save(ctx, s);
    expect(op?.payload).toMatchObject({
      kind: 'reshape',
      geometry: {
        coordinates: [
          [E, N],
          [E + 100, N],
        ],
      },
    });
  });

  it('refuses reshape on a symbol and a route that collapses to one point', () => {
    expect(() => moveGrip(ctx, startEditor(), BOX, 0, { x: 0, y: 0 })).toThrow(EditorError);
    let s = moveGrip(ctx, startEditor(), ROUTE, 1, { x: E, y: N });
    s = moveGrip(ctx, s, ROUTE, 2, { x: E, y: N });
    expect(() => save(ctx, s)).toThrow(EditorError);
  });
});

describe('draw route tool', () => {
  const ctx = ctxOf();

  it('needs at least 2 distinct vertices to finish', () => {
    let s = addDraftVertex(startEditor(), { x: E, y: N + 10 });
    expect(() => finishRoute(s, uuid())).toThrow(/2 distinct/);
    s = addDraftVertex(s, { x: E, y: N + 10 }); // repeat of the last vertex: ignored
    expect(s.draft).toHaveLength(1);
    s = addDraftVertex(s, { x: E + 20, y: N + 10 });
    const id = uuid();
    s = finishRoute(s, id);
    expect(s.draft).toEqual([]);
    const [op] = save(ctx, s);
    expect(op?.payload).toMatchObject({
      kind: 'add_route',
      featureId: id,
      label: null,
      geometry: {
        type: 'LineString',
        coordinates: [
          [E, N + 10],
          [E + 20, N + 10],
        ],
      },
    });
    expect('baseVersion' in (op?.payload ?? {})).toBe(false);
  });

  it('refuses to save while a route is still being drawn', () => {
    const s = addDraftVertex(startEditor(), { x: E, y: N });
    expect(() => save(ctx, s)).toThrow(/Finish or undo/);
    expect(hasChanges(ctx, s)).toBe(true);
  });

  it('can reshape and label the route it just drew; still one add op with the final shape', () => {
    let s = addDraftVertex(addDraftVertex(startEditor(), { x: E, y: N + 10 }), {
      x: E + 20,
      y: N + 10,
    });
    const id = uuid();
    s = finishRoute(s, id);
    s = moveGrip(ctx, s, id, 1, { x: E + 40, y: N + 10 });
    s = setLabel(ctx, s, id, ' R-9 ');
    const ops = save(ctx, s);
    expect(ops).toHaveLength(1);
    expect(ops[0]?.payload).toMatchObject({
      kind: 'add_route',
      label: 'R-9',
      geometry: {
        coordinates: [
          [E, N + 10],
          [E + 40, N + 10],
        ],
      },
    });
  });
});

describe('insert symbol tool', () => {
  it('allows the four point types (restrictive assumption until type_rules) and nothing else', () => {
    expect(ALLOWED_SYMBOL_TYPES).toEqual(['box', 'hhi', 'joint', 'mh']);
    for (const type of ALLOWED_SYMBOL_TYPES) {
      const id = uuid();
      const s = insertSymbol(startEditor(), type, { x: E + 5, y: N + 5 }, id);
      expect(save(ctxOf(), s)[0]?.payload).toMatchObject({
        kind: 'add_symbol',
        featureId: id,
        featureType: type,
        geometry: { type: 'Point', coordinates: [E + 5, N + 5] },
      });
    }
    expect(() => insertSymbol(startEditor(), 'route', { x: 0, y: 0 }, uuid())).toThrow(
      /cannot be inserted/,
    );
    expect(() => insertSymbol(startEditor(), 'pole', { x: 0, y: 0 }, uuid())).toThrow(EditorError);
  });

  it('moving a freshly inserted symbol keeps one add op', () => {
    const id = uuid();
    const ctx = ctxOf();
    let s = insertSymbol(startEditor(), 'joint', { x: E + 5, y: N + 5 }, id);
    s = moveSymbol(ctx, s, id, { x: E + 6, y: N + 6 });
    const ops = save(ctx, s);
    expect(ops).toHaveLength(1);
    expect(ops[0]?.payload).toMatchObject({ geometry: { coordinates: [E + 6, N + 6] } });
  });
});

describe('label tool', () => {
  const ctx = ctxOf();

  it('validates with AsBuiltLabelSchema', () => {
    expect(validateLabel('  ok  ')).toEqual({ ok: true, value: 'ok' });
    expect(validateLabel('   ').ok).toBe(false);
    expect(validateLabel('a'.repeat(201)).ok).toBe(false);
    expect(validateLabel('a\u0000b').ok).toBe(false);
    expect(() => setLabel(ctx, startEditor(), BOX, '')).toThrow(/Invalid label/);
  });

  it('sends a label op with the label base version; an unchanged text is not an edit', () => {
    expect(setLabel(ctx, startEditor(), BOX, '1-1')).toEqual(startEditor());
    const s = setLabel(ctx, startEditor(), BOX, 'صندوق جديد');
    const [op] = save(ctx, s);
    expect(op?.payload).toMatchObject({
      kind: 'label',
      featureId: BOX,
      label: 'صندوق جديد',
      baseVersion: 0,
    });
  });

  it('a moved and relabelled symbol gives two ops, each with its own new clientOpId', () => {
    let s = moveSymbol(ctx, startEditor(), BOX, { x: E + 1, y: N });
    s = setLabel(ctx, s, BOX, 'B');
    const ops = save(ctx, s);
    expect(ops.map((o) => o.payload.kind).sort()).toEqual(['label', 'move']);
    expect(new Set(ops.map((o) => o.clientOpId)).size).toBe(2);
  });
});

describe('undo and redo', () => {
  const ctx = ctxOf();

  it('walks back and forth over every kind of step through EditSession', () => {
    const id = uuid();
    let s = startEditor();
    s = moveSymbol(ctx, s, BOX, { x: E + 1, y: N });
    s = moveGrip(ctx, s, ROUTE, 1, { x: E + 50, y: N + 40 });
    s = setLabel(ctx, s, HHI, 'H');
    s = addDraftVertex(s, { x: E, y: N + 9 });
    s = addDraftVertex(s, { x: E + 9, y: N + 9 });
    s = finishRoute(s, id);
    s = insertSymbol(s, 'mh', { x: E + 7, y: N + 7 }, uuid());
    const full = plannedEdits(ctx, s).length;
    expect(full).toBe(5);
    expect(canUndo(s)).toBe(true);
    let t = s;
    for (let i = 0; i < 7; i++) t = undo(t);
    expect(canUndo(t)).toBe(false);
    expect(plannedEdits(ctx, t)).toEqual([]);
    expect(canRedo(t)).toBe(true);
    for (let i = 0; i < 7; i++) t = redo(t);
    expect(plannedEdits(ctx, t)).toEqual(plannedEdits(ctx, s));
    expect(canRedo(t)).toBe(false);
    // A new step discards the redo branch.
    t = undo(t);
    t = moveSymbol(ctx, t, BOX, { x: E + 2, y: N });
    expect(canRedo(t)).toBe(false);
  });

  it('redo of a reshape after the drawn route was undone and redone replays the same vertices', () => {
    const id = uuid();
    let s = finishRoute(
      addDraftVertex(addDraftVertex(startEditor(), { x: E, y: N + 9 }), { x: E + 9, y: N + 9 }),
      id,
    );
    s = insertVertexAt(ctx, s, id, 0, { x: E + 4, y: N + 12 });
    const final = editorFeatures(ctx, s).find((f) => f.id === id)?.route;
    s = undo(undo(s));
    s = redo(redo(s));
    expect(editorFeatures(ctx, s).find((f) => f.id === id)?.route).toEqual(final);
  });

  it('is a no-op on an empty history', () => {
    const s = startEditor();
    expect(undo(s)).toBe(s);
    expect(redo(s)).toBe(s);
  });
});

describe('base versions and stale state', () => {
  const approved: AsBuiltFeatureState[] = [
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
      label: 'R-1 معتمد',
      geometryVersion: 2,
      labelVersion: 1,
    },
  ];

  it('takes base versions from the approved state (bundle asBuilt), 0 for the design', () => {
    const ctx = ctxOf(stateOf({ asBuilt: approved }));
    let s = moveGrip(ctx, startEditor(), ROUTE, 1, { x: E + 100, y: N + 9 });
    s = setLabel(ctx, s, ROUTE, 'جديد');
    s = moveSymbol(ctx, s, BOX, { x: E + 1, y: N });
    const byKind = Object.fromEntries(
      save(ctx, s).map((o) => [
        o.payload.kind,
        'baseVersion' in o.payload ? o.payload.baseVersion : null,
      ]),
    );
    expect(byKind).toEqual({ reshape: 2, label: 1, move: 0 });
    // The editor starts from the approved As-Built shape, not the design.
    expect(editorFeatures(ctx, startEditor()).find((f) => f.id === ROUTE)?.route).toHaveLength(2);
  });

  it('uses approved edits pulled later; only approved ones, newest version wins; pending ones never', () => {
    const state = stateOf({
      asBuilt: approved,
      remote: [
        remoteEdit({
          featureId: ROUTE,
          kind: 'reshape',
          featureType: 'route',
          geometry: {
            type: 'LineString',
            coordinates: [
              [E, N],
              [E + 100, N + 7],
            ],
          },
          status: 'approved',
          approvedVersion: 3,
        }),
        // Already in the bundle (version 2): ignored.
        remoteEdit({
          featureId: ROUTE,
          kind: 'reshape',
          featureType: 'route',
          geometry: {
            type: 'LineString',
            coordinates: [
              [E, N],
              [E + 1, N],
            ],
          },
          status: 'approved',
          approvedVersion: 2,
        }),
        remoteEdit({
          featureId: BOX,
          kind: 'label',
          label: 'B2',
          status: 'approved',
          approvedVersion: 1,
        }),
        remoteEdit({
          featureId: HHI,
          kind: 'move',
          featureType: 'hhi',
          geometry: { type: 'Point', coordinates: [1, 1] },
          status: 'pending',
        }),
      ],
    });
    const route = state.byId.get(ROUTE);
    expect(route?.geometryVersion).toBe(3);
    expect(route?.geometry).toMatchObject({
      coordinates: [
        [E, N],
        [E + 100, N + 7],
      ],
    });
    expect(state.byId.get(BOX)).toMatchObject({ label: 'B2', labelVersion: 1, geometryVersion: 0 });
    expect(state.byId.get(HHI)?.geometryVersion).toBe(0);
  });

  it('a pulled approval while a session is open makes the session stale and blocks saving', () => {
    const before = ctxOf();
    const s = moveSymbol(before, startEditor(), BOX, { x: E + 5, y: N });
    expect(staleFeatures(before, s)).toEqual([]);
    const after = ctxOf(
      stateOf({
        remote: [
          remoteEdit({
            featureId: BOX,
            kind: 'move',
            geometry: { type: 'Point', coordinates: [E + 2, N] },
            status: 'approved',
            approvedVersion: 1,
          }),
        ],
      }),
    );
    expect(staleFeatures(after, s)).toEqual([BOX]);
    try {
      save(after, s);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toMatchObject({ code: 'STALE_BASE', featureIds: [BOX] });
    }
    // A label edit is not stale because of a shape approval (separate versions).
    const labelOnly = setLabel(before, startEditor(), BOX, 'Z');
    expect(staleFeatures(after, labelOnly)).toEqual([]);
    expect(save(after, labelOnly)[0]?.payload).toMatchObject({ kind: 'label', baseVersion: 0 });
  });

  it('edits an added feature approved earlier with its approved versions', () => {
    const added = uuid();
    const ctx = ctxOf(
      stateOf({
        remote: [
          remoteEdit({
            featureId: added,
            kind: 'add_symbol',
            featureType: 'joint',
            geometry: { type: 'Point', coordinates: [E + 9, N + 9] },
            label: 'J-new',
            status: 'approved',
            approvedVersion: 1,
          }),
        ],
      }),
    );
    expect(ctx.state.byId.get(added)).toMatchObject({
      added: true,
      geometryVersion: 1,
      labelVersion: 1,
    });
    const s = moveSymbol(ctx, startEditor(), added, { x: E + 10, y: N + 9 });
    expect(save(ctx, s)[0]?.payload).toMatchObject({
      kind: 'move',
      featureId: added,
      baseVersion: 1,
    });
  });
});

describe('op building', () => {
  it('carries note and GPS evidence, validates every op, and needs a revision', () => {
    const ctx = ctxOf();
    const s = moveSymbol(ctx, startEditor(), BOX, { x: E + 1, y: N });
    const gps = { lon: 31.2, lat: 30.1, accuracyM: 5, at: '2026-10-31T08:59:00.000Z' };
    const [op] = save(ctx, s, { note: '  تعديل حسب الواقع ', gps });
    expect(op?.payload).toMatchObject({ note: 'تعديل حسب الواقع', gps });
    expect(() => save({ ...ctx, revisionId: null }, s)).toThrow(/revision/);
    // A non-finite coordinate cannot be saved.
    const bad = moveSymbol(ctx, startEditor(), BOX, { x: Number.POSITIVE_INFINITY, y: N });
    expect(() => save(ctx, bad)).toThrow(EditorError);
    expect(PROJECT).toBeDefined();
    expect(USER).toBeDefined();
  });
});
