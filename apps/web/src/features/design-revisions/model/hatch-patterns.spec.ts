import { HATCH_LINE_PATTERNS } from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import type { PreviewShape } from './drawing-preview';
import { shapePass } from './drawing-draw';
import type { Pt } from './geometry';
import {
  familiesOf,
  islandLoops,
  islandsOf,
  loopDepths,
  PATTERN_FAMILIES,
  patternSegments,
} from './hatch-patterns';

const square = (x0: number, y0: number, size: number): Pt[] => [
  [x0, y0],
  [x0 + size, y0],
  [x0 + size, y0 + size],
  [x0, y0 + size],
];
const box = { minX: 0, minY: 0, maxX: 10, maxY: 10 };

describe('hatch patterns (acad.pat)', () => {
  it('every pattern of the contract but SOLID and USER has line families', () => {
    for (const name of HATCH_LINE_PATTERNS) {
      if (name === 'SOLID') expect(familiesOf(name, 1, false)).toEqual([]);
      else expect(familiesOf(name, 1, false).length).toBeGreaterThan(0);
    }
  });
  it('ANSI31 is lines at 45° 3.175 apart; scale spreads them', () => {
    const [family] = PATTERN_FAMILIES.ANSI31;
    expect(family?.angle).toBe(45);
    expect(family?.offset[1]).toBeCloseTo(3.175);
    const one = patternSegments(PATTERN_FAMILIES.ANSI31, {
      angle: 0,
      scale: 1,
      origin: [0, 0],
      box,
    });
    const two = patternSegments(PATTERN_FAMILIES.ANSI31, {
      angle: 0,
      scale: 2,
      origin: [0, 0],
      box,
    });
    expect(one && two && one.length).toBeGreaterThan(two?.length ?? 0);
    for (const s of one ?? []) {
      // Each line runs at 45°.
      expect(Math.abs(s.b[0] - s.a[0] - (s.b[1] - s.a[1]))).toBeLessThan(1e-6);
    }
  });
  it('the hatch angle turns the lines; user-defined spacing and double', () => {
    const lines = patternSegments(familiesOf('USER', 2, false), {
      angle: 0,
      scale: 1,
      origin: [0, 0],
      box,
    });
    expect(lines?.every((s) => s.a[1] === s.b[1])).toBe(true);
    expect(lines?.length).toBe(6); // y = 0, 2, 4, 6, 8, 10
    const turned = patternSegments(familiesOf('USER', 2, false), {
      angle: 90,
      scale: 1,
      origin: [0, 0],
      box,
    });
    expect(turned?.every((s) => Math.abs(s.a[0] - s.b[0]) < 1e-9)).toBe(true);
    expect(familiesOf('USER', 2, true)).toHaveLength(2);
  });
  it('the origin shifts the lines; dashes and dots are cut', () => {
    const shifted = patternSegments(familiesOf('USER', 4, false), {
      angle: 0,
      scale: 1,
      origin: [0, 1],
      box,
    });
    expect(shifted?.map((s) => s.a[1])).toEqual([1, 5, 9]);
    const dots = patternSegments(PATTERN_FAMILIES.DOTS, {
      angle: 0,
      scale: 10,
      origin: [0, 0],
      box,
    });
    expect(dots?.some((s) => s.a[0] === s.b[0] && s.a[1] === s.b[1])).toBe(true);
  });
  it('gives up (null) when too dense to draw', () => {
    expect(
      patternSegments(
        PATTERN_FAMILIES.ANSI31,
        { angle: 0, scale: 0.001, origin: [0, 0], box },
        100,
      ),
    ).toBeNull();
  });
});

describe('island detection', () => {
  const outer = square(0, 0, 100);
  const island = square(20, 20, 40);
  const inner = square(30, 30, 10);
  it('nesting depths', () => {
    expect(loopDepths([outer, island, inner])).toEqual([0, 1, 2]);
  });
  it('Normal keeps every loop (even-odd), Outer the outermost level, Ignore the outer only', () => {
    expect(islandLoops([outer, island, inner], 'normal').loops).toHaveLength(3);
    expect(islandLoops([outer, island, inner], 'outer')).toEqual({
      loops: [outer, island],
      rule: 'evenodd',
    });
    expect(islandLoops([outer, island, inner], 'ignore')).toEqual({
      loops: [outer],
      rule: 'nonzero',
    });
  });
  it('islands of a picked boundary are the loops inside it', () => {
    expect(islandsOf(outer, [outer, island, square(90, 90, 20)])).toEqual([island]);
  });
});

describe('hatch draw order', () => {
  const shape = (patch: Partial<PreviewShape>) =>
    ({ shape: 'hatch', drawOrder: 'behind', ...patch }) as PreviewShape;
  it('behind the boundary and at the back under the drawing; the others on top', () => {
    expect(shapePass(shape({}))).toBe('under');
    expect(shapePass(shape({ drawOrder: 'back' }))).toBe('under');
    expect(shapePass(shape({ drawOrder: 'front' }))).toBe('over');
    expect(shapePass(shape({ drawOrder: 'above' }))).toBe('over');
    expect(shapePass(shape({ drawOrder: 'none' }))).toBe('over');
    expect(shapePass(shape({ shape: 'wipeout' }))).toBe('over');
    expect(shapePass(shape({ shape: 'donut' }))).toBe('under');
  });
});
