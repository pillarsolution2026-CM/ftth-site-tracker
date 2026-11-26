import {
  acadAngle,
  acadNumber,
  COMMANDS,
  type CommandId,
  type CommandOption,
  type Point,
} from '../model/cad-commands';
import {
  geometryOf,
  normalAngle,
  polygonArea,
  polylineLength,
  type EntityGeometry,
  type Xy,
} from '../model/entity-geometry';
import type { ExtraContext, ExtraRun } from './extra-commands';

/**
 * AutoCAD's inquiry commands (round 3, audit 4.2 / 11): ID, DIST (with Multiple points), AREA
 * (points, Object, Add area, Subtract area), LIST and MEASUREGEOM (Distance, Radius, Angle, ARea),
 * with AutoCAD's prompts and its output lines. Nothing is changed in the drawing. 'DIST and 'ID
 * also run inside another command.
 */

export const INQUIRY_COMMANDS: ReadonlySet<CommandId> = new Set<CommandId>([
  'id',
  'dist',
  'area',
  'list',
  'measuregeom',
]);

export type InquiryStep =
  | 'i_id'
  | 'i_distFirst'
  | 'i_distSecond'
  | 'i_distNext'
  | 'i_areaFirst'
  | 'i_areaNext'
  | 'i_areaObj'
  | 'i_mgOption'
  | 'i_mgRadius'
  | 'i_mgAngle'
  | 'i_mgAngle2'
  | 'i_mgVertex'
  | 'i_mgEnd1'
  | 'i_mgEnd2';

export type InquiryPromptKey =
  | 'idPoint'
  | 'distFirst'
  | 'distSecond'
  | 'distNext'
  | 'areaFirst'
  | 'areaNext'
  | 'areaNextAdd'
  | 'areaNextSubtract'
  | 'areaObject'
  | 'areaObjectAdd'
  | 'areaObjectSubtract'
  | 'mgOption'
  | 'mgRadius'
  | 'mgAngle'
  | 'mgAngle2'
  | 'mgVertex'
  | 'mgEnd1'
  | 'mgEnd2';

export const INQUIRY_OBJECT_STEPS: readonly string[] = [
  'i_areaObj',
  'i_mgRadius',
  'i_mgAngle',
  'i_mgAngle2',
];
export const INQUIRY_TRACKED: readonly string[] = [
  'i_distSecond',
  'i_distNext',
  'i_areaNext',
  'i_mgEnd1',
  'i_mgEnd2',
];

type AreaMode = 'add' | 'sub' | null;

interface InquiryData {
  mode?: AreaMode;
  total?: number;
  /** Inside MEASUREGEOM: after a result its option prompt comes back. */
  mg?: boolean;
  /** The first line picked for an angle, and where. */
  line?: [Xy, Xy];
  lineAt?: Xy;
  vertex?: Point;
  /** The command a transparent 'DIST / 'ID runs inside. */
  outer?: ExtraRun;
}

interface Prompt {
  key: InquiryPromptKey;
  options: CommandOption[];
  fallback: string | null;
}

const opt = (word: string, key: string): CommandOption => ({ word, key });
const inquiryData = (r: ExtraRun): InquiryData => (r.flags.extra as InquiryData | undefined) ?? {};
const go = <R extends ExtraRun>(
  ctx: ExtraContext<R>,
  r: R,
  step: InquiryStep,
  patch: InquiryData = {},
  points?: Point[],
) =>
  ctx.setRun({
    ...r,
    step,
    points: points ?? r.points,
    flags: { ...r.flags, extra: { ...inquiryData(r), ...patch } },
  });

export const isInquiryCommand = (cmd: CommandId) => INQUIRY_COMMANDS.has(cmd);
export const inquiryTransparentLabel = (r: ExtraRun | null): string | null =>
  r && isInquiryCommand(r.cmd) && inquiryData(r).outer ? '>>' : null;

const n = (value: number) => acadNumber(Math.abs(value) < 5e-5 ? 0 : value);
const MG_OPTIONS = [
  opt('Distance', 'D'),
  opt('Radius', 'R'),
  opt('Angle', 'A'),
  opt('ARea', 'AR'),
  opt('Volume', 'V'),
  opt('eXit', 'X'),
];
/** Vertices LIST prints for one polyline before it says how many more there are. */
const LIST_VERTICES = 20;

