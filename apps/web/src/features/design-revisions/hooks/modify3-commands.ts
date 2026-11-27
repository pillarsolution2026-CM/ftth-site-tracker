import { acadNumber, type CommandId, type CommandOption, type Point } from '../model/cad-commands';
import {
  copyEdits,
  editHandle,
  pointsCurveEdit,
  rotateEdits,
  roundCoord,
  setCurveEdit,
  type CanvasEdit,
} from '../model/canvas-edit';
import { drawnBox } from '../model/entity-geometry';
import { chamfer, type Pt } from '../model/geometry';
import type { ExtraContext, ExtraRun } from './extra-commands';

/**
 * Round 3 Modify commands, second part (audit 4.2): ARRAYPOLAR, ARRAYPATH and CHAMFER, with
 * AutoCAD's prompts, options and defaults. The arrays are made as AutoCAD's «ASsociative = No»:
 * separate copies (`copy_item` and, for turned items, `rotate_item` of the copy's NEW- handle);
 * Rows, Levels and associative arrays stay in AutoCAD. CHAMFER cuts two lines / polyline ends
 * back by its distances (or a length and an angle) and draws the chamfer line between them.
 */

export const MODIFY3_COMMANDS: ReadonlySet<CommandId> = new Set<CommandId>([
  'arraypolar',
  'arraypath',
  'chamfer',
]);

export type Modify3PromptKey =
  | 'polarCenter'
  | 'arrayEdit'
  | 'polarItems'
  | 'polarBetween'
  | 'polarFill'
  | 'polarRotate'
  | 'pathCurve'
  | 'pathSpacing'
  | 'pathItems'
  | 'pathAlign'
  | 'chamFirst'
  | 'chamSecond'
  | 'chamDist1'
  | 'chamDist2'
  | 'chamLength'
  | 'chamAngle'
  | 'chamTrim';

export type Modify3Step =
  | 'm3_polarCenter'
  | 'm3_polarEdit'
  | 'm3_polarItems'
  | 'm3_polarBetween'
  | 'm3_polarFill'
  | 'm3_polarRotate'
  | 'm3_pathCurve'
  | 'm3_pathEdit'
  | 'm3_pathSpacing'
  | 'm3_pathItems'
  | 'm3_pathAlign'
  | 'm3_chamFirst'
  | 'm3_chamSecond'
  | 'm3_chamDist1'
  | 'm3_chamDist2'
  | 'm3_chamLength'
  | 'm3_chamAngle'
  | 'm3_chamTrim';

export const MODIFY3_OBJECT_STEPS: readonly string[] = [
  'm3_pathCurve',
  'm3_chamFirst',
  'm3_chamSecond',
];

/** The answers kept for the next time (AutoCAD keeps them in the drawing's variables). */
export interface Modify3Settings {
  polar: { items: number; fill: number; rotate: boolean };
  path: { align: boolean };
  chamfer: {
    d1: number;
    d2: number;
    length: number;
    angle: number;
    byAngle: boolean;
    trim: boolean;
  };
}

export const DEFAULT_MODIFY3_SETTINGS: Modify3Settings = {
  polar: { items: 6, fill: 360, rotate: true },
  path: { align: true },
  chamfer: { d1: 0, d2: 0, length: 0, angle: 0, byAngle: false, trim: true },
};

interface Modify3Data {
  center?: Point;
  items?: number;
  fill?: number;
  rotate?: boolean;
  path?: { points: Pt[]; closed: boolean };
  spacing?: number;
  align?: boolean;
  first?: { index: number; at: Point };
  multiple?: boolean;
  d1?: number;
}

const opt = (word: string, key: string): CommandOption => ({ word, key });
const md = (r: ExtraRun): Modify3Data => (r.flags.extra as Modify3Data | undefined) ?? {};
const yesNo = [opt('Yes', 'Y'), opt('No', 'N')];
/** An angle as AutoCAD shows it in a default: whole degrees without decimals. */
const angleText = (v: number) => String(roundCoord(v));

