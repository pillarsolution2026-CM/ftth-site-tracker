import type { DrawingCorrection, DrawingCorrectionInput } from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import {
  arcCurveEdit,
  arcOfPoints,
  circleCurveEdit,
  copyEdits,
  editHandle,
  editRef,
  editRequests,
  entitiesInBand,
  eraseEdits,
  handlesOf,
  moveEdits,
  pointsCurveEdit,
  previewWithEdits,
  scaleEdits,
  setCurveEdit,
  type CanvasEdit,
} from './canvas-edit';
import { hitEntity } from './drawing-hit';
import { applyCorrections, effectiveLayer, EMPTY_PREVIEW } from './drawing-preview';
import { buildScene } from './drawing-scene';
import { FILE_ID, testView } from './drawing-test-view';
import { geometryOf } from './entity-geometry';
import { arcThrough, circlePoints } from './geometry';
import { gripsOf, gripStretchEdits } from './grips';
import { snapsAt, type SnapMode } from './object-snap';
import { isPageRow, pageSceneOf } from './page-scene';
import { nameOf, propertyRows } from './properties';

/**
 * Owner item 36 (ADR-061): everything drawn, pasted or copied on the page is an object, before
 * and after «حفظ» — picked, windowed, gripped, snapped, shown in Properties and edited by every
 * Modify command through its FIX- / NEW- handle.
 */

const file = buildScene(testView());
/** The test view has 5 entities: page rows start at index 5. */
const FIRST_ROW = 5;
const LINE_ID = '77777777-7777-4777-8777-777777777771';
const COPY_ID = '77777777-7777-4777-8777-777777777772';

const saved = (
  id: string,
  correction: DrawingCorrectionInput,
  minute: number,
): DrawingCorrection => ({
  id,
  cadFileId: FILE_ID,
  correction,
  problem: null,
  createdBy: null,
  createdAt: `2026-11-26T10:${String(minute).padStart(2, '0')}:00+00:00`,
  withdrawnBy: null,
  withdrawnAt: null,
});

const line = pointsCurveEdit(
  'Route',
  [
    [10, 10],
    [30, 10],
  ],
  false,
);

const all = () => true;
const only = (...modes: SnapMode[]) => new Set<SnapMode>(modes);

/** The preview and page scene of the saved corrections, with unsaved edits on top. */
function sceneOf(corrections: DrawingCorrection[], edits: CanvasEdit[] = []) {
  const base = applyCorrections(file, corrections, 2.5);
  const preview = previewWithEdits(file, base, edits);
  return { preview, scene: pageSceneOf(file, preview) };
}

