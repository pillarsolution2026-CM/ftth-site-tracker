import {
  DEFAULT_OSMODE,
  dist,
  footOnLine,
  lineLine,
  modesOf,
  type Acquired,
  type Pt,
  type SnapHit,
  type SnapMode,
} from './object-snap';

/**
 * AutoCAD's drafting aids of the status bar, 2D only (owner 2026-11-26, item 14): Grid, Snap,
 * Ortho, Polar tracking, Object snap, Object snap tracking, Dynamic input… and how a pointer
 * position becomes the point a command takes. Pure; the hook keeps the state.
 */

export type LinearUnits = 'architectural' | 'decimal' | 'engineering' | 'fractional' | 'scientific';
export const LINEAR_UNITS: readonly LinearUnits[] = [
  'architectural',
  'decimal',
  'engineering',
  'fractional',
  'scientific',
];

/** AutoCAD's Polar Tracking increment angles (the Polar drop-down). */
export const POLAR_ANGLES: readonly number[] = [90, 45, 30, 22.5, 18, 15, 10, 5];

/** Status bar items that the gear (Customization) can show or hide. */
export const STATUS_ITEMS = [
  'coordinates',
  'model',
  'grid',
  'snap',
  'ortho',
  'polar',
  'otrack',
  'osnap',
  'dyn',
  'lineweight',
  'transparency',
  'selectionCycling',
  'selectionFilter',
  'annotationScale',
  'units',
  'quickProperties',
  'isolate',
  'cleanScreen',
] as const;
export type StatusItem = (typeof STATUS_ITEMS)[number];

export interface DraftingSettings {
  /** GRIDMODE (F7). */
  grid: boolean;
  /** SNAPMODE (F9). */
  snap: boolean;
  /** SNAPTYPE: the grid, or distances along polar tracking paths (POLARSNAP). */
  snapType: 'grid' | 'polar';
  snapX: number;
  snapY: number;
  gridX: number;
  gridY: number;
  /** POLARDIST: the step of PolarSnap. */
  polarDistance: number;
  /** ORTHOMODE (F8); on turns Polar off and the other way round, as AutoCAD. */
  ortho: boolean;
  /** Polar tracking (F10). */
  polar: boolean;
  /** POLARANG, degrees. */
  polarAngle: number;
  /** Additional angles (POLARADDANG), degrees. */
  polarAdditional: number[];
  /** Running object snaps (F3) and OSMODE. */
  osnap: boolean;
  osmode: number;
  /** Object snap tracking (F11). */
  otrack: boolean;
  /** Dynamic input (F12). */
  dyn: boolean;
  /** LWDISPLAY: line weights drawn at their width; off in AutoCAD's new drawings. */
  lineweight: boolean;
  /** TRANSPARENCYDISPLAY. */
  transparency: boolean;
  /** SELECTIONCYCLING: overlapping objects offer a list when one is picked. */
  selectionCycling: boolean;
  /** QPMODE: the Quick Properties palette on picking. */
  quickProperties: boolean;
  /** LUNITS / LUPREC. */
  units: LinearUnits;
  precision: number;
  /** Lat / Long (when the file has a CRS) or the drawing's X,Y. */
  coords: 'geo' | 'xy';
  /** APERTURE: half the object snap target box, pixels. */
  aperture: number;
  /** Items hidden from the status bar by its Customization menu. */
  hidden: StatusItem[];
}

/** AutoCAD's defaults for a new 2D drawing (acadiso.dwt); the grid starts off on this canvas. */
export const DEFAULT_DRAFTING: DraftingSettings = {
  grid: false,
  snap: false,
  snapType: 'grid',
  snapX: 10,
  snapY: 10,
  gridX: 10,
  gridY: 10,
  polarDistance: 10,
  ortho: false,
  polar: true,
  polarAngle: 90,
  polarAdditional: [],
  osnap: true,
  osmode: DEFAULT_OSMODE,
  otrack: true,
  dyn: true,
  lineweight: false,
  transparency: false,
  selectionCycling: false,
  quickProperties: false,
  units: 'decimal',
  precision: 4,
  coords: 'geo',
  aperture: 10,
  hidden: [],
};

const positive = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);