/** The settings the workspace keeps (`ExtraSettings.modify3`). */
const settingsOf = <R extends ExtraRun>(ctx: ExtraContext<R>): Modify3Settings =>
  ctx.settings.modify3 ?? DEFAULT_MODIFY3_SETTINGS;

function go<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  r: R,
  step: Modify3Step,
  patch: Partial<Modify3Data> = {},
): void {
  ctx.setRun({ ...r, step, flags: { ...r.flags, extra: { ...md(r), ...patch } } });
}

export const isModify3Command = (cmd: CommandId) => MODIFY3_COMMANDS.has(cmd);

export function modify3Prompt(
  r: ExtraRun,
  settings: Modify3Settings = DEFAULT_MODIFY3_SETTINGS,
): { key: Modify3PromptKey; options: CommandOption[]; fallback: string | null } | null {
  const d = md(r);
  const c = settings.chamfer;
  const p = (
    key: Modify3PromptKey,
    options: CommandOption[] = [],
    fallback: string | null = null,
  ) => ({
    key,
    options,
    fallback,
  });
  switch (r.step as Modify3Step) {
    case 'm3_polarCenter':
      return p('polarCenter', [opt('Base point', 'B'), opt('Axis of rotation', 'A')]);
    case 'm3_polarEdit':
      return p(
        'arrayEdit',
        [
          opt('ASsociative', 'AS'),
          opt('Base point', 'B'),
          opt('Items', 'I'),
          opt('Angle between', 'A'),
          opt('Fill angle', 'F'),
          opt('ROWs', 'ROW'),
          opt('Levels', 'L'),
          opt('ROTate items', 'ROT'),
          opt('eXit', 'X'),
        ],
        'eXit',
      );
    case 'm3_polarItems':
      return p('polarItems', [opt('Expression', 'E')], String(d.items ?? 6));
    case 'm3_polarBetween':
      return p('polarBetween', [opt('EXpression', 'EX')], angleText(polarStep(d)));
    case 'm3_polarFill':
      return p('polarFill', [opt('EXpression', 'EX')], angleText(d.fill ?? 360));
    case 'm3_polarRotate':
      return p('polarRotate', yesNo, (d.rotate ?? true) ? 'Yes' : 'No');
    case 'm3_pathCurve':
      return p('pathCurve');
    case 'm3_pathEdit':
      return p(
        'arrayEdit',
        [
          opt('ASsociative', 'AS'),
          opt('Method', 'M'),
          opt('Base point', 'B'),
          opt('Tangent direction', 'T'),
          opt('Items', 'I'),
          opt('Rows', 'R'),
          opt('Levels', 'L'),
          opt('Align items', 'A'),
          opt('Z direction', 'Z'),
          opt('eXit', 'X'),
        ],
        'eXit',
      );
    case 'm3_pathSpacing':
      return p('pathSpacing', [opt('Expression', 'E')], acadNumber(d.spacing ?? 0));
    case 'm3_pathItems':
      return p('pathItems', [opt('Expression', 'E')], String(d.items ?? 1));
    case 'm3_pathAlign':
      return p('pathAlign', yesNo, (d.align ?? true) ? 'Yes' : 'No');
    case 'm3_chamFirst':
      return p('chamFirst', [
        opt('Undo', 'U'),
        opt('Polyline', 'P'),
        opt('Distance', 'D'),
        opt('Angle', 'A'),
        opt('Trim', 'T'),
        opt('mEthod', 'E'),
        opt('Multiple', 'M'),
      ]);
    case 'm3_chamSecond':
      return p('chamSecond', [opt('Distance', 'D'), opt('Angle', 'A'), opt('Method', 'M')]);
    case 'm3_chamDist1':
      return p('chamDist1', [], acadNumber(c.d1));
    case 'm3_chamDist2':
      return p('chamDist2', [], acadNumber(d.d1 ?? c.d2));
    case 'm3_chamLength':
      return p('chamLength', [], acadNumber(c.length));
    case 'm3_chamAngle':
      return p('chamAngle', [], angleText(c.angle));
    case 'm3_chamTrim':
      return p('chamTrim', [opt('Trim', 'T'), opt('No trim', 'N')], c.trim ? 'Trim' : 'No trim');
    default:
      return null;
  }
}