describe('page scene (item 36)', () => {
  it('nothing drawn on the page: the file scene itself', () => {
    expect(pageSceneOf(file, EMPTY_PREVIEW)).toBe(file);
  });

  it('a saved line is a LINE row with its FIX- handle, picked, windowed and named', () => {
    const { preview, scene } = sceneOf([saved(LINE_ID, line, 1)]);
    const row = scene.view.entities[FIRST_ROW];
    expect(isPageRow(row)).toBe(true);
    expect(row).toMatchObject({ handle: `FIX-${LINE_ID}`, kind: 'LINE', layer: 0 });
    expect(scene.byHandle.get(`FIX-${LINE_ID}`)).toEqual([FIRST_ROW]);
    // The file's own entities keep their indexes and handles.
    expect(scene.byHandle.get('B')).toEqual([1]);
    expect(scene.view.entities.length).toBe(FIRST_ROW + 1);
    expect(hitEntity(scene, 20, 10.2, 0.5, all, preview.transformOf, preview.curveOf)).toBe(
      FIRST_ROW,
    );
    const windowed = entitiesInBand(
      scene,
      { x0: 5, y0: 5, x1: 35, y1: 15 },
      all,
      preview.transformOf,
      preview.erased,
      preview.curveOf,
    );
    expect(windowed).toEqual([FIRST_ROW]);
    expect(handlesOf(scene, [FIRST_ROW])).toEqual([`FIX-${LINE_ID}`]);
    expect(nameOf(scene, preview, FIRST_ROW)).toBe('Line');
    expect(effectiveLayer(scene, preview, FIRST_ROW)).toBe(0);
    // Asked of the file's scene (the canvas' base), the row's layer still answers.
    expect(effectiveLayer(file, preview, FIRST_ROW)).toBe(0);
  });

  it('grips of a drawn line: two ends and the middle; STRETCH of an end edits its handle', () => {
    const { preview, scene } = sceneOf([saved(LINE_ID, line, 1)]);
    const { grips } = gripsOf(scene, preview, new Set([FIRST_ROW]), false);
    expect(grips.map((g) => [g.kind, g.x, g.y])).toEqual([
      ['end', 10, 10],
      ['mid', 20, 10],
      ['end', 30, 10],
    ]);
    const end = grips[2];
    if (!end) throw new Error('no grip');
    const edits = gripStretchEdits(
      scene,
      preview,
      end,
      { x: 30, y: 10 },
      { x: 40, y: 20 },
      false,
      '',
    );
    expect(edits).toEqual([
      {
        kind: 'set_curve',
        handle: `FIX-${LINE_ID}`,
        points: [
          [10, 10],
          [40, 20],
        ],
        closed: false,
      },
    ]);
  });

  it('MOVE / ERASE / set_curve (TRIM) / Properties on a saved line act on the item itself', () => {
    const handle = `FIX-${LINE_ID}`;
    const moved = sceneOf([saved(LINE_ID, line, 1)], moveEdits([handle], 0, 5));
    expect(moved.scene.view.entities[FIRST_ROW]?.paths).toEqual([[10, 15, 30, 15]]);
    // The row is drawn where it is: no preview transform applies to it.
    expect(moved.preview.transformOf.size).toBe(0);
    expect(moved.preview.extraCurves[0]?.path).toEqual([10, 15, 30, 15]);

    const trimmed = sceneOf(
      [saved(LINE_ID, line, 1)],
      [
        setCurveEdit(
          handle,
          [
            [10, 10],
            [20, 10],
          ],
          false,
        ),
      ],
    );
    expect(trimmed.scene.view.entities[FIRST_ROW]?.paths).toEqual([[10, 10, 20, 10]]);

    const styled = sceneOf(
      [saved(LINE_ID, line, 1)],
      [{ kind: 'set_style', handle, color: '#ff00ff', linetype: 'dashed', lineweight: 50 }],
    );
    expect(styled.preview.extraCurves[0]?.color).toBe('#ff00ff');
    const rows = propertyRows({
      scene: styled.scene,
      preview: styled.preview,
      indexes: [FIRST_ROW],
      layers: ['Route'],
      vertex: 0,
    });
    expect(rows.find((r) => r.id === 'layer')?.value).toBe('Route');
    expect(rows.find((r) => r.id === 'linetype')?.raw).toBe('dashed');
    expect(rows.find((r) => r.id === 'length')?.value).toBe('20.0000');

    const erased = sceneOf([saved(LINE_ID, line, 1)], eraseEdits([handle]));
    expect(erased.preview.extraCurves).toEqual([]);
    expect(erased.preview.erased.has(FIRST_ROW)).toBe(true);
    // The row keeps its place (later rows keep their indexes) but cannot be picked.
    expect(erased.scene.view.entities.length).toBe(FIRST_ROW + 1);
    expect(hitEntity(erased.scene, 20, 10, 0.5, all)).toBeNull();
  });

  it('an unsaved line is a row with a NEW- handle; MOVE, COPY and COPY of the copy follow it', () => {
    const drawn = pointsCurveEdit(
      'Route',
      [
        [10, 10],
        [30, 10],
      ],
      false,
    );
    const first = sceneOf([], [drawn]);
    const handle = first.scene.view.entities[FIRST_ROW]?.handle ?? '';
    expect(handle).toBe(`NEW-${editRef(drawn)}`);
    expect(handle).toBe(editHandle(drawn));
    const [move] = moveEdits([handle], 0, 5);
    const [copy] = copyEdits([handle], 100, 0);
    if (!move || !copy) throw new Error('no edits');
    const second = sceneOf([], [drawn, move, copy]);
    const copyHandle = second.scene.view.entities[FIRST_ROW + 1]?.handle ?? '';
    expect(copyHandle).toBe(editHandle(copy));
    expect(second.scene.view.entities[FIRST_ROW + 1]?.paths).toEqual([[110, 15, 130, 15]]);
    const [copyOfCopy] = copyEdits([copyHandle], 0, 10);
    if (!copyOfCopy) throw new Error('no edit');
    const third = sceneOf([], [drawn, move, copy, copyOfCopy]);
    expect(third.scene.view.entities[FIRST_ROW + 2]?.paths).toEqual([[110, 25, 130, 25]]);
    expect(third.scene.view.entities[FIRST_ROW + 2]?.kind).toBe('LINE');
    // The save sends each add with its ref; the later edits name it NEW-<ref> (in order).
    const requests = editRequests([drawn, move, copy, copyOfCopy]);
    expect(requests.map((r) => r.ref)).toEqual([
      editRef(drawn),
      undefined,
      editRef(copy),
      editRef(copyOfCopy),
    ]);
    expect(requests[1]?.correction).toMatchObject({ kind: 'move_item', handle });
    expect(requests[2]?.correction).toMatchObject({ kind: 'copy_item', handle });
    expect(requests[3]?.correction).toMatchObject({ kind: 'copy_item', handle: copyHandle });
    expect('ref' in (requests[0]?.correction ?? {})).toBe(false);
    // Refs are unique and valid for the API.
    const refs = requests.flatMap((r) => (r.ref ? [r.ref] : []));
    expect(new Set(refs).size).toBe(refs.length);
    for (const ref of refs) expect(ref).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
  });

  it('after the save the same items have FIX- handles and the same row indexes', () => {
    const corrections = [
      saved(LINE_ID, line, 1),
      saved(
        COPY_ID,
        { kind: 'copy_item', handle: `FIX-${LINE_ID}`, dx: 100, dy: 0, toLayer: null },
        2,
      ),
    ];
    const { scene, preview } = sceneOf(corrections);
    expect(scene.view.entities[FIRST_ROW + 1]?.handle).toBe(`FIX-${COPY_ID}`);
    expect(scene.view.entities[FIRST_ROW + 1]?.paths).toEqual([[110, 10, 130, 10]]);
    // MOVE of the saved copy, then a copy of it.
    const moved = sceneOf(corrections, [
      ...moveEdits([`FIX-${COPY_ID}`], 0, 3),
      ...copyEdits([`FIX-${COPY_ID}`], 0, 10),
    ]);
    expect(moved.scene.view.entities[FIRST_ROW + 1]?.paths).toEqual([[110, 13, 130, 13]]);
    expect(moved.scene.view.entities[FIRST_ROW + 2]?.paths).toEqual([[110, 23, 130, 23]]);
    expect(preview.page.map((p) => p.handle)).toEqual([`FIX-${LINE_ID}`, `FIX-${COPY_ID}`]);
  });

  it('a batch saved at one time applies in the API order (created_at, then id)', () => {
    // Same created_at: the id decides, as the API and the build (not the list's newest-first).
    const corrections = [
      saved(COPY_ID, { kind: 'move_item', handle: `FIX-${LINE_ID}`, dx: 0, dy: 1 }, 1),
      saved(LINE_ID, line, 1),
    ];
    const { scene } = sceneOf(corrections);
    expect(scene.view.entities[FIRST_ROW]?.paths).toEqual([[10, 11, 30, 11]]);
  });

  it('a copy of a file entity is a row of the same kind with its own handle', () => {
    const [copy] = copyEdits(['B'], 0, -10);
    if (!copy) throw new Error('no edit');
    const { scene, preview } = sceneOf([], [copy]);
    const row = scene.view.entities[FIRST_ROW];
    expect(row).toMatchObject({ kind: 'LINE', handle: editHandle(copy), color: '#123456' });
    expect(row?.paths).toEqual([[50, 15, 100, 15]]);
    expect(preview.copies).toHaveLength(1);
    // TRIM of the copy turns it into the trimmed line, still with the copy's handle.
    const trimmed = sceneOf(
      [],
      [
        copy,
        setCurveEdit(
          editHandle(copy) ?? '',
          [
            [50, 15],
            [70, 15],
          ],
          false,
        ),
      ],
    );
    expect(trimmed.preview.copies).toHaveLength(0);
    expect(trimmed.scene.view.entities[FIRST_ROW]?.paths).toEqual([[50, 15, 70, 15]]);
    expect(trimmed.scene.view.entities[FIRST_ROW]?.handle).toBe(editHandle(copy));
  });

  it('a CIRCLE drawn is a true circle: centre and quadrant grips, CEN / QUA snaps, radius', () => {
    const circle = circleCurveEdit('Route', [60, 40], 5, circlePoints([60, 40], 5));
    expect(circle).toMatchObject({
      kind: 'add_curve',
      arc: { x: 60, y: 40, r: 5, start: 0, end: 360 },
    });
    const { scene, preview } = sceneOf([], [circle]);
    expect(scene.view.entities[FIRST_ROW]?.kind).toBe('CIRCLE');
    expect(geometryOf(scene, preview, FIRST_ROW)).toEqual({
      type: 'circle',
      center: { x: 60, y: 40 },
      radius: 5,
    });
    expect(nameOf(scene, preview, FIRST_ROW)).toBe('Circle');
    const { grips } = gripsOf(scene, preview, new Set([FIRST_ROW]), false);
    expect(grips.map((g) => [g.kind, g.x, g.y])).toEqual([
      ['center', 60, 40],
      ['quadrant', 65, 40],
      ['quadrant', 60, 45],
      ['quadrant', 55, 40],
      ['quadrant', 60, 35],
    ]);
    const source = { scene, preview, isShown: all };
    const cen = snapsAt(source, {
      cursor: [64.9, 40.5],
      aperture: 1,
      modes: only('center'),
      anchor: null,
    });
    expect(cen[0]).toMatchObject({ mode: 'center', at: [60, 40] });
    const qua = snapsAt(source, {
      cursor: [60.3, 44.8],
      aperture: 1,
      modes: only('quadrant'),
      anchor: null,
    });
    expect(qua[0]).toMatchObject({ mode: 'quadrant', at: [60, 45] });
    expect(
      propertyRows({ scene, preview, indexes: [FIRST_ROW], layers: [], vertex: 0 }).find(
        (r) => r.id === 'radius',
      )?.value,
    ).toBe('5.0000');
    // A quadrant grip pulled out scales the circle about its centre; the row follows.
    const quadrant = grips[1];
    if (!quadrant) throw new Error('no grip');
    const edits = gripStretchEdits(
      scene,
      preview,
      quadrant,
      { x: 65, y: 40 },
      { x: 68, y: 40 },
      false,
      '',
    );
    expect(edits).toEqual(scaleEdits([editHandle(circle) ?? ''], 60, 40, 1.6));
    const bigger = sceneOf([], [circle, ...(edits ?? [])]);
    expect(geometryOf(bigger.scene, bigger.preview, FIRST_ROW)).toEqual({
      type: 'circle',
      center: { x: 60, y: 40 },
      radius: 8,
    });
  });

  it('an ARC drawn is a true arc, counter-clockwise from start to end, either way it was drawn', () => {
    const ccw = arcOfPoints(arcThrough([10, 0], [0, 10], [-10, 0]));
    expect(ccw).toEqual({ x: 0, y: 0, r: 10, start: 0, end: 180 });
    // Drawn clockwise (from the left over the top to the right): AutoCAD keeps it from the end, counter-clockwise.
    const cw = arcOfPoints(arcThrough([-10, 0], [0, 10], [10, 0]));
    expect(cw).toEqual({ x: 0, y: 0, r: 10, start: 0, end: 180 });
    const edit = arcCurveEdit('Route', arcThrough([70, 10], [60, 20], [50, 10]));
    const { scene, preview } = sceneOf([], [edit]);
    expect(scene.view.entities[FIRST_ROW]?.kind).toBe('ARC');
    const geometry = geometryOf(scene, preview, FIRST_ROW);
    expect(geometry?.type).toBe('arc');
    if (geometry?.type !== 'arc') return;
    expect(geometry.center.x).toBeCloseTo(60);
    expect(geometry.center.y).toBeCloseTo(10);
    expect(geometry.mid.y).toBeCloseTo(20);
    const cen = snapsAt(
      { scene, preview, isShown: all },
      { cursor: [60.3, 19.8], aperture: 1, modes: only('center'), anchor: null },
    );
    expect(cen[0]?.at[0]).toBeCloseTo(60);
    expect(cen[0]?.at[1]).toBeCloseTo(10);
    // MIRROR runs it the other way round and keeps it a true arc.
    const mirrored = sceneOf(
      [],
      [edit, { kind: 'mirror_item', handle: editHandle(edit) ?? '', x1: 0, y1: 0, x2: 1, y2: 0 }],
    );
    const g = geometryOf(mirrored.scene, mirrored.preview, FIRST_ROW);
    expect(g?.type).toBe('arc');
    if (g?.type === 'arc') expect(g.mid.y).toBeCloseTo(-20);
  });

  it('snaps on page points, dimensions and tables (Node, Endpoint)', () => {
    const point: CanvasEdit = { kind: 'add_item', layer: 'CABINET', x: 70, y: 45 };
    const dim: CanvasEdit = {
      kind: 'add_note',
      note: 'dimension',
      layer: 'Route',
      points: [
        [10, 30],
        [20, 30],
        [15, 35],
      ],
      text: null,
    };
    const { scene, preview } = sceneOf([], [point, dim]);
    expect(scene.view.entities[FIRST_ROW]?.kind).toBe('POINT');
    expect(scene.view.entities[FIRST_ROW + 1]?.kind).toBe('DIMENSION');
    const source = { scene, preview, isShown: all };
    const node = (cursor: [number, number]) =>
      snapsAt(source, { cursor, aperture: 1, modes: only('node'), anchor: null })[0]?.at;
    expect(node([70.4, 45.3])).toEqual([70, 45]);
    expect(node([10.3, 30.2])).toEqual([10, 30]);
    expect(hitEntity(scene, 15, 35.1, 0.5, all)).toBe(FIRST_ROW + 1);
    expect(nameOf(scene, preview, FIRST_ROW + 1)).toBe('Rotated Dimension');
  });

  it('layers made on the page are layers of the page scene, named in Properties', () => {
    const edits: CanvasEdit[] = [
      { kind: 'add_layer', layer: 'SKETCH', like: null },
      pointsCurveEdit(
        'SKETCH',
        [
          [0, 5],
          [5, 5],
        ],
        false,
      ),
    ];
    const { scene, preview } = sceneOf([], edits);
    const layer = scene.layerByName.get('SKETCH');
    expect(layer).toBe(testView().layers.length);
    expect(scene.view.entities[FIRST_ROW]?.layer).toBe(layer);
    expect(
      propertyRows({ scene, preview, indexes: [FIRST_ROW], layers: [], vertex: 0 }).find(
        (r) => r.id === 'layer',
      )?.value,
    ).toBe('SKETCH');
  });

  it('the page rows are found by the spatial index next to the file’s entities', () => {
    const { scene } = sceneOf([saved(LINE_ID, line, 1)]);
    // Far from the line nothing of the page is a candidate; on it, the row is.
    expect(hitEntity(scene, 99, 49, 0.5, all)).toBeNull();
    expect(hitEntity(scene, 10, 10, 0.5, all)).toBe(FIRST_ROW);
  });
});
