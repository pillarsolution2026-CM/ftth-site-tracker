import fc from 'fast-check';
import { describe, it } from 'vitest';
import {
  appliedOperations,
  applyEdit,
  applyToSession,
  bulgePoints,
  bulgeSegmentLength,
  createProjectCrs,
  distance,
  distanceToSegment,
  FLATTEN_TOLERANCE_M,
  insertVertex,
  MAX_ARC_SEGMENTS,
  midpoint,
  polylineLength,
  redoEdit,
  removeVertex,
  snap,
  startEditSession,
  translatePolyline,
  undoEdit,
  type EditOperation,
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

/** Length change an operation should cause, from the touched segments only. */
function expectedLengthDelta(line: Polyline, op: EditOperation): number {
  const at = (i: number) => line[i] as Point;
  const segment = (i: number, j: number) =>
    i < 0 || j >= line.length ? 0 : distance(at(i), at(j));
  switch (op.type) {
    case 'moveVertex': {
      const i = op.vertexIndex;
      const before = segment(i - 1, i) + segment(i, i + 1);
      const after =
        (i > 0 ? distance(at(i - 1), op.to) : 0) +
        (i < line.length - 1 ? distance(op.to, at(i + 1)) : 0);
      return after - before;
    }
    case 'insertVertex': {
      const i = op.segmentIndex;
      const p = op.at ?? midpoint(at(i), at(i + 1));
      return distance(at(i), p) + distance(p, at(i + 1)) - segment(i, i + 1);
    }
    case 'removeVertex': {
      const i = op.vertexIndex;
      const bridge = i > 0 && i < line.length - 1 ? distance(at(i - 1), at(i + 1)) : 0;
      return bridge - segment(i - 1, i) - segment(i, i + 1);
    }
    case 'translate':
      return 0;
  }
}

/** Raw random choices, turned into a valid operation for the current route. */
interface RawEdit {
  readonly kind: 'move' | 'insertMid' | 'insertAt' | 'remove' | 'translate';
  readonly n: number;
  readonly dx: number;
  readonly dy: number;
}
const rawEditArb: fc.Arbitrary<RawEdit> = fc.record({
  kind: fc.constantFrom('move', 'insertMid', 'insertAt', 'remove', 'translate'),
  n: fc.nat(),
  dx: nearOffset,
  dy: nearOffset,
});

function toOperation(line: Polyline, raw: RawEdit): EditOperation {
  const vertexIndex = raw.n % line.length;
  const segmentIndex = raw.n % (line.length - 1);
  const p = line[vertexIndex] as Point;
  switch (raw.kind) {
    case 'move':
      return { type: 'moveVertex', vertexIndex, to: { x: p.x + raw.dx, y: p.y + raw.dy } };
    case 'insertMid':
      return { type: 'insertVertex', segmentIndex };
    case 'insertAt':
      return { type: 'insertVertex', segmentIndex, at: { x: p.x + raw.dx, y: p.y + raw.dy } };
    case 'remove':
      return line.length > 2
        ? { type: 'removeVertex', vertexIndex }
        : { type: 'insertVertex', segmentIndex };
    case 'translate':
      return { type: 'translate', dx: raw.dx, dy: raw.dy };
  }
}

function samePolyline(a: Polyline, b: Polyline): boolean {
  return a.length === b.length && a.every((p, i) => p.x === b[i]?.x && p.y === b[i]?.y);
}

describe('edit session properties', () => {
  it('random edits keep lengths non-negative and consistent; undo restores exactly; redo replays', () => {
    fc.assert(
      fc.property(polylineArb(), fc.array(rawEditArb, { maxLength: 25 }), (base, raws) => {
        let session = startEditSession(base);
        const states: Polyline[] = [base];
        for (const raw of raws) {
          const before = session.present;
          const op = toOperation(before, raw);
          session = applyToSession(session, op);
          const length = polylineLength(session.present);
          if (!(length >= 0) || session.present.length < 2) return false;
          if (!closeTo(length, polylineLength(before) + expectedLengthDelta(before, op)))
            return false;
          states.push(session.present);
        }
        const final = session.present;
        const ops = appliedOperations(session);
        if (!samePolyline(ops.reduce(applyEdit, base), final)) return false;

        for (let i = raws.length - 1; i >= 0; i--) {
          session = undoEdit(session);
          if (session.present !== states[i]) return false;
        }
        if (session.present !== base || appliedOperations(session).length !== 0) return false;

        for (let i = 1; i <= raws.length; i++) session = redoEdit(session);
        return (
          samePolyline(session.present, final) && appliedOperations(session).length === ops.length
        );
      }),
      RUNS,
    );
  });
});

describe('measure properties', () => {
  it('distance to a segment is non-negative, symmetric and never more than to either end', () => {
    fc.assert(
      fc.property(pointArb, pointArb, pointArb, (p, a, b) => {
        const d = distanceToSegment(p, a, b);
        return (
          d >= 0 &&
          d <= Math.min(distance(p, a), distance(p, b)) + 1e-9 &&
          closeTo(d, distanceToSegment(p, b, a))
        );
      }),
      RUNS,
    );
  });
});

describe('flatten properties', () => {
  const shortOffset = coord(-500, 500);
  const bulgeArb = fc
    .tuple(fc.double({ min: 0.01, max: 5, noNaN: true }), fc.boolean())
    .map(([magnitude, clockwise]) => (clockwise ? -magnitude : magnitude));

  it('bulge points lie on the arc and chords stay within the tolerance', () => {
    fc.assert(
      fc.property(pointArb, shortOffset, shortOffset, bulgeArb, (a, dx, dy, bulge) => {
        const b = { x: a.x + dx, y: a.y + dy };
        const chord = distance(a, b);
        fc.pre(chord > 0.01);
        // Centre derived independently of the implementation: rotate the chord direction by
        // ±90° − sweep/2 (towards the left for a counter-clockwise arc).
        const sweep = 4 * Math.atan(bulge);
        const radius = chord / (2 * Math.sin(Math.abs(sweep) / 2));
        const angle = Math.atan2(dy, dx) + Math.sign(sweep) * (Math.PI / 2) - sweep / 2;
        const center = { x: a.x + radius * Math.cos(angle), y: a.y + radius * Math.sin(angle) };

        const points = bulgePoints(a, b, bulge);
        if (points[0] !== a || points[points.length - 1] !== b) return false;
        const eps = 1e-6 + 1e-9 * radius;
        if (!points.every((p) => Math.abs(distance(p, center) - radius) <= eps)) return false;
        if (points.length - 1 < MAX_ARC_SEGMENTS) {
          for (let i = 1; i < points.length; i++) {
            const sagitta =
              radius - distance(midpoint(points[i - 1] as Point, points[i] as Point), center);
            if (sagitta > FLATTEN_TOLERANCE_M + eps) return false;
          }
        }
        const flattened = polylineLength(points);
        const exact = bulgeSegmentLength(a, b, bulge);
        return flattened <= exact + eps && flattened >= chord - eps;
      }),
      RUNS,
    );
  });
});

describe('CRS properties', () => {
  const crs = createProjectCrs(32636);

  it('project → WGS84 → project round-trips within a millimetre', () => {
    fc.assert(
      fc.property(
        fc.record({ x: coord(200_000, 800_000), y: coord(2_400_000, 3_600_000) }),
        (p) => {
          const back = crs.fromWgs84(crs.toWgs84(p));
          return Math.abs(back.x - p.x) < 0.001 && Math.abs(back.y - p.y) < 0.001;
        },
      ),
      RUNS,
    );
  });
});