/** The angle between two items of a polar array (a full circle: none twice on one place). */
function polarStep(d: Modify3Data): number {
  const items = d.items ?? 6;
  const fill = d.fill ?? 360;
  if (items < 2) return 0;
  return Math.abs(fill) >= 360 - 1e-9 ? fill / items : fill / (items - 1);
}

function chamferSettingsLine<R extends ExtraRun>(ctx: ExtraContext<R>): string {
  const c = settingsOf(ctx).chamfer;
  const mode = c.trim ? 'TRIM' : 'NOTRIM';
  return c.byAngle
    ? ctx.msg('chamferSettingsAngle', {
        mode,
        length: acadNumber(c.length),
        angle: angleText(c.angle),
      })
    : ctx.msg('chamferSettings', { mode, d1: acadNumber(c.d1), d2: acadNumber(c.d2) });
}

export function modify3Begin<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  cmd: CommandId,
  fresh: (step: string) => R,
): R | null {
  if (cmd === 'chamfer') {
    ctx.say(chamferSettingsLine(ctx));
    ctx.setSelection(new Set());
    const run = fresh('m3_chamFirst');
    ctx.setRun(run);
    return run;
  }
  const r = fresh('select');
  if (ctx.handles.length > 0) return modify3AfterSelect(ctx, r);
  ctx.setRun(r);
  return r;
}

export function modify3AfterSelect<R extends ExtraRun>(ctx: ExtraContext<R>, r: R): R | null {
  if (r.cmd === 'arraypolar') {
    ctx.say(ctx.msg('arrayPolarSettings'));
    const s = settingsOf(ctx).polar;
    go(ctx, r, 'm3_polarCenter', { items: s.items, fill: s.fill, rotate: s.rotate });
    return r;
  }
  if (r.cmd === 'arraypath') {
    ctx.say(ctx.msg('arrayPathSettings'));
    go(ctx, r, 'm3_pathCurve', { align: settingsOf(ctx).path.align });
    return r;
  }
  ctx.finish();
  return null;
}

/** Centre of the picked objects' box (the point each polar item turns / a path item moves). */
function selectionCenter<R extends ExtraRun>(
  ctx: ExtraContext<R>,
): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const i of ctx.selection) {
    const b = drawnBox(ctx.scene, ctx.shown, i);
    minX = Math.min(minX, b.minX);
    minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY };
}

/** Each copy of the picked objects, moved by (dx, dy) and turned `angle` about `about`. */
function placedCopies(
  handles: readonly string[],
  dx: number,
  dy: number,
  angle: number,
  about: Point,
): CanvasEdit[] {
  const copies = copyEdits(handles, dx, dy);
  if (Math.abs(angle) < 1e-9) return copies;
  const named = copies.map((c) => editHandle(c)).filter((h): h is string => h !== undefined);
  return [...copies, ...rotateEdits(named, about.x, about.y, angle)];
}

function polarDone<R extends ExtraRun>(ctx: ExtraContext<R>, r: R): void {
  const d = md(r);
  const center = d.center;
  const items = d.items ?? 6;
  const fill = d.fill ?? 360;
  const rotate = d.rotate ?? true;
  const mid = selectionCenter(ctx);
  if (!center || !mid || items < 2) {
    ctx.finish();
    return;
  }
  const step = polarStep(d);
  const edits: CanvasEdit[] = [];
  for (let i = 1; i < items; i++) {
    const angle = step * i;
    if (rotate) edits.push(...placedCopies(ctx.handles, 0, 0, angle, center));
    else {
      // Not turned: each copy is moved where its centre goes round the array's centre.
      const a = (angle * Math.PI) / 180;
      const x = center.x + (mid.x - center.x) * Math.cos(a) - (mid.y - center.y) * Math.sin(a);
      const y = center.y + (mid.x - center.x) * Math.sin(a) + (mid.y - center.y) * Math.cos(a);
      edits.push(...copyEdits(ctx.handles, x - mid.x, y - mid.y));
    }
  }
  ctx.add(edits);
  ctx.setSettings({ modify3: { ...settingsOf(ctx), polar: { items, fill, rotate } } });
  ctx.say(ctx.msg('arrayPolarCount', { items }));
  ctx.finish();
}