/** Settings read back from the browser: anything unknown or broken takes the default. */
export function parseDrafting(raw: unknown): DraftingSettings {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_DRAFTING;
  const r = raw as Record<string, unknown>;
  const d = DEFAULT_DRAFTING;
  const units = LINEAR_UNITS.find((u) => u === r.units) ?? d.units;
  return {
    grid: bool(r.grid, d.grid),
    snap: bool(r.snap, d.snap),
    snapType: r.snapType === 'polar' ? 'polar' : 'grid',
    snapX: positive(r.snapX, d.snapX),
    snapY: positive(r.snapY, d.snapY),
    gridX: positive(r.gridX, d.gridX),
    gridY: positive(r.gridY, d.gridY),
    polarDistance: positive(r.polarDistance, d.polarDistance),
    ortho: bool(r.ortho, d.ortho),
    polar: bool(r.polar, d.polar) && !bool(r.ortho, d.ortho),
    polarAngle: positive(r.polarAngle, d.polarAngle),
    polarAdditional: Array.isArray(r.polarAdditional)
      ? r.polarAdditional.filter((a): a is number => typeof a === 'number' && Number.isFinite(a))
      : d.polarAdditional,
    osnap: bool(r.osnap, d.osnap),
    osmode:
      typeof r.osmode === 'number' && Number.isInteger(r.osmode) && r.osmode >= 0
        ? r.osmode & 16383
        : d.osmode,
    otrack: bool(r.otrack, d.otrack),
    dyn: bool(r.dyn, d.dyn),
    lineweight: bool(r.lineweight, d.lineweight),
    transparency: bool(r.transparency, d.transparency),
    selectionCycling: bool(r.selectionCycling, d.selectionCycling),
    quickProperties: bool(r.quickProperties, d.quickProperties),
    units,
    precision:
      typeof r.precision === 'number' &&
      Number.isInteger(r.precision) &&
      r.precision >= 0 &&
      r.precision <= 8
        ? r.precision
        : d.precision,
    coords: r.coords === 'xy' ? 'xy' : 'geo',
    aperture: Math.min(50, Math.max(1, Math.round(positive(r.aperture, d.aperture)))),
    hidden: Array.isArray(r.hidden)
      ? STATUS_ITEMS.filter((item) => (r.hidden as unknown[]).includes(item))
      : d.hidden,
  };
}

/** F8 / F10: Ortho and Polar exclude each other (AutoCAD). */
export function toggleOrtho(s: DraftingSettings): DraftingSettings {
  return s.ortho ? { ...s, ortho: false } : { ...s, ortho: true, polar: false };
}
export function togglePolar(s: DraftingSettings): DraftingSettings {
  return s.polar ? { ...s, polar: false } : { ...s, polar: true, ortho: false };
}

// ---------- the point a command takes ----------

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;
const norm360 = (deg: number) => ((deg % 360) + 360) % 360;

/** Ortho: the point straight across or up from the last point, whichever is nearer. */
export function orthoPoint(anchor: Pt, cursor: Pt): Pt {
  const dx = cursor[0] - anchor[0];
  const dy = cursor[1] - anchor[1];
  return Math.abs(dx) >= Math.abs(dy) ? [cursor[0], anchor[1]] : [anchor[0], cursor[1]];
}

/** Every polar tracking angle (multiples of the increment, plus the additional ones), degrees. */
export function polarAngles(increment: number, additional: readonly number[] = []): number[] {
  const out = new Set<number>();
  if (increment > 0) {
    for (let a = 0; a < 360 - 1e-9; a += increment) out.add(Math.round(a * 1e6) / 1e6);
  }
  for (const a of additional) out.add(norm360(a));
  return [...out];
}

/**
 * Polar tracking: when the pointer is within the aperture of a tracking path from the last
 * point, the point slides onto it. `step` > 0 rounds the distance along it (PolarSnap).
 */
