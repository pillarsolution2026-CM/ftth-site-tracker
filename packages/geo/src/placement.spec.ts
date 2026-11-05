import { describe, expect, it } from 'vitest';
import { createProjectCrs } from './crs.js';
import {
  adjustSimilarity,
  applySimilarity,
  solvePlacement,
  sourceToProject,
  type PlacementInput,
} from './placement.js';

const NEUTRAL = { dx: 0, dy: 0, rotationDeg: 0, scale: 1, pivot: null };
const base = (over: Partial<PlacementInput> = {}): PlacementInput => ({
  projectEpsg: 32636,
  metresPerUnit: 1,
  sourceCrs: 'project',
  points: [],
  fitScaleWithTwoPoints: false,
  adjust: NEUTRAL,
  ...over,
});

// Rabaa (ADR-035): cabinet 1-7 drawn at (7284.27, 4091.68) on a local drawing; its KMZ point.
const CAB_1_7 = { x: 7284.2708, y: 4091.7164 };
const CAB_1_7_LL = { lat: 30.984506906326853, lon: 32.78324905782938 };

describe('solvePlacement', () => {
  it('with no point leaves the drawing as drawn', () => {
    const s = solvePlacement(base());
    expect(s.toProject({ x: 10, y: 20 })).toEqual({ x: 10, y: 20 });
    expect(s.pointsUsed).toBe(0);
  });

  it('one point only moves the drawing (Rabaa cabinet 1-7 from its KMZ point)', () => {
    const s = solvePlacement(
      base({ points: [{ id: 'c', drawing: CAB_1_7, ...CAB_1_7_LL, excluded: false }] }),
    );
    const p = s.toProject(CAB_1_7);
    expect(p.x).toBeCloseTo(479304.27, 1);
    expect(p.y).toBeCloseTo(3427905.06, 1);
    expect(s.scale).toBe(1);
    expect(s.rotationDeg).toBe(0);
    expect(s.residuals[0]?.errorM).toBeLessThan(1e-6);
  });

  it('two points recover a rotation and keep scale 1 unless asked', () => {
    const turned = (p: { x: number; y: number }) => ({ x: 479000 - p.y, y: 3427000 + p.x });
    const a = { x: 0, y: 0 };
    const b = { x: 100, y: 0 };
    const ll = (p: { x: number; y: number }) => toLonLat(turned(p));
    const s = solvePlacement(
      base({
        points: [
          { id: 'a', drawing: a, ...ll(a), excluded: false },
          { id: 'b', drawing: b, ...ll(b), excluded: false },
        ],
      }),
    );
    expect(s.rotationDeg).toBeCloseTo(90, 6);
    expect(s.scale).toBe(1);
    const q = s.toProject({ x: 50, y: 0 });
    expect(q.x).toBeCloseTo(479000, 3);
    expect(q.y).toBeCloseTo(3427050, 3);
  });

  it('three or more points fit scale, show each error and flag an outlier', () => {
    const at = (x: number, y: number) =>
      toLonLat({ x: 479000 + 1.002 * x, y: 3427000 + 1.002 * y });
    const pts = [
      { id: 'p1', drawing: { x: 0, y: 0 }, ...at(0, 0), excluded: false },
      { id: 'p2', drawing: { x: 1000, y: 0 }, ...at(1000, 0), excluded: false },
      { id: 'p3', drawing: { x: 0, y: 1000 }, ...at(0, 1000), excluded: false },
      { id: 'p4', drawing: { x: 1000, y: 1000 }, ...at(1000, 1000), excluded: false },
      // 200 m off, like Rabaa's 04F placemark
      { id: 'far', drawing: { x: 500, y: 500 }, ...at(700, 500), excluded: false },
    ];
    const s = solvePlacement(base({ points: pts }));
    expect(s.residuals.find((r) => r.id === 'far')?.outlier).toBe(true);
    const clean = solvePlacement(
      base({ points: pts.map((p) => ({ ...p, excluded: p.id === 'far' })) }),
    );
    expect(clean.scale).toBeCloseTo(1.002, 5);
    expect(clean.scaleWarning).toBe(true);
    expect(
      Math.max(...clean.residuals.filter((r) => !r.excluded).map((r) => r.errorM)),
    ).toBeLessThan(0.01);
    expect(clean.residuals.find((r) => r.id === 'far')?.errorM).toBeGreaterThan(150);
  });

  it('a hand adjustment turns about its pivot, then moves', () => {
    const adj = adjustSimilarity({
      dx: 5,
      dy: -2,
      rotationDeg: 90,
      scale: 1,
      pivot: { x: 10, y: 10 },
    });
    const p = applySimilarity(adj, { x: 20, y: 10 });
    expect(p.x).toBeCloseTo(15, 9);
    expect(p.y).toBeCloseTo(18, 9);
    expect(() => adjustSimilarity({ ...NEUTRAL, scale: 1.1 })).toThrow(/pivot/);
  });
});

describe('sourceToProject', () => {
  it('converts Egypt Red Belt with the general datum shift (same values as the worker)', () => {
    const f = sourceToProject('egypt_red_belt', 32636, 1);
    const origin = f({ x: 615000, y: 810000 });
    expect(origin.x).toBeCloseTo(307246.448, 1);
    expect(origin.y).toBeCloseTo(3320485.069, 1);
    const palmPlaza = f({ x: 877657, y: 937648 });
    expect(palmPlaza.x).toBeCloseTo(571977.79, 1);
    expect(palmPlaza.y).toBeCloseTo(3443379.759, 1);
  });
});

function toLonLat(p: { x: number; y: number }): { lat: number; lon: number } {
  const ll = createProjectCrs(32636).toWgs84(p);
  return { lat: ll.lat, lon: ll.lon };
}