// ---------- prompts ----------

export function inquiryPrompt(r: ExtraRun): Prompt | null {
  const d = inquiryData(r);
  const p = (
    key: InquiryPromptKey,
    options: CommandOption[] = [],
    fallback: string | null = null,
  ) => ({
    key,
    options,
    fallback,
  });
  switch (r.step as InquiryStep) {
    case 'i_id':
      return p('idPoint');
    case 'i_distFirst':
      return p('distFirst');
    case 'i_distSecond':
      return p('distSecond', [opt('Multiple points', 'M')]);
    case 'i_distNext':
      return p(
        'distNext',
        [opt('Arc', 'A'), opt('Length', 'L'), opt('Undo', 'U'), opt('Total', 'T')],
        'Total',
      );
    case 'i_areaFirst':
      if (d.mode === 'add')
        return p('areaFirst', [opt('Object', 'O'), opt('Subtract area', 'S'), opt('eXit', 'X')]);
      if (d.mode === 'sub')
        return p('areaFirst', [opt('Object', 'O'), opt('Add area', 'A'), opt('eXit', 'X')]);
      return p(
        'areaFirst',
        [opt('Object', 'O'), opt('Add area', 'A'), opt('Subtract area', 'S')],
        'Object',
      );
    case 'i_areaNext': {
      const key =
        d.mode === 'add' ? 'areaNextAdd' : d.mode === 'sub' ? 'areaNextSubtract' : 'areaNext';
      return r.points.length >= 2
        ? p(
            key,
            [opt('Arc', 'A'), opt('Length', 'L'), opt('Undo', 'U'), opt('Total', 'T')],
            'Total',
          )
        : p(key, [opt('Arc', 'A'), opt('Length', 'L'), opt('Undo', 'U')]);
    }
    case 'i_areaObj':
      return p(
        d.mode === 'add' ? 'areaObjectAdd' : d.mode === 'sub' ? 'areaObjectSubtract' : 'areaObject',
      );
    case 'i_mgOption':
      return p('mgOption', MG_OPTIONS, 'Distance');
    case 'i_mgRadius':
      return p('mgRadius');
    case 'i_mgAngle':
      return p('mgAngle', [], 'Specify vertex');
    case 'i_mgAngle2':
      return p('mgAngle2');
    case 'i_mgVertex':
      return p('mgVertex');
    case 'i_mgEnd1':
      return p('mgEnd1');
    case 'i_mgEnd2':
      return p('mgEnd2');
  }
  return null;
}

// ---------- start / end ----------

function done<R extends ExtraRun>(ctx: ExtraContext<R>, r: R) {
  const d = inquiryData(r);
  if (d.mg) {
    ctx.setRun({
      ...r,
      step: 'i_mgOption',
      points: [],
      flags: { ...r.flags, extra: { mg: true } },
    });
    return;
  }
  const outer = d.outer as R | undefined;
  if (outer) {
    ctx.say(ctx.msg('resuming', { name: COMMANDS[outer.cmd].name }));
    ctx.setRun(outer);
    return;
  }
  ctx.finish(true);
}

export function inquiryBegin<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  cmd: CommandId,
  fresh: (step: string) => R,
  outer: R | null = null,
): R | null {
  const start = (step: InquiryStep, extra: InquiryData = {}): R => {
    const r = fresh(step);
    const run = { ...r, flags: { ...r.flags, extra: outer ? { ...extra, outer } : extra } };
    ctx.setRun(run);
    return run;
  };
  switch (cmd) {
    case 'id':
      return start('i_id');
    case 'dist':
      return start('i_distFirst');
    case 'area':
      return start('i_areaFirst', { mode: null, total: 0 });
    case 'measuregeom':
      return start('i_mgOption', { mg: true });
    case 'list': {
      const r = fresh('select');
      if (ctx.handles.length > 0) return inquiryAfterSelect(ctx, r);
      ctx.setRun(r);
      return r;
    }
    default:
      return null;
  }
}

/** LIST after «Select objects:». */
export function inquiryAfterSelect<R extends ExtraRun>(ctx: ExtraContext<R>, r: R): R | null {
  if (r.cmd === 'list') {
    const seen = new Set<string>();
    for (const index of [...ctx.selection].sort((a, b) => a - b)) {
      const handle = ctx.scene.view.entities[index]?.handle ?? '';
      if (seen.has(handle)) continue;
      seen.add(handle);
      ctx.say(...listLines(ctx, index));
    }
  }
  ctx.finish(true);
  return null;
}