/** Length of a path and the point / direction (degrees) at a distance along it. */
function pathWalker(path: { points: Pt[]; closed: boolean }) {
  const pts =
    path.closed && path.points.length > 2 ? [...path.points, path.points[0] as Pt] : path.points;
  const lengths: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Pt;
    const b = pts[i] as Pt;
    lengths.push((lengths[i - 1] as number) + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = lengths[lengths.length - 1] ?? 0;
  const at = (s: number): { p: Point; deg: number } => {
    let i = 1;
    while (i < pts.length - 1 && (lengths[i] as number) < s) i++;
    const a = pts[i - 1] as Pt;
    const b = (pts[i] ?? a) as Pt;
    const seg = (lengths[i] as number) - (lengths[i - 1] as number);
    const t = seg > 0 ? (s - (lengths[i - 1] as number)) / seg : 0;
    return {
      p: { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t },
      deg: (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI,
    };
  };
  return { total, at };
}

function pathDone<R extends ExtraRun>(ctx: ExtraContext<R>, r: R): void {
  const d = md(r);
  if (!d.path || !d.spacing || d.spacing <= 0) {
    ctx.finish();
    return;
  }
  const walk = pathWalker(d.path);
  const items = Math.max(1, d.items ?? 1);
  const start = walk.at(0);
  const edits: CanvasEdit[] = [];
  for (let i = 1; i < items; i++) {
    const s = d.spacing * i;
    if (s > walk.total + 1e-9) break;
    const here = walk.at(s);
    const turn = d.align ? here.deg - start.deg : 0;
    edits.push(
      ...placedCopies(ctx.handles, here.p.x - start.p.x, here.p.y - start.p.y, turn, here.p),
    );
  }
  ctx.add(edits);
  ctx.setSettings({ modify3: { ...settingsOf(ctx), path: { align: d.align ?? true } } });
  ctx.say(ctx.msg('arrayPathCount', { items }));
  ctx.finish();
}

export function modify3Point<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, p: Point): void {
  if (r.step === 'm3_polarCenter') {
    go(ctx, r, 'm3_polarEdit', { center: p });
    return;
  }
  ctx.say(ctx.msg('badPoint'));
}

export function modify3Number<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, value: number): void {
  const d = md(r);
  const c = settingsOf(ctx).chamfer;
  const chamferSet = (patch: Partial<Modify3Settings['chamfer']>) =>
    ctx.setSettings({ modify3: { ...settingsOf(ctx), chamfer: { ...c, ...patch } } });
  switch (r.step as Modify3Step) {
    case 'm3_polarItems':
      if (!Number.isInteger(value) || value < 2) ctx.say(ctx.msg('arrayItemsBad'));
      else go(ctx, r, 'm3_polarEdit', { items: value });
      return;
    case 'm3_polarBetween': {
      const items = d.items ?? 6;
      const fill =
        Math.abs(value * items) >= 360 - 1e-9 && Math.abs(value * items) <= 360 + 1e-9
          ? 360
          : value * (items - 1);
      go(ctx, r, 'm3_polarEdit', { fill });
      return;
    }
    case 'm3_polarFill':
      if (value === 0 || Math.abs(value) > 360) ctx.say(ctx.msg('arrayFillBad'));
      else go(ctx, r, 'm3_polarEdit', { fill: value });
      return;
    case 'm3_pathSpacing':
      if (!(value > 0)) ctx.say(ctx.msg('badDistance'));
      else {
        const most = d.path ? Math.floor(pathWalker(d.path).total / value + 1e-9) + 1 : 1;
        go(ctx, r, 'm3_pathItems', { spacing: value, items: most });
      }
      return;
    case 'm3_pathItems':
      if (!Number.isInteger(value) || value < 1) ctx.say(ctx.msg('arrayItemsBad'));
      else go(ctx, r, 'm3_pathEdit', { items: value });
      return;
    case 'm3_chamDist1':
      if (value < 0) ctx.say(ctx.msg('badDistance'));
      else go(ctx, r, 'm3_chamDist2', { d1: value });
      return;
    case 'm3_chamDist2':
      if (value < 0) ctx.say(ctx.msg('badDistance'));
      else {
        chamferSet({ d1: d.d1 ?? c.d1, d2: value, byAngle: false });
        go(ctx, r, 'm3_chamFirst');
      }
      return;
    case 'm3_chamLength':
      if (value < 0) ctx.say(ctx.msg('badDistance'));
      else {
        chamferSet({ length: value });
        go(ctx, r, 'm3_chamAngle');
      }
      return;
    case 'm3_chamAngle':
      chamferSet({ angle: value, byAngle: true });
      go(ctx, r, 'm3_chamFirst');
      return;
    default:
      ctx.say(ctx.msg('badPoint'));
  }
}

