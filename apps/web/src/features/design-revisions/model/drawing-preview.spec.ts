import type { DrawingCorrection, DrawingCorrectionInput } from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import { applyCorrections, defaultTextHeight, effectiveLayer } from './drawing-preview';
import { buildScene } from './drawing-scene';
import { FILE_ID, testView } from './drawing-test-view';

const scene = buildScene(testView());

function correction(
  input: DrawingCorrectionInput,
  extra: Partial<DrawingCorrection> = {},
): DrawingCorrection {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    cadFileId: FILE_ID,
    correction: input,
    problem: null,
    createdBy: null,
    createdAt: '2026-11-09T10:00:00+00:00',
    withdrawnBy: null,
    withdrawnAt: null,
    ...extra,
  };
}

describe('correction preview', () => {
  it('move_layer draws the entity in the target layer and lists it under that layer', () => {
    const preview = applyCorrections(
      scene,
      [correction({ kind: 'move_layer', handle: 'A1', toLayer: 'CABINET' })],
      2.5,
    );
    expect(effectiveLayer(scene, preview, 2)).toBe(2);
    expect(effectiveLayer(scene, preview, 0)).toBe(0);
    expect(preview.layerOf.get(2)).toBe(2);
  });

  it('set_text replaces the entity text', () => {
    const preview = applyCorrections(
      scene,
      [correction({ kind: 'set_text', handle: 'T1', text: 'F 36 C 120 m' })],
      2.5,
    );
    expect(preview.textOf.get(3)).toBe('F 36 C 120 m');
  });

  it('add_text draws a new text in the layer colour, with a default height', () => {
    const preview = applyCorrections(
      scene,
      [correction({ kind: 'add_text', layer: 'Sap', x: 5, y: 6, text: 'NEW', height: null })],
      2.5,
    );
    expect(preview.extraTexts).toEqual([
      { x: 5, y: 6, height: 2.5, text: 'NEW', layer: 1, color: '#00aa00', layerName: 'Sap' },
    ]);
  });

  it('add_item draws a symbol in the target layer colour', () => {
    const preview = applyCorrections(
      scene,
      [correction({ kind: 'add_item', layer: 'CABINET', x: 1, y: 2 })],
      2.5,
    );
    expect(preview.extraItems).toEqual([
      { x: 1, y: 2, layer: 2, color: '#0000ff', layerName: 'CABINET' },
    ]);
  });

  it('merge_routes marks the pieces merged without changing them', () => {
    const preview = applyCorrections(
      scene,
      [correction({ kind: 'merge_routes', handles: ['A', 'B'] })],
      2.5,
    );
    expect([...preview.merged].sort()).toEqual([0, 1]);
    expect(preview.layerOf.size).toBe(0);
  });

  it('does not apply withdrawn corrections', () => {
    const preview = applyCorrections(
      scene,
      [
        correction(
          { kind: 'set_text', handle: 'T1', text: 'X' },
          { withdrawnAt: '2026-11-09T11:00:00+00:00' },
        ),
      ],
      2.5,
    );
    expect(preview.textOf.size).toBe(0);
  });

  it('applies oldest first, so the newest move wins', () => {
    const older = correction({ kind: 'move_layer', handle: 'A1', toLayer: 'Route' });
    const newer = correction(
      { kind: 'move_layer', handle: 'A1', toLayer: 'CABINET' },
      { createdAt: '2026-11-09T12:00:00+00:00' },
    );
    expect(applyCorrections(scene, [newer, older], 1).layerOf.get(2)).toBe(2);
  });

  it('ignores a handle or layer that is not in the view', () => {
    const preview = applyCorrections(
      scene,
      [
        correction({ kind: 'move_layer', handle: 'NOPE', toLayer: 'CABINET' }),
        correction({ kind: 'move_layer', handle: 'A1', toLayer: 'NOPE' }),
      ],
      1,
    );
    expect(preview.layerOf.size).toBe(0);
  });

  it('gives added labels 0.25 m of height, or 2.5 units without a scale', () => {
    expect(defaultTextHeight(0.5)).toBe(0.5);
    expect(defaultTextHeight(null)).toBe(2.5);
  });
});

describe('moves and turns in the preview (ADR-047)', () => {
  it('move_item then rotate_item give the entity one transform, in that order', () => {
    const preview = applyCorrections(
      scene,
      [
        correction({ kind: 'move_item', handle: 'B', dx: 0, dy: 10 }),
        correction(
          { kind: 'rotate_item', handle: 'B', x: 50, y: 35, angle: 90 },
          { createdAt: '2026-11-09T10:00:01+00:00' },
        ),
      ],
      2.5,
    );
    const t = preview.transformOf.get(1);
    expect(t).toBeDefined();
    // (50, 25) → moved to (50, 35) → the turn point stays.
    expect((t?.[0] ?? 0) * 50 + (t?.[2] ?? 0) * 25 + (t?.[4] ?? 0)).toBeCloseTo(50, 9);
    expect((t?.[1] ?? 0) * 50 + (t?.[3] ?? 0) * 25 + (t?.[5] ?? 0)).toBeCloseTo(35, 9);
    expect(preview.transformOf.has(0)).toBe(false);
  });
});