// ---------- maths ----------

const xyOf = (p: Point): Xy => ({ x: p.x, y: p.y });

function distanceLines<R extends ExtraRun>(ctx: ExtraContext<R>, a: Point, b: Point) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const angle = normalAngle((Math.atan2(dy, dx) * 180) / Math.PI);
  ctx.say(
    ctx.msg('distResult', { distance: n(Math.hypot(dx, dy)), angle: acadAngle(angle) }),
    ctx.msg('distDelta', { dx: n(dx), dy: n(dy) }),
  );
}

const pathLength = (points: readonly Point[]) => polylineLength(points.map(xyOf), false);

/** What AREA / MEASUREGEOM ARea say about an object: area and its perimeter-like length. */
function objectArea(
  g: EntityGeometry | null,
): { area: number; length: number; word: 'perimeter' | 'circumference' | 'length' } | null {
  switch (g?.type) {
    case 'polyline':
      // An open polyline is measured as if closed; its length is its own (AutoCAD).
      return {
        area: polygonArea(g.points),
        length: polylineLength(g.points, g.closed),
        word: g.closed ? 'perimeter' : 'length',
      };
    case 'circle':
      return {
        area: Math.PI * g.radius * g.radius,
        length: 2 * Math.PI * g.radius,
        word: 'circumference',
      };
    case 'arc': {
      const total = (arcTotal(g) * Math.PI) / 180;
      return {
        area: (g.radius * g.radius * (total - Math.sin(total))) / 2,
        length: g.radius * total,
        word: 'length',
      };
    }
    case 'ellipse': {
      const a = Math.hypot(g.major[0].x - g.center.x, g.major[0].y - g.center.y);
      const b = Math.hypot(g.minor[0].x - g.center.x, g.minor[0].y - g.center.y);
      // Ramanujan's perimeter.
      const h = ((a - b) * (a - b)) / ((a + b) * (a + b));
      return {
        area: Math.PI * a * b,
        length: Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h))),
        word: 'circumference',
      };
    }
    default:
      return null;
  }
}

function arcTotal(g: Extract<EntityGeometry, { type: 'arc' }>): number {
  const a = (p: Xy) => (Math.atan2(p.y - g.center.y, p.x - g.center.x) * 180) / Math.PI;
  const start = a(g.start);
  const end = a(g.end);
  const mid = a(g.mid);
  // The arc runs from start through mid to end: counter-clockwise when mid lies on that sweep.
  const ccw = normalAngle(end - start);
  return normalAngle(mid - start) <= ccw ? ccw : 360 - ccw;
}

/** The segment of a line / polyline nearest a point. */
function segmentNear(g: EntityGeometry | null, at: Xy): [Xy, Xy] | null {
  if (g?.type === 'line') return [g.start, g.end];
  if (g?.type !== 'polyline') return null;
  const pts = g.closed ? [...g.points, g.points[0] as Xy] : g.points;
  let best: [Xy, Xy] | null = null;
  let bestD = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Xy;
    const b = pts[i] as Xy;
    const d = segmentDistance(a, b, at);
    if (d < bestD) {
      bestD = d;
      best = [a, b];
    }
  }
  return best;
}

function segmentDistance(a: Xy, b: Xy, p: Xy): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Angle between two vectors, degrees in [0, 180]. */
function between(u: Xy, v: Xy): number {
  const cos = (u.x * v.x + u.y * v.y) / (Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y));
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

/**
 * The angle of two picked lines in the quadrant of the picks (as AutoCAD): each line's direction
 * from their crossing toward where it was picked. Null when they are parallel.
 */
export function angleOfLines(l1: [Xy, Xy], at1: Xy, l2: [Xy, Xy], at2: Xy): number | null {
  const [a, b] = l1;
  const [c, e] = l2;
  const d1 = { x: b.x - a.x, y: b.y - a.y };
  const d2 = { x: e.x - c.x, y: e.y - c.y };
  const cross = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(cross) < 1e-12 * Math.hypot(d1.x, d1.y) * Math.hypot(d2.x, d2.y)) return null;
  const t = ((c.x - a.x) * d2.y - (c.y - a.y) * d2.x) / cross;
  const x = { x: a.x + t * d1.x, y: a.y + t * d1.y };
  const side = (d: Xy, at: Xy) => {
    const s = (at.x - x.x) * d.x + (at.y - x.y) * d.y;
    return s >= 0 ? d : { x: -d.x, y: -d.y };
  };
  return between(side(d1, at1), side(d2, at2));
}

