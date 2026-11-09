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
      { x: 5, y: 6, height: 2.5, text: 'NEW', layer: 1, color: '#00aa00' },
    ]);
  });

  it('add_item draws a symbol in the target layer colour', () => {
    const preview = applyCorrections(
      scene,
      [correction({ kind: 'add_item', layer: 'CABINET', x: 1, y: 2 })],
      2.5,
    );
    expect(preview.extraItems).toEqual([{ x: 1, y: 2, layer: 2, color: '#0000ff' }]);
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