describe('CAD ribbon in the preview (ADR-050)', () => {
  const at = (n: number) => ({ createdAt: `2026-11-09T10:00:0${n}+00:00` });
  it('erases, copies, mirrors and scales; draws added lines', () => {
    const preview = applyCorrections(
      scene,
      [
        correction({ kind: 'erase_item', handle: 'A' }, at(1)),
        correction({ kind: 'copy_item', handle: 'B', dx: 0, dy: 10 }, at(2)),
        correction({ kind: 'mirror_item', handle: 'A1', x1: 0, y1: 0, x2: 0, y2: 1 }, at(3)),
        correction({ kind: 'scale_item', handle: 'T1', x: 0, y: 0, factor: 2 }, at(4)),
        correction(
          {
            kind: 'add_curve',
            layer: 'Route',
            points: [
              [0, 0],
              [5, 5],
            ],
            closed: false,
          },
          at(5),
        ),
      ],
      2.5,
    );
    expect([...preview.erased]).toEqual([0]);
    expect(preview.copies).toEqual([{ index: 1, transform: [1, 0, 0, 1, 0, 10] }]);
    const m = preview.transformOf.get(2);
    expect(m?.[0]).toBeCloseTo(-1, 9);
    expect(preview.transformOf.get(3)).toEqual([2, 0, 0, 2, 0, 0]);
    expect(preview.extraCurves).toEqual([
      { path: [0, 0, 5, 5], closed: false, layer: 0, color: '#ff0000', layerName: 'Route' },
    ]);
  });

  it('a new layer takes the colour of its source; rename moves, delete erases', () => {
    const preview = applyCorrections(
      scene,
      [
        correction({ kind: 'add_layer', layer: 'NEW', like: 'Sap' }, at(1)),
        correction({ kind: 'move_layer', handle: 'A', toLayer: 'NEW' }, at(2)),
        correction({ kind: 'rename_layer', from: 'Route', to: 'R2' }, at(3)),
        correction({ kind: 'delete_layer', layer: 'CABINET' }, at(4)),
      ],
      2.5,
    );
    expect(preview.layerOf.get(0)).toBe(1); // NEW draws like Sap
    expect(preview.layerOf.get(1)).toBe(0); // B renamed with Route, same colour
    expect(preview.aliases.get('R2')).toBe('Route');
    expect(preview.erased.has(2)).toBe(false); // A1 is on Sap, not CABINET
  });
});

describe('AutoCAD-like screen in the preview (ADR-051)', () => {
  const at = (n: number) => ({ createdAt: `2026-11-09T10:00:0${n}+00:00` });
  it('set_curve replaces the points (moves before it are in them); notes and styles are kept', () => {
    const preview = applyCorrections(
      scene,
      [
        correction({ kind: 'move_item', handle: 'A', dx: 5, dy: 0 }, at(1)),
        correction(
          {
            kind: 'set_curve',
            handle: 'A',
            points: [
              [5, 0],
              [30, 0],
            ],
            closed: false,
          },
          at(2),
        ),
        correction(
          { kind: 'add_note', note: 'leader', layer: 'Route', points: [[1, 2]], text: 'ODB' },
          at(3),
        ),
        correction(
          {
            kind: 'set_style',
            handle: 'B',
            color: '#00ff00',
            linetype: 'dashed',
            lineweight: null,
          },
          at(4),
        ),
        correction(
          { kind: 'set_style', handle: 'B', color: null, linetype: 'center', lineweight: 0.5 },
          at(5),
        ),
      ],
      2.5,
    );
    expect(preview.curveOf.get(0)).toEqual({
      points: [
        [5, 0],
        [30, 0],
      ],
      closed: false,
    });
    expect(preview.transformOf.has(0)).toBe(false);
    expect(preview.notes).toEqual([
      {
        note: 'leader',
        points: [[1, 2]],
        text: 'ODB',
        layer: 0,
        color: '#ff0000',
        layerName: 'Route',
      },
    ]);
    // The latest style wins.
    expect(preview.styleOf.get(1)).toEqual({ color: null, linetype: 'center', lineweight: 0.5 });
  });

  it('a deleted layer takes its notes with it', () => {
    const preview = applyCorrections(
      scene,
      [
        correction(
          { kind: 'add_note', note: 'dimension', layer: 'Route', points: [[0, 0]], text: null },
          at(1),
        ),
        correction({ kind: 'delete_layer', layer: 'Route' }, at(2)),
      ],
      2.5,
    );
    expect(preview.notes).toEqual([]);
  });
});

describe('screen shapes and draw order (owner 2026-11-24)', () => {
  it('add_shape is drawn in its layer colour; set_order keeps the latest order; delete_layer drops shapes', () => {
    const square: [number, number][] = [
      [0, 0],
      [5, 0],
      [5, 5],
    ];
    const shape = {
      kind: 'add_shape' as const,
      shape: 'hatch' as const,
      layer: 'Sap',
      points: square,
      pattern: 'ANSI31' as const,
      scale: 2,
      angle: 0,
      color: null,
      color2: null,
      inner: null,
      outer: null,
    };
    const preview = applyCorrections(
      scene,
      [
        correction(shape),
        correction({ kind: 'set_order', handle: 'B', order: 3 }),
        correction({ kind: 'set_order', handle: 'B', order: -1 }),
      ],
      2.5,
    );
    expect(preview.shapes).toEqual([
      expect.objectContaining({ shape: 'hatch', layer: 1, layerColor: '#00aa00', scale: 2 }),
    ]);
    expect(preview.orderOf.get(1)).toBe(-1);
    const gone = applyCorrections(
      scene,
      [correction(shape), correction({ kind: 'delete_layer', layer: 'Sap' })],
      2.5,
    );
    expect(gone.shapes).toEqual([]);
  });
});
