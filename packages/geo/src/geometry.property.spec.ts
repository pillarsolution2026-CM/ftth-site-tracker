import fc from 'fast-check';
import { describe, it } from 'vitest';
import {
  distance,
  insertVertex,
  moveVertex,
  polylineLength,
  record,
  removeVertex,
  snap,
  startHistory,
  translatePolyline,
  undo,
  type Point,
  type Polyline,
  type SnapTarget,
} from './index.js';

// Plan acceptance: zero failures over 10,000 runs.
const RUNS = { numRuns: 10_000 };

// UTM-scale coordinates (Egypt, zone 36N) so float error is what production sees.
const coord = (min: number, max: number) =>
  fc.double({ min, max, noNaN: true, noDefaultInfinity: true });
const pointArb: fc.Arbitrary<Point> = fc.record({
  x: coord(200_000, 800_000),
  y: coord(2_400_000, 3_600_000),
});
const nearOffset = coord(-5_000, 5_000);
const polylineArb = (minLength = 2): fc.Arbitrary<Polyline> =>
  fc
    .tuple(
      pointArb,
      fc.array(fc.tuple(nearOffset, nearOffset), { minLength: minLength - 1, maxLength: 40 }),
    )
    .map(([start, steps]) => {
      const line: Point[] = [start];
      for (const [dx, dy] of steps) {
        const prev = line[line.length - 1] as Point;
        line.push({ x: prev.x + dx, y: prev.y + dy });
      }
      return line;
    });

/** Float tolerance proportional to magnitude: 1e-9 relative, i.e. ≤ 0.2 mm on a 200 km route. */
function closeTo(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)) + 1e-6;
}

describe('geometry properties', () => {
  it('length is always finite and non-negative', () => {
    fc.assert(
      fc.property(polylineArb(), (line) => {
        const length = polylineLength(line);
        return Number.isFinite(length) && length >= 0;
      }),
      RUNS,
    );
  });

  it('length is at least the straight distance between the ends', () => {
    fc.assert(
      fc.property(polylineArb(), (line) => {
        const chord = distance(line[0] as Point, line[line.length - 1] as Point);
        return polylineLength(line) >= chord - 1e-6;
      }),
      RUNS,
    );
  });

  it('length does not depend on direction or position', () => {
    fc.assert(
      fc.property(polylineArb(), nearOffset, nearOffset, (line, dx, dy) => {
        const length = polylineLength(line);
        return (
          closeTo(polylineLength([...line].reverse()), length) &&
          closeTo(polylineLength(translatePolyline(line, dx, dy)), length)
        );
      }),
      RUNS,
    );
  });

  it('inserting a vertex at a segment midpoint keeps the length', () => {
    fc.assert(
      fc.property(polylineArb(), fc.nat(), (line, n) => {
        const segment = n % (line.length - 1);
        return closeTo(polylineLength(insertVertex(line, segment)), polylineLength(line));
      }),
      RUNS,
    );
  });

  it('inserting a vertex anywhere never shortens the route', () => {
    fc.assert(
      fc.property(polylineArb(), fc.nat(), pointArb, (line, n, at) => {
        const segment = n % (line.length - 1);
        return polylineLength(insertVertex(line, segment, at)) >= polylineLength(line) - 1e-6;
      }),
      RUNS,
    );
  });

  it('removing a vertex never lengthens the route', () => {
    fc.assert(
      fc.property(polylineArb(3), fc.nat(), (line, n) => {
        const index = n % line.length;
        const shorter = removeVertex(line, index);
        return (
          shorter.length === line.length - 1 &&
          polylineLength(shorter) <= polylineLength(line) + 1e-6
        );
      }),
      RUNS,
    );
  });

  it('a random sequence of edits keeps a valid route with a consistent length', () => {
    const edit = fc.oneof(
      fc.record({ op: fc.constant('move' as const), n: fc.nat(), dx: nearOffset, dy: nearOffset }),
      fc.record({ op: fc.constant('insert' as const), n: fc.nat() }),
      fc.record({ op: fc.constant('remove' as const), n: fc.nat() }),
    );
    fc.assert(
      fc.property(polylineArb(), fc.array(edit, { maxLength: 30 }), (start, edits) => {
        let history = startHistory(start);
        for (const e of edits) {
          const line = history.present;
          if (e.op === 'move') {
            const i = e.n % line.length;
            const p = line[i] as Point;
            history = record(history, moveVertex(line, i, { x: p.x + e.dx, y: p.y + e.dy }));
          } else if (e.op === 'insert') {
            history = record(history, insertVertex(line, e.n % (line.length - 1)));
          } else if (line.length > 2) {
            history = record(history, removeVertex(line, e.n % line.length));
          }
          const length = polylineLength(history.present);
          if (history.present.length < 2 || !(length >= 0)) return false;
        }
        // Unlimited undo walks all the way back to the original route.
        for (let i = 0; i < edits.length; i++) history = undo(history);
        return history.present === start;
      }),
      { numRuns: 2_000 },
    );
  });

  it('snap returns the nearest candidate within tolerance, or null when none is', () => {
    const targetsArb = fc.array(
      fc.oneof(
        pointArb.map((at): SnapTarget => ({ featureId: 's', kind: 'symbol', at })),
        polylineArb().map((vertices): SnapTarget => ({ featureId: 'r', kind: 'route', vertices })),
      ),
      { maxLength: 8 },
    );
    fc.assert(
      fc.property(pointArb, targetsArb, coord(0, 50_000), (cursor, targets, tolerance) => {
        const all = targets.flatMap((t) => (t.kind === 'symbol' ? [t.at] : [...t.vertices]));
        const nearest = Math.min(...all.map((p) => distance(cursor, p)));
        const result = snap(cursor, targets, tolerance);
        if (result === null) return !(nearest <= tolerance);
        return result.distance <= tolerance && result.distance === nearest;
      }),
      RUNS,
    );
  });
});