// ---------- entries ----------

function areaReport<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  r: R,
  area: number,
  length: number,
  word: 'perimeter' | 'circumference' | 'length',
) {
  const d = inquiryData(r);
  ctx.say(ctx.msg(`area_${word}`, { area: n(area), length: n(length) }));
  if (!d.mode) return;
  const total = (d.total ?? 0) + (d.mode === 'add' ? area : -area);
  ctx.say(ctx.msg('areaTotal', { area: n(total) }));
  ctx.setRun({
    ...r,
    step: d.mode && r.step === 'i_areaObj' ? 'i_areaObj' : 'i_areaFirst',
    points: [],
    flags: { ...r.flags, extra: { ...d, total } },
  });
}

/** The polygon of the points given: its area and perimeter. */
function areaOfPoints<R extends ExtraRun>(ctx: ExtraContext<R>, r: R) {
  const pts = r.points.map(xyOf);
  const area = pts.length >= 3 ? polygonArea(pts) : 0;
  const perimeter = polylineLength(pts, pts.length > 2);
  areaReport(ctx, r, area, perimeter, 'perimeter');
  if (!inquiryData(r).mode) done(ctx, r);
}

export function inquiryPoint<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, p: Point): void {
  const d = inquiryData(r);
  switch (r.step as InquiryStep) {
    case 'i_id':
      ctx.say(ctx.msg('idResult', { x: n(p.x), y: n(p.y) }));
      done(ctx, r);
      return;
    case 'i_distFirst':
      go(ctx, r, 'i_distSecond', {}, [p]);
      return;
    case 'i_distSecond': {
      const first = r.points[0];
      if (first) distanceLines(ctx, first, p);
      done(ctx, r);
      return;
    }
    case 'i_distNext':
      go(ctx, r, 'i_distNext', {}, [...r.points, p]);
      ctx.say(ctx.msg('distTotal', { distance: n(pathLength([...r.points, p])) }));
      return;
    case 'i_areaFirst':
      go(ctx, r, 'i_areaNext', {}, [p]);
      return;
    case 'i_areaNext':
      go(ctx, r, 'i_areaNext', {}, [...r.points, p]);
      return;
    case 'i_mgVertex':
      go(ctx, r, 'i_mgEnd1', { vertex: p });
      return;
    case 'i_mgEnd1':
      go(ctx, r, 'i_mgEnd2', {}, [p]);
      return;
    case 'i_mgEnd2': {
      const v = d.vertex;
      const a = r.points[0];
      if (v && a) {
        const angle = between({ x: a.x - v.x, y: a.y - v.y }, { x: p.x - v.x, y: p.y - v.y });
        ctx.say(ctx.msg('mgAngleResult', { angle: acadAngle(angle) }));
      }
      done(ctx, r);
      return;
    }
    default:
      ctx.say(ctx.msg('badSelection'));
  }
}

export function inquiryNumber<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, value: number): void {
  void value;
  if (r.step === 'i_mgOption') ctx.say(ctx.msg('badKeyword'));
  else ctx.say(ctx.msg('badPoint'));
}