export function polarPoint(
  anchor: Pt,
  cursor: Pt,
  angles: readonly number[],
  aperture: number,
  step = 0,
): { at: Pt; angle: number; distance: number } | null {
  const d = dist(anchor, cursor);
  if (d === 0) return null;
  let best: { at: Pt; angle: number; distance: number; off: number } | null = null;
  for (const angle of angles) {
    const dir: Pt = [Math.cos(toRad(angle)), Math.sin(toRad(angle))];
    const along = (cursor[0] - anchor[0]) * dir[0] + (cursor[1] - anchor[1]) * dir[1];
    if (along <= 0) continue;
    const at: Pt = [anchor[0] + dir[0] * along, anchor[1] + dir[1] * along];
    const off = dist(at, cursor);
    if (off > aperture || (best && off >= best.off)) continue;
    best = { at, angle, distance: along, off };
  }
  if (!best) return null;
  let distance = best.distance;
  if (step > 0) distance = Math.max(step, Math.round(distance / step) * step);
  const dir: Pt = [Math.cos(toRad(best.angle)), Math.sin(toRad(best.angle))];
  return {
    at: [anchor[0] + dir[0] * distance, anchor[1] + dir[1] * distance],
    angle: best.angle,
    distance,
  };
}

/** Snap (F9) on the grid: the nearest snap point (from the origin 0,0 as SNAPBASE). */
export function gridPoint(cursor: Pt, spacingX: number, spacingY: number): Pt {
  return [Math.round(cursor[0] / spacingX) * spacingX, Math.round(cursor[1] / spacingY) * spacingY];
}

/** A dotted alignment path of object snap tracking. */
export interface TrackPath {
  from: Pt;
  angle: number;
}

/**
 * Object snap tracking: paths at the tracking angles (orthogonal, or the polar angles when Polar
 * is on) through each acquired point; the pointer near one slides onto it, near two crossing
 * paths it takes their crossing.
 */
export function trackingPoint(
  acquired: readonly Acquired[],
  cursor: Pt,
  angles: readonly number[],
  aperture: number,
): { at: Pt; paths: TrackPath[] } | null {
  const near: { path: TrackPath; at: Pt; off: number }[] = [];
  for (const point of acquired) {
    for (const angle of angles) {
      const dir: Pt = [Math.cos(toRad(angle)), Math.sin(toRad(angle))];
      const foot = footOnLine(cursor, point.at, [point.at[0] + dir[0], point.at[1] + dir[1]]);
      if (foot.t <= 0) continue;
      const off = dist(foot.at, cursor);
      if (off <= aperture) near.push({ path: { from: point.at, angle }, at: foot.at, off });
    }
  }
  if (near.length === 0) return null;
  near.sort((a, b) => a.off - b.off);
  for (let i = 0; i < near.length; i++) {
    for (let j = i + 1; j < near.length; j++) {
      const a = near[i] as (typeof near)[number];
      const b = near[j] as (typeof near)[number];
      if (dist(a.path.from, b.path.from) === 0) continue;
      const x = lineLine(
        a.path.from,
        [
          a.path.from[0] + Math.cos(toRad(a.path.angle)),
          a.path.from[1] + Math.sin(toRad(a.path.angle)),
        ],
        b.path.from,
        [
          b.path.from[0] + Math.cos(toRad(b.path.angle)),
          b.path.from[1] + Math.sin(toRad(b.path.angle)),
        ],
      );
      if (x && dist(x.at, cursor) <= aperture * 1.5) return { at: x.at, paths: [a.path, b.path] };
    }
  }
  const first = near[0] as (typeof near)[number];
  return { at: first.at, paths: [first.path] };
}

export interface Resolved {
  /** The point the command takes. */
  at: Pt;
  snap: SnapHit | null;
  /** Polar / ortho: the angle and distance from the last point (the tooltip). */
  polar: { angle: number; distance: number } | null;
  tracks: TrackPath[];
}

export interface ResolveInput {
  cursor: Pt;
  /** The last point of the command; null at a first point. */
  anchor: Pt | null;
  settings: DraftingSettings;
  /** The object snaps found at the pointer, best first (empty with object snap off). */
  snaps: readonly SnapHit[];
  /** Which of `snaps` Tab has moved to. */
  cycle?: number;
  acquired?: readonly Acquired[];
  /** The aperture in drawing units. */
  aperture: number;
}

/**
 * The pointer as the point a command takes, in AutoCAD's order: an object snap wins; else object
 * snap tracking; else Ortho or Polar from the last point; Snap (F9) rounds to the grid first.
 */
