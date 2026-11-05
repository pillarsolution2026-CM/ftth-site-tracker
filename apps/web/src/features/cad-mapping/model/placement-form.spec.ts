import { adjustSimilarity, applySimilarity, type Point } from '@ftth/geo';
import type { ControlPoint, PlacementAdjust } from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import { mappingView } from './mapping-fixtures';
import {
  NEUTRAL_ADJUST,
  angleBetween,
  initialPlacementState,
  moveAdjust,
  nextPointId,
  scaleBetween,
  solveState,
  toPlacement,
  turnAdjust,
} from './placement-form';

const EPSG = 32636;
const point = (over: Partial<ControlPoint> = {}): ControlPoint => ({
  id: 'P1',
  drawing: { x: 7284.2708, y: 4091.7164 },
  handle: 'C1',
  label: '1-7',
  lat: 30.984506906326853,
  lon: 32.78324905782938,
  source: 'kml',
  excluded: false,
  ...over,
});
const apply = (adjust: PlacementAdjust, p: Point) => applySimilarity(adjustSimilarity(adjust), p);

describe('toPlacement', () => {
  it('is null as drawn, and the placement once anything is set', () => {
    const state = initialPlacementState(mappingView());
    expect(toPlacement(state)).toBeNull();
    expect(toPlacement({ ...state, sourceCrs: 'egypt_red_belt' })?.sourceCrs).toBe(
      'egypt_red_belt',
    );
    expect(toPlacement({ ...state, adjust: moveAdjust(NEUTRAL_ADJUST, 1, 0) })?.adjust.dx).toBe(1);
  });
});

describe('solveState', () => {
  it('lands the one Rabaa point (cabinet 1-7) on its Lat/Lon', () => {
    const state = { ...initialPlacementState(mappingView()), points: [point()] };
    const solved = solveState(state, EPSG, 1);
    expect(solved.ok).toBe(true);
    if (solved.ok) expect(solved.solution.residuals[0]?.errorM).toBeLessThan(1e-6);
  });

  it('reports two points on one drawing spot instead of throwing', () => {
    const state = {
      ...initialPlacementState(mappingView()),
      points: [point(), point({ id: 'P2', lat: 30.99 })],
    };
    expect(solveState(state, EPSG, 1)).toEqual({ ok: false, error: 'degenerate' });
  });
});

describe('hand tools', () => {
  const P = { x: 330000, y: 3330000 };
  const samples: Point[] = [
    { x: 329900, y: 3329950 },
    { x: 330120, y: 3330080 },
  ];

  it('Move shifts every point by the same metres', () => {
    const moved = moveAdjust(NEUTRAL_ADJUST, 2.5, -1);
    for (const p of samples) expect(apply(moved, p)).toEqual({ x: p.x + 2.5, y: p.y - 1 });
  });

  it('Rotate / Scale turn the placed drawing about the pivot, on top of an earlier adjustment', () => {
    const earlier = turnAdjust(moveAdjust(NEUTRAL_ADJUST, 3, 4), { x: 329000, y: 3329000 }, 10, 1);
    const turned = turnAdjust(earlier, P, 30, 1.5);
    const t = (30 * Math.PI) / 180;
    for (const p of samples) {
      const before = apply(earlier, p);
      const expected = {
        x: P.x + 1.5 * (Math.cos(t) * (before.x - P.x) - Math.sin(t) * (before.y - P.y)),
        y: P.y + 1.5 * (Math.sin(t) * (before.x - P.x) + Math.cos(t) * (before.y - P.y)),
      };
      const after = apply(turned, p);
      // Rounded to the millimetre like the stored adjustment.
      expect(after.x).toBeCloseTo(expected.x, 2);
      expect(after.y).toBeCloseTo(expected.y, 2);
    }
    expect(turned.rotationDeg).toBeCloseTo(40, 6);
    expect(turned.scale).toBeCloseTo(1.5, 6);
  });

  it('keeps rotation within ±180° and scale within the contract limits', () => {
    expect(
      turnAdjust({ ...NEUTRAL_ADJUST, rotationDeg: 170, pivot: P }, P, 20, 1).rotationDeg,
    ).toBe(-170);
    expect(turnAdjust(NEUTRAL_ADJUST, P, 0, 10).scale).toBe(2);
    expect(turnAdjust(NEUTRAL_ADJUST, P, 0, 0.01).scale).toBe(0.5);
  });

  it('reads a drag as an angle and a ratio about the pivot', () => {
    const o = { x: 0, y: 0 };
    expect(angleBetween(o, { x: 1, y: 0 }, { x: 0, y: 2 })).toBeCloseTo(90);
    expect(scaleBetween(o, { x: 1, y: 0 }, { x: 0, y: 2 })).toBe(2);
    expect(scaleBetween(o, o, { x: 1, y: 1 })).toBe(1);
  });
});

describe('nextPointId', () => {
  it('takes the first free P number', () => {
    expect(nextPointId([])).toBe('P1');
    expect(nextPointId([point({ id: 'P1' }), point({ id: 'P3' })])).toBe('P2');
  });
});
