import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyToSession,
  GeometryError,
  polylineLength,
  routeFromCoordinates,
  routeToCoordinates,
  sameRoute,
  snap,
  startEditSession,
  toAsBuiltRoute,
  toleranceFromPixels,
  SNAP_TOLERANCE_PX,
  undoEdit,
  type EditOperation,
  type EditSession,
  type Point,
  type Polyline,
} from './index.js';

// Phase 4 (ADR-030): properties of what the phone sends as an As-Built edit. 10,000 runs each,
// like the engine's other properties.
const RUNS = { numRuns: 10_000 };

const coord = (min: number, max: number) =>
  fc.double({ min, max, noNaN: true, noDefaultInfinity: true });
const pointArb: fc.Arbitrary<Point> = fc.record({
  x: coord(200_000, 800_000),
  y: coord(2_400_000, 3_600_000),
});
/** Small steps, sometimes exactly zero, so repeated vertices really occur. */
const stepArb = fc.oneof(
  fc.constant<[number, number]>([0, 0]),
  fc.tuple(coord(-500, 500), coord(-500, 500)),
);
const routeArb: fc.Arbitrary<Polyline> = fc
  .tuple(pointArb, fc.array(stepArb, { minLength: 1, maxLength: 30 }))
  .map(([start, steps]) => {
    const line: Point[] = [start];
    for (const [dx, dy] of steps) {
      const prev = line[line.length - 1] as Point;
      line.push({ x: prev.x + dx, y: prev.y + dy });
    }
    return line;
  });

/** Random grip operations; some target a neighbour's exact position (a snapped drop). */
type RawOp = [
  'moveVertex' | 'moveOntoNeighbour' | 'insertVertex' | 'removeVertex' | 'translate',
  number,
  [number, number],
];
const rawOpArb: fc.Arbitrary<RawOp> = fc.tuple(
  fc.constantFrom('moveVertex', 'moveOntoNeighbour', 'insertVertex', 'removeVertex', 'translate'),
  fc.nat(),
  stepArb,
);

function toOp(line: Polyline, [type, n, [dx, dy]]: RawOp): EditOperation {
  const i = n % line.length;
  const p = line[i] as Point;
  switch (type) {
    case 'moveVertex':
      return { type, vertexIndex: i, to: { x: p.x + dx, y: p.y + dy } };
    case 'moveOntoNeighbour':
      return { type: 'moveVertex', vertexIndex: i, to: line[(i + 1) % line.length] as Point };
    case 'insertVertex':
      return { type, segmentIndex: n % (line.length - 1) };
    case 'removeVertex':
      return { type, vertexIndex: i };
    default:
      return { type: 'translate', dx, dy };
  }
}

function runSession(base: Polyline, raws: RawOp[]): EditSession {
  let session = startEditSession(base);
  for (const raw of raws) {
    try {
      session = applyToSession(session, toOp(session.present, raw));
    } catch (error) {
      // Refused operations (e.g. below two vertices) leave the session unchanged.
      if (!(error instanceof GeometryError)) throw error;
    }
  }
  return session;
}

function closeTo(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)) + 1e-6;
}

const hasRepeatedVertex = (line: Polyline) =>
  line.some((p, i) => i > 0 && p.x === line[i - 1]?.x && p.y === line[i - 1]?.y);

describe('As-Built route properties (ADR-030)', () => {
  it('the route sent after any session has no repeated vertex, ≥ 2 vertices and the same length', () => {
    fc.assert(
      fc.property(routeArb, fc.array(rawOpArb, { maxLength: 25 }), (base, raws) => {
        const { present } = runSession(base, raws);
        let sent: Polyline;
        try {
          sent = toAsBuiltRoute(present);
        } catch (error) {
          // Only a route collapsed onto one point may be refused, and then it has no length.
          return error instanceof GeometryError && polylineLength(present) === 0;
        }
        return (
          sent.length >= 2 &&
          !hasRepeatedVertex(sent) &&
          closeTo(polylineLength(sent), polylineLength(present)) &&
          sameRoute([sent[0] as Point], [present[0] as Point]) &&
          sameRoute([sent[sent.length - 1] as Point], [present[present.length - 1] as Point])
        );
      }),
      RUNS,
    );
  });

  it('normalising is idempotent and keeps vertex order', () => {
    fc.assert(
      fc.property(routeArb, (line) => {
        fc.pre(polylineLength(line) > 0);
        const once = toAsBuiltRoute(line);
        const twice = toAsBuiltRoute(once);
        const kept = once.every((p) => line.includes(p));
        return sameRoute(once, twice) && kept;
      }),
      RUNS,
    );
  });

  it('coordinates survive the trip to the contract and back exactly', () => {
    fc.assert(
      fc.property(routeArb, (line) =>
        sameRoute(routeFromCoordinates(routeToCoordinates(line)), line),
      ),
      RUNS,
    );
  });

  it('undoing a whole session restores the design route, so nothing is sent', () => {
    fc.assert(
      fc.property(routeArb, fc.array(rawOpArb, { maxLength: 25 }), (base, raws) => {
        let session = runSession(base, raws);
        while (session.done.length > 0) session = undoEdit(session);
        return sameRoute(session.present, base);
      }),
      RUNS,
    );
  });

  it('a moved symbol lands on a snap target within 14 px, or exactly where it was dropped', () => {
    fc.assert(
      fc.property(
        pointArb,
        fc.array(pointArb, { maxLength: 10 }),
        fc.double({ min: 0.001, max: 5, noNaN: true }),
        (drop, others, metresPerPixel) => {
          const tolerance = toleranceFromPixels(SNAP_TOLERANCE_PX, metresPerPixel);
          const targets = others.map((at, i) => ({
            kind: 'symbol' as const,
            featureId: `f${i}`,
            at,
          }));
          const hit = snap(drop, targets, tolerance, { exclude: { featureId: 'dragged' } });
          const final = hit?.point ?? drop;
          if (hit === null) return final === drop;
          return hit.distance <= tolerance && others.includes(final) && hit.featureId !== 'dragged';
        },
      ),
      RUNS,
    );
  });
});

describe('toAsBuiltRoute examples', () => {
  it('drops a grip dropped onto its neighbour and refuses a route collapsed to one point', () => {
    const a = { x: 1, y: 1 };
    const b = { x: 4, y: 5 };
    expect(toAsBuiltRoute([a, b, b])).toEqual([a, b]);
    expect(() => toAsBuiltRoute([a, a])).toThrow(GeometryError);
    expect(() => toAsBuiltRoute([a, { x: Number.NaN, y: 0 }])).toThrow(GeometryError);
  });
});
