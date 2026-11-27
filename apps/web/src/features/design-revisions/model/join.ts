import type { Pt } from './object-snap';

/**
 * JOIN, checked on the page before it is kept (round 2, item 25). The build joins open lines of one
 * layer that meet end to end, ends within the route end tolerance (worker `ROUTE_END_TOUCH_M`,
 * 0.05 m); anything else is refused at save. AutoCAD says why at once, so the page does the same
 * check, with the same chain rule as the worker.
 */

export interface JoinPiece {
  handle: string;
  /** The layer name where the piece is drawn now. */
  layer: string;
  points: readonly Pt[];
  closed: boolean;
}

export type JoinProblem = 'closed' | 'layers' | 'chain';

const same = (a: Pt, b: Pt, touch: number) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= touch;

/** null when the pieces are one chain end to end; else why they are not. */
export function joinProblem(pieces: readonly JoinPiece[], touch: number): JoinProblem | null {
  if (pieces.some((p) => p.closed || p.points.length < 2)) return 'closed';
  if (new Set(pieces.map((p) => p.layer)).size > 1) return 'layers';
  const sorted = [...pieces].sort((a, b) =>
    a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0,
  );
  const key = sorted[0];
  if (!key) return 'chain';
  let chain: Pt[] = [...key.points];
  const unused = sorted.slice(1);
  const extend = (atEnd: boolean): boolean | 'many' => {
    const tip = (atEnd ? chain[chain.length - 1] : chain[0]) as Pt;
    const hits: { piece: JoinPiece; startsAtTip: boolean }[] = [];
    for (const piece of unused) {
      const first = piece.points[0] as Pt;
      const last = piece.points[piece.points.length - 1] as Pt;
      if (same(tip, first, touch)) hits.push({ piece, startsAtTip: true });
      if (same(tip, last, touch)) hits.push({ piece, startsAtTip: false });
    }
    if (hits.length === 0) return false;
    if (hits.length > 1) return 'many';
    const { piece, startsAtTip } = hits[0] as (typeof hits)[number];
    unused.splice(unused.indexOf(piece), 1);
    let points = startsAtTip ? [...piece.points] : [...piece.points].reverse();
    const head = points[0] as Pt;
    if (head[0] === tip[0] && head[1] === tip[1]) points = points.slice(1);
    chain = atEnd ? [...chain, ...points] : [...[...points].reverse(), ...chain];
    return true;
  };
  while (unused.length > 0) {
    const grown = extend(true);
    if (grown === 'many') return 'chain';
    if (grown) continue;
    const front = extend(false);
    if (front !== true) return 'chain';
  }
  return null;
}

/**
 * The one polyline a JOIN makes (the worker's `merge_curves` order): from the piece with the
 * smallest handle, each step adds the unused piece whose end is nearest to either tip, turned to
 * start there; a vertex the two pieces share is kept once. The pieces were checked at JOIN.
 */
export function chainPoints(
  pieces: readonly { handle: string; points: readonly (readonly [number, number])[] }[],
): Pt[] {
  const sorted = [...pieces]
    .filter((p) => p.points.length > 0)
    .sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0));
  const key = sorted[0];
  if (!key) return [];
  let chain: Pt[] = key.points.map((p) => [p[0], p[1]] as Pt);
  const unused = sorted.slice(1);
  const gap = (a: readonly [number, number], b: readonly [number, number]) =>
    Math.hypot(a[0] - b[0], a[1] - b[1]);
  while (unused.length > 0) {
    let best = { at: 0, atEnd: true, startsAtTip: true, d: Infinity };
    unused.forEach((piece, at) => {
      const first = piece.points[0] as Pt;
      const last = piece.points[piece.points.length - 1] as Pt;
      for (const atEnd of [true, false]) {
        const tip = (atEnd ? chain[chain.length - 1] : chain[0]) as Pt;
        for (const [startsAtTip, end] of [
          [true, first],
          [false, last],
        ] as const) {
          const d = gap(tip, end);
          if (d < best.d) best = { at, atEnd, startsAtTip, d };
        }
      }
    });
    const [piece] = unused.splice(best.at, 1);
    if (!piece) break;
    const tip = (best.atEnd ? chain[chain.length - 1] : chain[0]) as Pt;
    let points = piece.points.map((p) => [p[0], p[1]] as Pt);
    if (!best.startsAtTip) points.reverse();
    const head = points[0] as Pt;
    if (head[0] === tip[0] && head[1] === tip[1]) points = points.slice(1);
    chain = best.atEnd ? [...chain, ...points] : [...points.reverse(), ...chain];
  }
  return chain;
}