export function modify3Option<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, key: string): void {
  const d = md(r);
  const c = settingsOf(ctx).chamfer;
  switch (r.step as Modify3Step) {
    case 'm3_polarCenter':
      ctx.say(ctx.msg('arrayNotHere'));
      return;
    case 'm3_polarEdit':
      if (key === 'I') go(ctx, r, 'm3_polarItems');
      else if (key === 'A') go(ctx, r, 'm3_polarBetween');
      else if (key === 'F') go(ctx, r, 'm3_polarFill');
      else if (key === 'ROT') go(ctx, r, 'm3_polarRotate');
      else if (key === 'X') polarDone(ctx, r);
      else ctx.say(ctx.msg('arrayNotHere'));
      return;
    case 'm3_polarRotate':
      go(ctx, r, 'm3_polarEdit', { rotate: key === 'Y' });
      return;
    case 'm3_pathEdit':
      if (key === 'I') go(ctx, r, 'm3_pathSpacing');
      else if (key === 'A') go(ctx, r, 'm3_pathAlign');
      else if (key === 'X') pathDone(ctx, r);
      else ctx.say(ctx.msg('arrayNotHere'));
      return;
    case 'm3_pathAlign':
      go(ctx, r, 'm3_pathEdit', { align: key === 'Y' });
      return;
    case 'm3_chamFirst':
    case 'm3_chamSecond':
      if (key === 'D') go(ctx, r, 'm3_chamDist1', { d1: c.d1 });
      else if (key === 'A') go(ctx, r, 'm3_chamLength');
      else if (key === 'T') go(ctx, r, 'm3_chamTrim');
      else if (key === 'M' && r.step === 'm3_chamFirst') {
        go(ctx, r, 'm3_chamFirst', { multiple: true });
      } else ctx.say(ctx.msg('chamferNotHere'));
      return;
    case 'm3_chamTrim':
      ctx.setSettings({ modify3: { ...settingsOf(ctx), chamfer: { ...c, trim: key === 'T' } } });
      go(ctx, r, 'm3_chamFirst');
      return;
    default:
      void d;
  }
}

