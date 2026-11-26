import { describe, expect, it } from 'vitest';
import { CreateDrawingCorrectionRequestSchema } from './drawing-corrections.schemas.js';
import {
  addedItemKinds,
  correctionTargets,
  dependantsOf,
  resolveNewHandles,
  type DrawingItemKind,
} from './drawing-item-handles.js';
import type { DrawingCorrectionInput } from './drawing-corrections.schemas.js';

const line: DrawingCorrectionInput = {
  kind: 'add_curve',
  layer: 'ROUTE',
  points: [
    [0, 0],
    [10, 0],
  ],
  closed: false,
};
const move = (handle: string): DrawingCorrectionInput => ({
  kind: 'move_item',
  handle,
  dx: 1,
  dy: 2,
});
const none = (): DrawingItemKind | null => null;

describe('drawing item handles (ADR-061)', () => {
  it('a screen-only item may be moved but not have its layer moved', () => {
    expect(correctionTargets(move('FIX-a')).kinds).toContain('screen');
    expect(
      correctionTargets({ kind: 'move_layer', handle: 'FIX-a', toLayer: 'X' }).kinds,
    ).not.toContain('screen');
  });

  it('lists added items alive after the corrections, a copy takes its source kind', () => {
    const kinds = addedItemKinds(
      [
        { id: 'a', correction: line },
        {
          id: 'b',
          correction: { kind: 'copy_item', handle: 'FIX-a', dx: 5, dy: 0, toLayer: null },
        },
        { id: 'c', correction: { kind: 'copy_item', handle: 'T1', dx: 5, dy: 0, toLayer: null } },
        { id: 'd', correction: { kind: 'erase_item', handle: 'FIX-a' } },
      ],
      (h) => (h === 'T1' ? 'text' : null),
    );
    expect([...kinds]).toEqual([
      ['FIX-b', 'curve'],
      ['FIX-c', 'text'],
    ]);
  });

  it('finds dependants through chains of copies and edits', () => {
    const inForce = [
      { id: 'a', correction: line },
      { id: 'b', correction: move('FIX-a') },
      { id: 'c', correction: { kind: 'copy_item', handle: 'FIX-a', dx: 1, dy: 0, toLayer: null } },
      { id: 'd', correction: move('FIX-c') },
      { id: 'e', correction: move('H1') },
    ] as const;
    expect(dependantsOf('a', inForce)).toEqual(['b', 'c', 'd']);
    expect(dependantsOf('c', inForce)).toEqual(['d']);
    expect(dependantsOf('e', inForce)).toEqual([]);
    expect(addedItemKinds([...inForce], none).size).toBe(2);
  });

  it('rewrites NEW-<ref> to FIX-<id> of an earlier request of the batch', () => {
    const items = [
      CreateDrawingCorrectionRequestSchema.parse({ correction: line, ref: 'p1' }),
      CreateDrawingCorrectionRequestSchema.parse({ correction: move('NEW-p1') }),
      CreateDrawingCorrectionRequestSchema.parse({
        correction: { kind: 'set_group', name: 'g', handles: ['NEW-p1', 'H2'] },
      }),
    ];
    const out = resolveNewHandles(items, ['id1', 'id2', 'id3']);
    expect(out).toEqual({
      corrections: [
        line,
        move('FIX-id1'),
        { kind: 'set_group', name: 'g', handles: ['FIX-id1', 'H2'], block: false },
      ],
    });
  });

  it('refuses a NEW- handle of a later request, an unknown or a duplicate ref', () => {
    const later = [
      CreateDrawingCorrectionRequestSchema.parse({ correction: move('NEW-p1') }),
      CreateDrawingCorrectionRequestSchema.parse({ correction: line, ref: 'p1' }),
    ];
    expect(resolveNewHandles(later, ['1', '2'])).toEqual({ unknown: ['NEW-p1'] });
    const dup = [
      CreateDrawingCorrectionRequestSchema.parse({ correction: line, ref: 'p1' }),
      CreateDrawingCorrectionRequestSchema.parse({ correction: line, ref: 'p1' }),
    ];
    expect(resolveNewHandles(dup, ['1', '2'])).toEqual({ unknown: ['NEW-p1'] });
  });

  it('refuses a malformed ref', () => {
    expect(
      CreateDrawingCorrectionRequestSchema.safeParse({ correction: line, ref: 'a b' }).success,
    ).toBe(false);
  });
});
