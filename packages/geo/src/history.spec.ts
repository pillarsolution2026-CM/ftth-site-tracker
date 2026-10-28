import { describe, expect, it } from 'vitest';
import {
  appliedOperations,
  applyEdit,
  applyToSession,
  canRedo,
  canUndo,
  GeometryError,
  redoEdit,
  startEditSession,
  undoEdit,
  type EditOperation,
  type Polyline,
} from './index.js';

const base: Polyline = [
  { x: 331_000, y: 3_342_000 },
  { x: 331_030, y: 3_342_040 },
  { x: 331_030, y: 3_342_100 },
];

describe('applyEdit', () => {
  it('applies every operation type', () => {
    expect(applyEdit(base, { type: 'moveVertex', vertexIndex: 0, to: { x: 1, y: 2 } })[0]).toEqual({
      x: 1,
      y: 2,
    });
    expect(applyEdit(base, { type: 'insertVertex', segmentIndex: 1 })).toHaveLength(4);
    expect(applyEdit(base, { type: 'removeVertex', vertexIndex: 1 })).toHaveLength(2);
    expect(applyEdit(base, { type: 'translate', dx: 1, dy: 1 })[2]).toEqual({
      x: 331_031,
      y: 3_342_101,
    });
  });
});

describe('edit session', () => {
  const ops: EditOperation[] = [
    { type: 'insertVertex', segmentIndex: 0 },
    { type: 'translate', dx: 0.1, dy: -0.2 },
    { type: 'removeVertex', vertexIndex: 2 },
  ];

  it('undoes to the exact previous route and redoes the same operations', () => {
    let s = startEditSession(base);
    expect(canUndo(s)).toBe(false);
    expect(undoEdit(s)).toBe(s);
    expect(redoEdit(s)).toBe(s);

    const states: Polyline[] = [s.present];
    for (const op of ops) {
      s = applyToSession(s, op);
      states.push(s.present);
    }
    expect(appliedOperations(s)).toEqual(ops);

    for (let i = ops.length - 1; i >= 0; i--) {
      s = undoEdit(s);
      expect(s.present).toBe(states[i]);
    }
    expect(s.present).toBe(base);
    expect(canRedo(s)).toBe(true);

    for (let i = 1; i <= ops.length; i++) {
      s = redoEdit(s);
      expect(s.present).toEqual(states[i]);
    }
    expect(appliedOperations(s)).toEqual(ops);
  });

  it('drops the redo branch on a new edit', () => {
    const s = undoEdit(applyToSession(startEditSession(base), ops[0] as EditOperation));
    const branched = applyToSession(s, { type: 'translate', dx: 1, dy: 0 });
    expect(canRedo(branched)).toBe(false);
    expect(appliedOperations(branched)).toEqual([{ type: 'translate', dx: 1, dy: 0 }]);
  });

  it('rejects an invalid operation and leaves the session usable', () => {
    const s = startEditSession([base[0], base[1]] as Polyline);
    expect(() => applyToSession(s, { type: 'removeVertex', vertexIndex: 0 })).toThrow(
      GeometryError,
    );
    expect(s.present).toHaveLength(2);
  });
});