/** Enter: the default of the prompt (AutoCAD's <…>). */
export function modify3Enter<R extends ExtraRun>(ctx: ExtraContext<R>, r: R): void {
  const d = md(r);
  const c = settingsOf(ctx).chamfer;
  switch (r.step as Modify3Step) {
    case 'm3_polarEdit':
      polarDone(ctx, r);
      return;
    case 'm3_pathEdit':
      pathDone(ctx, r);
      return;
    case 'm3_polarItems':
    case 'm3_polarBetween':
    case 'm3_polarFill':
    case 'm3_polarRotate':
      go(ctx, r, 'm3_polarEdit');
      return;
    case 'm3_pathSpacing':
      modify3Number(ctx, r, d.spacing ?? 0);
      return;
    case 'm3_pathItems':
    case 'm3_pathAlign':
      go(ctx, r, 'm3_pathEdit');
      return;
    case 'm3_chamDist1':
      modify3Number(ctx, r, c.d1);
      return;
    case 'm3_chamDist2':
      modify3Number(ctx, r, d.d1 ?? c.d2);
      return;
    case 'm3_chamLength':
      modify3Number(ctx, r, c.length);
      return;
    case 'm3_chamAngle':
      modify3Number(ctx, r, c.angle);
      return;
    case 'm3_chamTrim':
      go(ctx, r, 'm3_chamFirst');
      return;
    default:
      ctx.finish();
  }
}

export function modify3Object<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  r: R,
  index: number | null,
  at: Point,
  shift = false,
): void {
  if (index === null || !ctx.pickable(index)) {
    ctx.say(ctx.msg('nothingThere'));
    return;
  }
  const geom = ctx.curveGeom(index);
  if (r.step === 'm3_pathCurve') {
    if (!geom) {
      ctx.say(ctx.msg('notCurve'));
      return;
    }
    const walk = pathWalker(geom);
    const box = selectionCenter(ctx);
    // AutoCAD's first spacing: one and a half times the objects' size.
    const spacing = roundCoord(Math.max(box ? Math.max(box.w, box.h) * 1.5 : 1, 1e-6));
    const items = Math.floor(walk.total / spacing + 1e-9) + 1;
    go(ctx, r, 'm3_pathEdit', { path: geom, spacing, items });
    return;
  }
  if (r.step === 'm3_chamFirst') {
    if (!geom) {
      ctx.say(ctx.msg('notCurve'));
      return;
    }
    ctx.setSelection(new Set([index]));
    go(ctx, r, 'm3_chamSecond', { first: { index, at } });
    return;
  }
  if (r.step !== 'm3_chamSecond') return;
  const d = md(r);
  const first = d.first;
  const a = first ? ctx.curveGeom(first.index) : null;
  const firstHandle = first ? ctx.scene.view.entities[first.index]?.handle : undefined;
  const handle = ctx.scene.view.entities[index]?.handle;
  if (!first || !a || !geom || !firstHandle || !handle) {
    ctx.say(ctx.msg('notCurve'));
    return;
  }
  if (firstHandle === handle) {
    ctx.say(ctx.msg('sameObject'));
    return;
  }
  const c = settingsOf(ctx).chamfer;
  let d1 = c.d1;
  let d2 = c.d2;
  if (c.byAngle) {
    d1 = c.length;
    d2 = c.length * Math.tan((c.angle * Math.PI) / 180);
  }
  // Shift-select: a sharp corner (distances 0), as AutoCAD.
  if (shift) d1 = d2 = 0;
  try {
    const [p, q, line] = chamfer(
      { points: a.points, closed: a.closed, pick: [first.at.x, first.at.y] },
      { points: geom.points, closed: geom.closed, pick: [at.x, at.y] },
      d1,
      d2,
    );
    const edits: CanvasEdit[] = [];
    if (c.trim) edits.push(setCurveEdit(firstHandle, p, false), setCurveEdit(handle, q, false));
    if (line.length >= 2) edits.push(pointsCurveEdit(ctx.layerNameOf(first.index), line, false));
    if (edits.length > 0) ctx.add(edits);
    if (d.multiple) {
      ctx.setSelection(new Set());
      go(ctx, r, 'm3_chamFirst', { first: undefined });
    } else ctx.finish();
  } catch (caught) {
    ctx.geometryMessage(caught);
  }
}