export function inquiryOption<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, key: string): void {
  const d = inquiryData(r);
  switch (r.step as InquiryStep) {
    case 'i_distSecond':
      if (key === 'M') go(ctx, r, 'i_distNext');
      return;
    case 'i_distNext':
    case 'i_areaNext':
      if (key === 'U') {
        if (r.points.length > 1) go(ctx, r, r.step as InquiryStep, {}, r.points.slice(0, -1));
        else ctx.say(ctx.msg('allUndone'));
      } else if (key === 'T') inquiryEnter(ctx, r);
      // Arc and Length segments need AutoCAD's arc / length input, which this screen has not.
      else ctx.say(ctx.msg('inquiryArcLength'));
      return;
    case 'i_areaFirst':
      if (key === 'O') go(ctx, r, 'i_areaObj');
      else if (key === 'A') go(ctx, r, 'i_areaFirst', { mode: 'add' });
      else if (key === 'S') go(ctx, r, 'i_areaFirst', { mode: 'sub' });
      else if (key === 'X') done(ctx, { ...r, flags: { ...r.flags, extra: { ...d, mode: null } } });
      return;
    case 'i_mgOption':
      switch (key) {
        case 'D':
          go(ctx, r, 'i_distFirst', {}, []);
          return;
        case 'R':
          go(ctx, r, 'i_mgRadius');
          return;
        case 'A':
          go(ctx, r, 'i_mgAngle');
          return;
        case 'AR':
          go(ctx, r, 'i_areaFirst', { mode: null, total: 0 }, []);
          return;
        case 'V':
          ctx.say(ctx.msg('mgVolume'));
          return;
        case 'X':
          ctx.finish(true);
          return;
      }
  }
}

export function inquiryEnter<R extends ExtraRun>(ctx: ExtraContext<R>, r: R): void {
  const d = inquiryData(r);
  switch (r.step as InquiryStep) {
    case 'i_distNext':
      ctx.say(ctx.msg('distTotal', { distance: n(pathLength(r.points)) }));
      done(ctx, r);
      return;
    case 'i_areaFirst':
      if (d.mode) done(ctx, { ...r, flags: { ...r.flags, extra: { ...d, mode: null } } });
      else go(ctx, r, 'i_areaObj');
      return;
    case 'i_areaNext':
      areaOfPoints(ctx, r);
      return;
    case 'i_areaObj':
      if (d.mode) go(ctx, r, 'i_areaFirst', {}, []);
      else done(ctx, r);
      return;
    case 'i_mgOption':
      go(ctx, r, 'i_distFirst', {}, []);
      return;
    case 'i_mgAngle':
      go(ctx, r, 'i_mgVertex');
      return;
    default:
      done(ctx, r);
  }
}

export function inquiryObject<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  r: R,
  index: number | null,
  at: Point,
): void {
  if (index === null || !ctx.pickable(index)) {
    ctx.say(ctx.msg('nothingThere'));
    return;
  }
  const g = geometryOf(ctx.scene, ctx.shown, index);
  const d = inquiryData(r);
  switch (r.step as InquiryStep) {
    case 'i_areaObj': {
      const found = objectArea(g);
      if (!found) {
        ctx.say(ctx.msg('areaNotObject'));
        return;
      }
      areaReport(ctx, r, found.area, found.length, found.word);
      if (!d.mode) done(ctx, r);
      return;
    }
    case 'i_mgRadius':
      if (g?.type === 'circle' || g?.type === 'arc') {
        ctx.say(
          ctx.msg('mgRadiusResult', { radius: n(g.radius) }),
          ctx.msg('mgDiameterResult', { diameter: n(g.radius * 2) }),
        );
        done(ctx, r);
      } else ctx.say(ctx.msg('mgNotArc'));
      return;
    case 'i_mgAngle': {
      if (g?.type === 'arc') {
        ctx.say(ctx.msg('mgAngleResult', { angle: acadAngle(arcTotal(g)) }));
        done(ctx, r);
        return;
      }
      const line = segmentNear(g, xyOf(at));
      if (!line) {
        ctx.say(ctx.msg('mgAngleObject'));
        return;
      }
      go(ctx, r, 'i_mgAngle2', { line, lineAt: xyOf(at) });
      return;
    }
    case 'i_mgAngle2': {
      const line = segmentNear(g, xyOf(at));
      if (!line || !d.line || !d.lineAt) {
        ctx.say(ctx.msg('mgAngleObject'));
        return;
      }
      const angle = angleOfLines(d.line, d.lineAt, line, xyOf(at));
      if (angle === null) ctx.say(ctx.msg('mgParallel'));
      else ctx.say(ctx.msg('mgAngleResult', { angle: acadAngle(angle) }));
      done(ctx, r);
      return;
    }
    default:
      return;
  }
}

