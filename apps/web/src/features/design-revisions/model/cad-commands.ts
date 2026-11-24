import type { DrawingLinetype } from '@ftth/shared';

/**
 * The AutoCAD-like command line of the drawing (ADR-051): command names and aliases, what a typed
 * entry means, AutoCAD colours, line types and line weights. Pure.
 */

export type CommandId =
  // Draw
  | 'line'
  | 'pline'
  | 'circle'
  | 'arc'
  | 'rectang'
  | 'point'
  | 'spline'
  | 'ellipse'
  | 'polygon'
  | 'xline'
  | 'ray'
  | 'divide'
  | 'measure'
  | 'region'
  | 'hatch'
  | 'gradient'
  | 'boundary'
  | 'wipeout'
  | 'helix'
  | 'donut'
  // Modify
  | 'move'
  | 'copy'
  | 'stretch'
  | 'rotate'
  | 'mirror'
  | 'scale'
  | 'trim'
  | 'fillet'
  | 'erase'
  | 'offset'
  | 'join'
  | 'break'
  | 'breakatpoint'
  | 'lengthen'
  | 'reverse'
  | 'arrayrect'
  | 'overkill'
  | 'draworder'
  // Annotation
  | 'text'
  | 'textedit'
  | 'dimlinear'
  | 'leader'
  // Layers and properties
  | 'layer'
  | 'matchprop'
  | 'laymcur'
  | 'laymch';

export interface CommandDef {
  /** The AutoCAD command name, as typed and as shown before each prompt. */
  name: string;
  aliases: readonly string[];
}

export const COMMANDS: Readonly<Record<CommandId, CommandDef>> = {
  line: { name: 'LINE', aliases: ['L'] },
  pline: { name: 'PLINE', aliases: ['PL'] },
  circle: { name: 'CIRCLE', aliases: ['C'] },
  arc: { name: 'ARC', aliases: ['A'] },
  rectang: { name: 'RECTANG', aliases: ['REC', 'RECTANGLE'] },
  point: { name: 'POINT', aliases: ['PO'] },
  spline: { name: 'SPLINE', aliases: ['SPL'] },
  ellipse: { name: 'ELLIPSE', aliases: ['EL'] },
  polygon: { name: 'POLYGON', aliases: ['POL'] },
  xline: { name: 'XLINE', aliases: ['XL'] },
  ray: { name: 'RAY', aliases: [] },
  divide: { name: 'DIVIDE', aliases: ['DIV'] },
  measure: { name: 'MEASURE', aliases: ['ME'] },
  region: { name: 'REGION', aliases: ['REG'] },
  hatch: { name: 'HATCH', aliases: ['H', 'BH'] },
  gradient: { name: 'GRADIENT', aliases: ['GD'] },
  boundary: { name: 'BOUNDARY', aliases: ['BO'] },
  wipeout: { name: 'WIPEOUT', aliases: [] },
  helix: { name: 'HELIX', aliases: [] },
  donut: { name: 'DONUT', aliases: ['DO', 'DOUGHNUT'] },
  move: { name: 'MOVE', aliases: ['M'] },
  copy: { name: 'COPY', aliases: ['CO', 'CP'] },
  stretch: { name: 'STRETCH', aliases: ['S'] },
  rotate: { name: 'ROTATE', aliases: ['RO'] },
  mirror: { name: 'MIRROR', aliases: ['MI'] },
  scale: { name: 'SCALE', aliases: ['SC'] },
  trim: { name: 'TRIM', aliases: ['TR'] },
  fillet: { name: 'FILLET', aliases: ['F'] },
  erase: { name: 'ERASE', aliases: ['E'] },
  offset: { name: 'OFFSET', aliases: ['O'] },
  join: { name: 'JOIN', aliases: ['J'] },
  break: { name: 'BREAK', aliases: ['BR'] },
  breakatpoint: { name: 'BREAKATPOINT', aliases: [] },
  lengthen: { name: 'LENGTHEN', aliases: ['LEN'] },
  reverse: { name: 'REVERSE', aliases: [] },
  arrayrect: { name: 'ARRAYRECT', aliases: ['AR', 'ARRAY'] },
  overkill: { name: 'OVERKILL', aliases: [] },
  draworder: { name: 'DRAWORDER', aliases: ['DR'] },
  text: { name: 'TEXT', aliases: ['T', 'DT', 'DTEXT'] },
  textedit: { name: 'TEXTEDIT', aliases: ['ED', 'DDEDIT'] },
  dimlinear: { name: 'DIMLINEAR', aliases: ['DLI'] },
  leader: { name: 'LEADER', aliases: ['LE', 'LEAD'] },
  layer: { name: 'LAYER', aliases: ['LA'] },
  matchprop: { name: 'MATCHPROP', aliases: ['MA'] },
  laymcur: { name: 'LAYMCUR', aliases: [] },
  laymch: { name: 'LAYMCH', aliases: [] },
};

const BY_NAME: ReadonlyMap<string, CommandId> = new Map(
  (Object.entries(COMMANDS) as [CommandId, CommandDef][]).flatMap(([id, def]) =>
    [def.name, ...def.aliases].map((name) => [name, id] as const),
  ),
);

/** The command a typed word names (AutoCAD's `_` and `.` prefixes allowed), or null. */
export function lookupCommand(typed: string): CommandId | null {
  const word = typed
    .trim()
    .toUpperCase()
    .replace(/^[_.]+/, '');
  return BY_NAME.get(word) ?? null;
}

