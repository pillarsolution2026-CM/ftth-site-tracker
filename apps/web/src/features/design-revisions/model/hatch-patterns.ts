import type { HatchDrawOrder, HatchIslandStyle, HatchLinePattern } from '@ftth/shared';
import { insidePolygon } from './draw-shapes';
import type { Pt } from './geometry';

/**
 * AutoCAD's hatch patterns the screen draws (ADR-055 part 8), pure. Each pattern is AutoCAD's
 * line families (acad.pat: angle, origin, offset, dashes) in drawing units at scale 1 (inches of
 * acad.pat × 25.4, as acadiso.pat), turned by the hatch angle and scaled by its scale about the
 * hatch origin (0,0 unless set).
 */

/** One family: lines at `angle`°, through `origin`, the next line shifted by `offset` (along the
 * line, across it); `dashes` > 0 pen down, < 0 gap, 0 a dot; empty = a continuous line. */
export interface PatternFamily {
  angle: number;
  origin: Pt;
  offset: Pt;
  dashes: readonly number[];
}

/** The HATCH fields of `add_shape` at AutoCAD's defaults (a shape that is not a hatch keeps them). */
export const HATCH_FIELD_DEFAULTS = {
  loops: [] as [number, number][][],
  island: 'normal',
  background: null,
  transparency: 0,
  origin: null,
  double: false,
  drawOrder: 'behind',
} as const satisfies {
  loops: [number, number][][];
  island: HatchIslandStyle;
  background: string | null;
  transparency: number;
  origin: [number, number] | null;
  double: boolean;
  drawOrder: HatchDrawOrder;
};

const IN = 25.4;
const f = (angle: number, ox: number, oy: number, dx: number, dy: number, ...dashes: number[]) =>
  ({
    angle,
    origin: [ox * IN, oy * IN],
    offset: [dx * IN, dy * IN],
    dashes: dashes.map((d) => d * IN),
  }) satisfies PatternFamily;

/** acad.pat definitions (the patterns the screen offers; SOLID and USER are drawn apart). */
export const PATTERN_FAMILIES: Readonly<
  Record<Exclude<HatchLinePattern, 'SOLID' | 'USER'>, readonly PatternFamily[]>