export function resolvePoint(input: ResolveInput): Resolved {
  const { cursor, anchor, settings: s, snaps, aperture } = input;
  const snap = snaps.length > 0 ? (snaps[(input.cycle ?? 0) % snaps.length] ?? null) : null;
  if (snap) return { at: snap.at, snap, polar: null, tracks: [] };

  const trackAngles = s.polar ? polarAngles(s.polarAngle, s.polarAdditional) : [0, 90, 180, 270];
  if (s.otrack && s.osnap && (input.acquired?.length ?? 0) > 0) {
    const tracked = trackingPoint(input.acquired ?? [], cursor, trackAngles, aperture);
    if (tracked) return { at: tracked.at, snap: null, polar: null, tracks: tracked.paths };
  }

  let at = cursor;
  if (s.snap && s.snapType === 'grid') at = gridPoint(cursor, s.snapX, s.snapY);
  if (!anchor) return { at, snap: null, polar: null, tracks: [] };
  if (s.ortho) {
    const o = orthoPoint(anchor, at);
    const angle = norm360(toDeg(Math.atan2(o[1] - anchor[1], o[0] - anchor[0])));
    return { at: o, snap: null, polar: { angle, distance: dist(anchor, o) }, tracks: [] };
  }
  if (s.polar) {
    const step = s.snap && s.snapType === 'polar' ? s.polarDistance : 0;
    const p = polarPoint(anchor, at, polarAngles(s.polarAngle, s.polarAdditional), aperture, step);
    if (p) {
      return {
        at: p.at,
        snap: null,
        polar: { angle: p.angle, distance: p.distance },
        tracks: [{ from: anchor, angle: p.angle }],
      };
    }
  }
  return { at, snap: null, polar: null, tracks: [] };
}

/** The running object snap modes in force (none with object snap off). */
export const activeModes = (s: DraftingSettings): Set<SnapMode> =>
  s.osnap ? modesOf(s.osmode) : new Set();

// ---------- AutoCAD's unit formats ----------

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** Whole part and a fraction rounded to 1 / 2^precision, reduced (Architectural, Fractional). */
function fraction(value: number, precision: number): string {
  const denominator = 2 ** Math.min(8, precision);
  let whole = Math.floor(value);
  let numerator = Math.round((value - whole) * denominator);
  if (numerator === denominator) {
    whole += 1;
    numerator = 0;
  }
  if (numerator === 0) return `${whole}`;
  const k = gcd(numerator, denominator);
  const frac = `${numerator / k}/${denominator / k}`;
  return whole === 0 ? frac : `${whole} ${frac}`;
}

/**
 * A length as AutoCAD shows it (LUNITS / LUPREC). Engineering and Architectural read a drawing
 * unit as one inch, as AutoCAD does.
 */
export function formatLength(value: number, units: LinearUnits, precision: number): string {
  const sign = value < 0 ? '-' : '';
  const v = Math.abs(value);
  switch (units) {
    case 'scientific': {
      const [mantissa, exponent] = v.toExponential(precision).split('e');
      const e = Number(exponent);
      return `${sign}${mantissa}E${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
    }
    case 'engineering': {
      let feet = Math.floor(v / 12);
      let inches = Number((v - feet * 12).toFixed(precision));
      if (inches >= 12) {
        feet += 1;
        inches = 0;
      }
      return `${sign}${feet}'-${inches.toFixed(precision)}"`;
    }
    case 'architectural': {
      let feet = Math.floor(v / 12);
      let inches = fraction(v - feet * 12, precision);
      if (inches === '12') {
        feet += 1;
        inches = '0';
      }
      return `${sign}${feet}'-${inches}"`;
    }
    case 'fractional':
      return `${sign}${fraction(v, precision)}`;
    default:
      return `${sign}${v.toFixed(precision)}`;
  }
}

/** The status bar's coordinates: `x, y, 0.0000` (Z is always 0 in this 2D screen). */
export function formatCoordinates(at: Pt, units: LinearUnits, precision: number): string {
  const f = (v: number) => formatLength(v, units, precision);
  return `${f(at[0])}, ${f(at[1])}, ${f(0)}`;
}

/** Lat / Long with six decimals (about 0.1 m). */
export function formatLatLong(lat: number, lon: number): string {
  return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}

/** Dynamic input / polar tooltip: `distance < angle°`. */
export function formatPolar(
  distance: number,
  angle: number,
  units: LinearUnits,
  precision: number,
) {
  const a = Math.round(norm360(angle) * 1e4) / 1e4;
  return `${formatLength(distance, units, precision)} < ${a}°`;
}