export function inquirySketch(r: ExtraRun, at: Point): { points: Point[]; closed: boolean } | null {
  switch (r.step as InquiryStep) {
    case 'i_distSecond':
    case 'i_distNext':
    case 'i_mgEnd1':
      if (r.step === 'i_mgEnd1') {
        const v = inquiryData(r).vertex;
        return v ? { points: [v, at], closed: false } : null;
      }
      return r.points.length > 0 ? { points: [...r.points, at], closed: false } : null;
    case 'i_mgEnd2': {
      const v = inquiryData(r).vertex;
      const a = r.points[0];
      return v && a ? { points: [a, v, at], closed: false } : null;
    }
    case 'i_areaNext':
      return { points: [...r.points, at], closed: true };
    default:
      return null;
  }
}

// ---------- LIST ----------

function listLines<R extends ExtraRun>(ctx: ExtraContext<R>, index: number): string[] {
  const entity = ctx.scene.view.entities[index];
  if (!entity) return [];
  const g = geometryOf(ctx.scene, ctx.shown, index);
  const kind =
    entity.kind.toUpperCase() === 'INSERT' ? 'BLOCK REFERENCE' : entity.kind.toUpperCase();
  const at = (label: string, p: Xy) => ctx.msg('listPoint', { label, x: n(p.x), y: n(p.y) });
  const out = [
    ctx.msg('listHead', { kind, layer: ctx.layerNameOf(index) }),
    ctx.msg('listSpace'),
    ctx.msg('listHandle', { handle: entity.handle }),
  ];
  switch (g?.type) {
    case 'line': {
      const dx = g.end.x - g.start.x;
      const dy = g.end.y - g.start.y;
      out.push(
        at('from point', g.start),
        at('to point', g.end),
        ctx.msg('listLength', {
          length: n(Math.hypot(dx, dy)),
          angle: acadAngle(normalAngle((Math.atan2(dy, dx) * 180) / Math.PI)),
        }),
        ctx.msg('distDelta', { dx: n(dx), dy: n(dy) }),
      );
      break;
    }
    case 'polyline': {
      out.push(ctx.msg(g.closed ? 'listClosed' : 'listOpen'));
      if (g.closed) {
        out.push(
          ctx.msg('listArea', { area: n(polygonArea(g.points)) }),
          ctx.msg('listPerimeter', { length: n(polylineLength(g.points, true)) }),
        );
      } else {
        out.push(ctx.msg('listPolyLength', { length: n(polylineLength(g.points, false)) }));
      }
      for (const p of g.points.slice(0, LIST_VERTICES)) out.push(at('at point', p));
      if (g.points.length > LIST_VERTICES) {
        out.push(ctx.msg('listMore', { count: g.points.length - LIST_VERTICES }));
      }
      break;
    }
    case 'circle':
      out.push(
        at('center point', g.center),
        ctx.msg('listRadius', { radius: n(g.radius) }),
        ctx.msg('listCircumference', { length: n(2 * Math.PI * g.radius) }),
        ctx.msg('listArea', { area: n(Math.PI * g.radius * g.radius) }),
      );
      break;
    case 'arc': {
      const total = arcTotal(g);
      const angle = (p: Xy) =>
        acadAngle(normalAngle((Math.atan2(p.y - g.center.y, p.x - g.center.x) * 180) / Math.PI));
      out.push(
        at('center point', g.center),
        ctx.msg('listRadius', { radius: n(g.radius) }),
        ctx.msg('listArcAngles', { start: angle(g.start), end: angle(g.end) }),
        ctx.msg('listArcLength', {
          length: n((g.radius * total * Math.PI) / 180),
          total: acadAngle(total),
        }),
      );
      break;
    }
    case 'text':
      out.push(
        at('start point', g.at),
        ctx.msg('listTextHeight', { height: n(g.height) }),
        ctx.msg('listText', { text: g.text }),
        ctx.msg('listRotation', { angle: acadAngle(g.rotation) }),
      );
      break;
    case 'insert':
      if (g.name !== null) out.push(ctx.msg('listBlockName', { name: g.name }));
      if (g.at) {
        out.push(
          at('at point', g.at),
          ctx.msg('listScale', { x: n(g.scaleX ?? 1), y: n(g.scaleY ?? 1) }),
          ctx.msg('listRotation', { angle: acadAngle(g.rotation ?? 0) }),
        );
      } else out.push(ctx.msg('listNoInsert'));
      g.values.forEach((value) => out.push(ctx.msg('listAttribute', { value })));
      break;
    default:
      // What the view of the file does not carry is not invented.
      out.push(ctx.msg('listOnlyShape'));
  }
  return out;
}