> = {
  ANGLE: [f(0, 0, 0, 0, 0.275, 0.2, -0.075), f(90, 0, 0, 0, 0.275, 0.2, -0.075)],
  ANSI31: [f(45, 0, 0, 0, 0.125)],
  ANSI32: [f(45, 0, 0, 0, 0.375), f(45, 0.176776695, 0, 0, 0.375)],
  ANSI33: [f(45, 0, 0, 0, 0.25), f(45, 0.176776695, 0, 0, 0.25, 0.125, -0.0625)],
  ANSI34: [
    f(45, 0, 0, 0, 0.75),
    f(45, 0.176776695, 0, 0, 0.75),
    f(45, 0.353553391, 0, 0, 0.75),
    f(45, 0.530330086, 0, 0, 0.75),
  ],
  ANSI35: [f(45, 0, 0, 0, 0.25), f(45, 0.176776695, 0, 0, 0.25, 0.3125, -0.0625, 0, -0.0625)],
  ANSI36: [f(45, 0, 0, 0.21875, 0.125, 0.3125, -0.0625, 0, -0.0625)],
  ANSI37: [f(45, 0, 0, 0, 0.125), f(135, 0, 0, 0, 0.125)],
  ANSI38: [f(45, 0, 0, 0, 0.125), f(135, 0, 0, 0.25, 0.125, 0.3125, -0.1875)],
  'AR-B816': [f(0, 0, 0, 0, 8), f(90, 0, 0, 8, 8, 8, -8)],
  'AR-B88': [f(0, 0, 0, 0, 8), f(90, 0, 0, 8, 4, 8, -8)],
  'AR-BRSTD': [f(0, 0, 0, 0, 2.667), f(90, 0, 0, 2.667, 4, 2.667, -2.667)],
  'AR-HBONE': [f(45, 0, 0, 4, 4, 12, -4), f(135, 2.828427125, 2.828427125, 4, -4, 12, -4)],
  BRICK: [f(0, 0, 0, 0, 0.25), f(90, 0, 0, 0.25, 0.25, 0.25, -0.25)],
  CROSS: [f(0, 0, 0, 0.25, 0.25, 0.125, -0.375), f(90, 0.0625, -0.0625, 0.25, 0.25, 0.125, -0.375)],
  DASH: [f(0, 0, 0, 0.125, 0.125, 0.125, -0.125)],
  DOTS: [f(0, 0, 0, 0.03125, 0.0625, 0, -0.0625)],
  EARTH: [
    f(0, 0, 0, 0.25, 0.25, 0.25, -0.25),
    f(0, 0, 0.09375, 0.25, 0.25, 0.25, -0.25),
    f(0, 0, 0.1875, 0.25, 0.25, 0.25, -0.25),
    f(90, 0.03125, 0.21875, 0.25, 0.25, 0.25, -0.25),
    f(90, 0.125, 0.21875, 0.25, 0.25, 0.25, -0.25),
    f(90, 0.21875, 0.21875, 0.25, 0.25, 0.25, -0.25),
  ],
  GRASS: [
    f(90, 0, 0, 0.707106781, 0.707106781, 0.1875, -1.226713563),
    f(45, 0, 0, 0, 1, 0.1875, -0.8125),
    f(135, 0, 0, 0, 1, 0.1875, -0.8125),
  ],
  HEX: [
    f(0, 0, 0, 0, 0.216506351, 0.125, -0.25),
    f(120, 0, 0, 0, 0.216506351, 0.125, -0.25),
    f(60, 0.125, 0, 0, 0.216506351, 0.125, -0.25),
  ],
  HONEY: [
    f(0, 0, 0, 0.1875, 0.108253175, 0.125, -0.25),
    f(120, 0, 0, 0.1875, 0.108253175, 0.125, -0.25),
    f(60, 0, 0, 0.1875, 0.108253175, -0.25, 0.125),
  ],
  LINE: [f(0, 0, 0, 0, 0.125)],
  NET: [f(0, 0, 0, 0, 0.125), f(90, 0, 0, 0, 0.125)],
  NET3: [f(0, 0, 0, 0, 0.125), f(60, 0, 0, 0, 0.125), f(120, 0, 0, 0, 0.125)],
  SQUARE: [f(0, 0, 0, 0, 0.125, 0.125, -0.125), f(90, 0, 0, 0, 0.125, 0.125, -0.125)],
  STARS: [
    f(0, 0, 0, 0, 0.216506351, 0.125, -0.125),
    f(60, 0, 0, 0, 0.216506351, 0.125, -0.125),
    f(120, 0.0625, 0.108253175, 0, 0.216506351, 0.125, -0.125),
  ],
  TRIANG: [
    f(60, 0, 0, 0.1875, 0.324759526, 0.1875, -0.1875),
    f(120, 0, 0, 0.1875, 0.324759526, 0.1875, -0.1875),
    f(0, -0.09375, 0.162379763, 0.1875, 0.324759526, 0.1875, -0.1875),
  ],
  ZIGZAG: [f(0, 0, 0, 0.125, 0.125, 0.125, -0.125), f(90, 0.125, 0, 0.125, 0.125, 0.125, -0.125)],
};

/** AutoCAD's user-defined pattern: lines `spacing` apart (and the same at 90° when double). */
export function userFamilies(spacing: number, double: boolean): PatternFamily[] {
  const line = (angle: number): PatternFamily => ({
    angle,
    origin: [0, 0],
    offset: [0, spacing],
    dashes: [],
  });
  return double ? [line(0), line(90)] : [line(0)];
}

/** The families of a pattern (none for SOLID). For USER, `scale` is the spacing. */
export function familiesOf(pattern: HatchLinePattern, scale: number, double: boolean) {
  if (pattern === 'SOLID') return [];
  if (pattern === 'USER') return userFamilies(scale, double);
  return PATTERN_FAMILIES[pattern];
}

/** Smallest distance between two lines of a family (to skip patterns too fine to draw). */
export function familyGap(family: PatternFamily): number {
  return Math.abs(family.offset[1]);
}

export interface Segment {
  a: Pt;
  b: Pt;
}

/**
 * The pattern's strokes over `box` (drawing units), before clipping to the boundary: each family
 * turned by `angle`° and scaled by `scale` about `origin`. Dots are segments of length 0. Stops at
 * `max` segments and returns null (too dense to draw: shown as a light fill instead).
 */