/** Commands that work on objects: picked first (noun-verb) or after the command (verb-noun). */
export const SELECTING: readonly CommandId[] = [
  'move',
  'copy',
  'stretch',
  'rotate',
  'mirror',
  'scale',
  'erase',
  'join',
  'laymch',
  'reverse',
  'arrayrect',
  'overkill',
  'draworder',
  'region',
];

export interface Point {
  x: number;
  y: number;
}

/** What a line typed on the command line means. */
export type Entry =
  | { kind: 'empty' }
  | { kind: 'point'; point: Point }
  | { kind: 'number'; value: number }
  | { kind: 'word'; word: string }
  | { kind: 'bad' };

const NUM = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)`;
const XY = new RegExp(String.raw`^([@#]?)\s*(${NUM})\s*,\s*(${NUM})$`);
const POLAR = new RegExp(String.raw`^([@#]?)\s*(${NUM})\s*<\s*(${NUM})$`);
const NUMBER = new RegExp(`^${NUM}$`);

/**
 * AutoCAD entry: `x,y` (absolute), `@dx,dy` (from the last point), `d<angle` / `@d<angle` (polar,
 * degrees counter-clockwise from the X axis), a number (a distance or value), a word (an option or
 * a command). The decimal mark is the point: the comma separates X and Y.
 */
export function parseEntry(text: string, last: Point | null): Entry {
  const value = text.trim();
  if (value === '') return { kind: 'empty' };
  const xy = XY.exec(value);
  if (xy) {
    const [, mark, sx, sy] = xy;
    const x = Number(sx);
    const y = Number(sy);
    if (mark === '@')
      return last ? { kind: 'point', point: { x: last.x + x, y: last.y + y } } : { kind: 'bad' };
    return { kind: 'point', point: { x, y } };
  }
  const polar = POLAR.exec(value);
  if (polar) {
    const [, mark, sd, sa] = polar;
    const d = Number(sd);
    const a = (Number(sa) * Math.PI) / 180;
    const from = mark === '@' ? last : { x: 0, y: 0 };
    if (!from) return { kind: 'bad' };
    return { kind: 'point', point: { x: from.x + d * Math.cos(a), y: from.y + d * Math.sin(a) } };
  }
  if (NUMBER.test(value)) return { kind: 'number', value: Number(value) };
  // A word: a command or an option (AutoCAD's options may start with a digit, e.g. 3P).
  if (/^[A-Za-z0-9_.-]*[A-Za-z][A-Za-z0-9_.-]*$/.test(value)) {
    return { kind: 'word', word: value.toUpperCase() };
  }
  return { kind: 'bad' };
}

/** AutoCAD's direct distance entry: `distance` from `from` toward the pointer. */
export function towards(from: Point, pointer: Point | null, distance: number): Point {
  const dx = (pointer?.x ?? from.x + 1) - from.x;
  const dy = (pointer?.y ?? from.y) - from.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x: from.x + (dx / length) * distance, y: from.y + (dy / length) * distance };
}

/** An option keyword typed for a prompt: its capital letters are the short form (AutoCAD). */
export interface CommandOption {
  word: string;
  key: string;
}

export function matchOption(options: readonly CommandOption[], word: string): string | null {
  const upper = word.toUpperCase();
  // The short form, the whole word, or its first word (`TTR` for «Ttr (tan tan radius)»).
  const hit = options.find(
    (o) =>
      o.key === upper ||
      o.word.toUpperCase() === upper ||
      o.word.split(' ')[0]?.toUpperCase() === upper,
  );
  return hit ? hit.key : null;
}

/** A number as AutoCAD prints it (4 decimals). */
export const acadNumber = (value: number) => value.toFixed(4);

// ---------- properties ----------

/** AutoCAD Index Colours 1–7 and two greys; null = ByLayer. */
export const ACI_COLORS: readonly { aci: number; name: string; hex: string }[] = [
  { aci: 1, name: 'Red', hex: '#ff0000' },
  { aci: 2, name: 'Yellow', hex: '#ffff00' },
  { aci: 3, name: 'Green', hex: '#00ff00' },
  { aci: 4, name: 'Cyan', hex: '#00ffff' },
  { aci: 5, name: 'Blue', hex: '#0000ff' },
  { aci: 6, name: 'Magenta', hex: '#ff00ff' },
  { aci: 7, name: 'White', hex: '#ffffff' },
  { aci: 8, name: '8', hex: '#808080' },
  { aci: 9, name: '9', hex: '#c0c0c0' },
];

export const LINETYPES: readonly DrawingLinetype[] = ['continuous', 'dashed', 'dotted', 'center'];
/** AutoCAD's line type names as shown in the drop-down. */
export const LINETYPE_NAMES: Readonly<Record<DrawingLinetype, string>> = {
  continuous: 'Continuous',
  dashed: 'DASHED',
  dotted: 'DOT',
  center: 'CENTER',
};
/** Dash pattern of each line type in screen pixels. */
export const LINETYPE_DASH: Readonly<Record<DrawingLinetype, readonly number[]>> = {
  continuous: [],
  dashed: [12, 6],
  dotted: [2, 5],
  center: [20, 5, 5, 5],
};

/** AutoCAD's standard line weights, millimetres. */
export const LINEWEIGHTS: readonly number[] = [
  0, 0.05, 0.09, 0.13, 0.15, 0.18, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.53, 0.6, 0.7, 0.8, 0.9, 1,
  1.06, 1.2, 1.4, 1.58, 2, 2.11,
];

/** Pixels on screen of a line weight (AutoCAD shows weights at 96 dpi when LWDISPLAY is on). */
export const lineweightPx = (mm: number) => Math.max(1, (mm * 96) / 25.4);
