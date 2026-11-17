import { describe, expect, it } from 'vitest';
import {
  addEdits,
  editRequests,
  entitiesInBand,
  handlesOf,
  isCrossing,
  isTextEntity,
  moveEdits,
  previewWithEdits,
  rotateEdits,
} from './canvas-edit';
import { EMPTY_PREVIEW } from './drawing-preview';
import { buildScene } from './drawing-scene';
import { testView } from './drawing-test-view';

const scene = buildScene(testView());
const all = () => true;
// Entities of the test view: 0 A (route), 1 B (route), 2 A1 (insert 20..22), 3 T1 (text at 30,30), 4 H1.

describe('canvas edits (ADR-047)', () => {
  it('keeps one edit per kind and handle, the later one winning, in the order made', () => {
    const edits = addEdits(
      [
        { kind: 'move_layer', handle: 'A', toLayer: 'Sap' },
        { kind: 'set_text', handle: 'T1', text: 'x' },
      ],
      [
        { kind: 'move_layer', handle: 'A', toLayer: 'CABINET' },
        { kind: 'set_text', handle: 'A', text: 'y' },
      ],
    );
    expect(edits).toEqual([
      { kind: 'set_text', handle: 'T1', text: 'x' },
      { kind: 'move_layer', handle: 'A', toLayer: 'CABINET' },
      { kind: 'set_text', handle: 'A', text: 'y' },
    ]);
    expect(editRequests(edits)[1]).toEqual({
      correction: { kind: 'move_layer', handle: 'A', toLayer: 'CABINET' },
      problem: null,
    });
  });

  it('a window takes what is wholly inside; a crossing box also what it touches', () => {
    const windowBand = { x0: 19, y0: 19, x1: 23, y1: 23 };
    expect(isCrossing(windowBand)).toBe(false);
    expect(entitiesInBand(scene, windowBand, all)).toEqual([2]);
    // Same box dragged to the left: route A (0,0 → 50,25) is touched too.
    const crossing = { x0: 23, y0: 19, x1: 19, y1: 23 };
    expect(isCrossing(crossing)).toBe(true);
    expect(entitiesInBand(scene, crossing, all)).toEqual([0, 2]);
    expect(entitiesInBand(scene, crossing, (index) => index !== 0)).toEqual([2]);
  });

  it('knows texts, and counts an insert of several shapes once', () => {
    expect(isTextEntity(scene, 3)).toBe(true);
    expect(isTextEntity(scene, 2)).toBe(false);
    expect(handlesOf(scene, [0, 2, 2])).toEqual(['A', 'A1']);
  });

  it('draws the unsaved edits over the saved preview without changing it', () => {
    const shown = previewWithEdits(scene, EMPTY_PREVIEW, [
      { kind: 'move_layer', handle: 'B', toLayer: 'Sap' },
      { kind: 'set_text', handle: 'T1', text: '7way 7/3.5' },
      { kind: 'move_layer', handle: 'A', toLayer: 'NOT_IN_VIEW' },
    ]);
    expect(shown.layerOf.get(1)).toBe(1);
    expect(shown.layerOf.has(0)).toBe(false);
    expect(shown.textOf.get(3)).toBe('7way 7/3.5');
    expect(EMPTY_PREVIEW.layerOf.size).toBe(0);
    expect(previewWithEdits(scene, EMPTY_PREVIEW, [])).toBe(EMPTY_PREVIEW);
  });
});

describe('moves and turns in the edit mode (ADR-047)', () => {
  it('keeps every move of a handle (they add up) while a layer edit replaces the earlier', () => {
    const edits = addEdits(moveEdits(['A'], 1, 0), [
      ...moveEdits(['A'], 0, 2),
      { kind: 'move_layer', handle: 'A', toLayer: 'Sap' },
    ]);
    expect(edits.map((edit) => edit.kind)).toEqual(['move_item', 'move_item', 'move_layer']);
    const shown = previewWithEdits(scene, EMPTY_PREVIEW, edits);
    expect(shown.transformOf.get(0)).toEqual([1, 0, 0, 1, 1, 2]);
  });

  it('rounds to micro-units and brings angles into ±180', () => {
    expect(moveEdits(['A'], 1.123456789, -2)).toEqual([
      { kind: 'move_item', handle: 'A', dx: 1.123457, dy: -2 },
    ]);
    expect(rotateEdits(['A', 'B'], 1, 2, 270).map((edit) => edit)).toEqual([
      { kind: 'rotate_item', handle: 'A', x: 1, y: 2, angle: -90 },
      { kind: 'rotate_item', handle: 'B', x: 1, y: 2, angle: -90 },
    ]);
    expect(editRequests(rotateEdits(['A'], 0, 0, 45))[0]?.correction).toEqual({
      kind: 'rotate_item',
      handle: 'A',
      x: 0,
      y: 0,
      angle: 45,
    });
  });

  it('picks a moved item where it is drawn now', () => {
    const moved = new Map([[2, [1, 0, 0, 1, 50, 0] as const]]);
    // A1 (20..22) moved by 50 is inside 69..73, no longer inside 19..23.
    expect(entitiesInBand(scene, { x0: 19, y0: 19, x1: 23, y1: 23 }, all, moved)).toEqual([]);
    expect(entitiesInBand(scene, { x0: 69, y0: 19, x1: 73, y1: 23 }, all, moved)).toEqual([2]);
  });
});