export function patternSegments(
  families: readonly PatternFamily[],
  options: {
    angle: number;
    scale: number;
    origin: Pt;
    box: { minX: number; minY: number; maxX: number; maxY: number };
  },
  max = 40_000,
): Segment[] | null {
  const { angle, scale, origin, box } = options;
  const out: Segment[] = [];
  const corners: Pt[] = [
    [box.minX, box.minY],
    [box.maxX, box.minY],
    [box.maxX, box.maxY],
    [box.minX, box.maxY],
  ];
  for (const family of families) {
    const a = ((family.angle + angle) * Math.PI) / 180;
    const u: Pt = [Math.cos(a), Math.sin(a)];
    const v: Pt = [-u[1], u[0]];
    const o: Pt = [
      origin[0] + rot(family.origin, angle, scale)[0],
      origin[1] + rot(family.origin, angle, scale)[1],
    ];
    const step: Pt = rot(family.offset, family.angle + angle, scale);
    const across = family.offset[1] * scale;
    if (Math.abs(across) < 1e-12) continue;
    // Line k passes through o + k·step; its distance across is k·across.
    const dists = corners.map((c) => (c[0] - o[0]) * v[0] + (c[1] - o[1]) * v[1]);
    const kFrom = Math.ceil(Math.min(...dists.map((d) => d / across)) - 1e-9);
    const kTo = Math.floor(Math.max(...dists.map((d) => d / across)) + 1e-9);
    const dashes = family.dashes.map((d) => d * scale);
    const period = dashes.reduce((s, d) => s + Math.abs(d), 0);
    for (let k = kFrom; k <= kTo; k++) {
      const p: Pt = [o[0] + step[0] * k, o[1] + step[1] * k];
      const along = corners.map((c) => (c[0] - p[0]) * u[0] + (c[1] - p[1]) * u[1]);
      const tMin = Math.min(...along);
      const tMax = Math.max(...along);
      if (dashes.length === 0 || period <= 0) {
        out.push({ a: at(p, u, tMin), b: at(p, u, tMax) });
      } else {
        let t = Math.floor(tMin / period) * period;
        while (t < tMax) {
          for (const d of dashes) {
            const len = Math.abs(d);
            if (d >= 0 && t + len >= tMin && t <= tMax) {
              out.push({ a: at(p, u, t), b: at(p, u, t + len) });
            }
            t += len;
            if (out.length > max) return null;
          }
        }
      }
      if (out.length > max) return null;
    }
  }
  return out;
}

const at = (p: Pt, u: Pt, t: number): Pt => [p[0] + u[0] * t, p[1] + u[1] * t];

/** A vector turned by `degrees` and scaled. */
function rot(p: Pt, degrees: number, scale: number): Pt {
  const a = (degrees * Math.PI) / 180;
  return [
    (p[0] * Math.cos(a) - p[1] * Math.sin(a)) * scale,
    (p[0] * Math.sin(a) + p[1] * Math.cos(a)) * scale,
  ];
}

// ---------- islands ----------

/** How many of the other loops contain this loop (its nesting depth; 0 = outermost). */
export function loopDepths(loops: readonly (readonly Pt[])[]): number[] {
  return loops.map((loop, i) => {
    const probe = loop[0];
    if (!probe) return 0;
    let depth = 0;
    loops.forEach((other, j) => {
      if (j !== i && other.length >= 3 && insidePolygon(other, probe)) depth++;
    });
    return depth;
  });
}

/**
 * The loops filled, by AutoCAD's island detection: Normal fills every other level (all loops,
 * even-odd), Outer fills the outermost level only (depths 0 and 1, even-odd), Ignore fills the
 * outermost boundaries through every island (depth 0, non-zero).
 */
export function islandLoops(
  loops: readonly (readonly Pt[])[],
  style: HatchIslandStyle,
): { loops: (readonly Pt[])[]; rule: 'evenodd' | 'nonzero' } {
  if (style === 'normal') return { loops: [...loops], rule: 'evenodd' };
  const depth = loopDepths(loops);
  if (style === 'outer') {
    return { loops: loops.filter((_, i) => (depth[i] ?? 0) <= 1), rule: 'evenodd' };
  }
  return { loops: loops.filter((_, i) => (depth[i] ?? 0) === 0), rule: 'nonzero' };
}

/** Loops inside `outer` (islands a pick point finds with island detection on). */
export function islandsOf(outer: readonly Pt[], candidates: readonly (readonly Pt[])[]): Pt[][] {
  return candidates
    .filter(
      (loop) => loop !== outer && loop.length >= 3 && loop.every((p) => insidePolygon(outer, p)),
    )
    .map((loop) => [...loop]);
}
