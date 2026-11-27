import { applyAffine } from '../model/affine';
import {
  acadNumber,
  COMMANDS,
  type CommandId,
  type CommandOption,
  type Point,
} from '../model/cad-commands';
import { boxOf } from '../model/drawing-scene';
import type { Bounds } from '../model/view-transform';
import type { ExtraContext, ExtraRun } from './extra-commands';

/**
 * ZOOM, PAN, REGEN and the typed U / UNDO / REDO / OOPS (round 3, audit 4.1 / 4.2), on the same
 * command line, with AutoCAD's prompts, options and defaults. ZOOM and PAN also run inside another
 * command when typed with an apostrophe (`'ZOOM`): AutoCAD's «>>» prompts, then «Resuming … command».
 */

export const VIEW_COMMANDS: ReadonlySet<CommandId> = new Set<CommandId>([
  'zoom',
  'pan',
  'regen',
  'u',
  'undo',
  'redo',
  'oops',
]);

/** The view of the drawing, as the commands see it (drawing units). */
export interface ZoomView {
  /** Centre of the view and the width / height of the drawing shown. */
  current: () => { cx: number; cy: number; width: number; height: number };
  /** Shows this centre and height (the view before is kept for ZOOM Previous). */
  show: (cx: number, cy: number, height: number) => void;
  /** ZOOM All / Extents: the whole drawing. */
  extents: () => void;
  /** The height ZOOM Extents shows: ZOOM `n` scales against it (the drawing has no limits). */
  extentsHeight: () => number;
  /** ZOOM Previous: false when no view was kept. */
  previous: () => boolean;
  regen: () => void;
}

/** U / UNDO / REDO / OOPS typed: the workspace's one history (item 13). */
export interface UndoControl {
  /** Takes back `count` steps; their names, newest first. */
  undo: (count: number) => string[];
  redo: () => string | null;
  steps: () => number;
  /** UNDO Mark / Back. */
  mark: () => void;
  markAt: () => number | null;
  clearMark: () => void;
  /** OOPS: the objects of the last ERASE come back; how many. */
  oops: () => number;
}

export type ViewStep =
  | 'v_zoom'
  | 'v_zoomFirst'
  | 'v_zoomOther'
  | 'v_zoomCenter'
  | 'v_zoomMag'
  | 'v_zoomScale'
  | 'v_panBase'
  | 'v_panSecond'
  | 'v_undo'
  | 'v_undoAll';

export type ViewPromptKey =
  | 'zoomCorner'
  | 'zoomFirst'
  | 'zoomOther'
  | 'zoomCenter'
  | 'zoomMagnify'
  | 'zoomScale'
  | 'panBase'
  | 'panSecond'
  | 'undoCount'
  | 'undoEverything';

export const VIEW_OBJECT_STEPS: readonly string[] = [];
export const VIEW_TRACKED: readonly string[] = ['v_zoomOther', 'v_panSecond'];

/** Per run. */
interface ViewData {
  at?: Point;
  /** ZOOM Center: the height of the view when the centre was given (the default). */
  height?: number;
  /** The command a transparent ZOOM / PAN runs inside (it goes on after). */
  outer?: ExtraRun;
}

interface Prompt {
  key: ViewPromptKey;
  options: CommandOption[];
  fallback: string | null;
}

const opt = (word: string, key: string): CommandOption => ({ word, key });
const viewData = (r: ExtraRun): ViewData => (r.flags.extra as ViewData | undefined) ?? {};
const go = <R extends ExtraRun>(ctx: ExtraContext<R>, r: R, step: ViewStep, patch: ViewData = {}) =>
  ctx.setRun({ ...r, step, flags: { ...r.flags, extra: { ...viewData(r), ...patch } } });

export const isViewCommand = (cmd: CommandId) => VIEW_COMMANDS.has(cmd);

/** The «>>» of a transparent command, null otherwise. */
export const transparentLabel = (r: ExtraRun | null): string | null =>
  r && isViewCommand(r.cmd) && viewData(r).outer ? '>>' : null;

const ZOOM_OPTIONS: readonly CommandOption[] = [
  opt('All', 'A'),
  opt('Center', 'C'),
  opt('Dynamic', 'D'),
  opt('Extents', 'E'),
  opt('Previous', 'P'),
  opt('Scale', 'S'),
  opt('Window', 'W'),
  opt('Object', 'O'),
];
const UNDO_OPTIONS: readonly CommandOption[] = [
  opt('Auto', 'A'),
  opt('Control', 'C'),
  opt('BEgin', 'BE'),
  opt('End', 'E'),
  opt('Mark', 'M'),
  opt('Back', 'B'),
];

// ---------- prompts ----------

export function viewPrompt(r: ExtraRun): Prompt | null {
  const p = (
    key: ViewPromptKey,
    options: readonly CommandOption[] = [],
    fallback: string | null = null,
  ) => ({
    key,
    options: [...options],
    fallback,
  });
  switch (r.step as ViewStep) {
    case 'v_zoom':
      return p('zoomCorner', ZOOM_OPTIONS, 'real time');
    case 'v_zoomFirst':
      return p('zoomFirst');
    case 'v_zoomOther':
      return p('zoomOther');
    case 'v_zoomCenter':
      return p('zoomCenter');
    case 'v_zoomMag': {
      const height = viewData(r).height;
      return p('zoomMagnify', [], height !== undefined ? acadNumber(height) : null);
    }
    case 'v_zoomScale':
      return p('zoomScale');
    case 'v_panBase':
      return p('panBase');
    case 'v_panSecond':
      return p('panSecond');
    case 'v_undo':
      return p('undoCount', UNDO_OPTIONS, '1');
    case 'v_undoAll':
      return p('undoEverything', [opt('Yes', 'Y'), opt('No', 'N')], 'Y');
  }
  return null;
}

// ---------- start ----------

/** The command ends: a transparent one hands the command line back to the one it ran in. */
function done<R extends ExtraRun>(ctx: ExtraContext<R>, r: R) {
  const outer = viewData(r).outer as R | undefined;
  if (outer) {
    ctx.say(ctx.msg('resuming', { name: COMMANDS[outer.cmd].name }));
    ctx.setRun(outer);
    return;
  }
  ctx.finish(true);
}

/** Starts ZOOM / PAN / … ; `outer`: typed with an apostrophe inside that command. */
export function viewBegin<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  cmd: CommandId,
  fresh: (step: string) => R,
  outer: R | null = null,
): R | null {
  const start = (step: ViewStep): R => {
    const r = fresh(step);
    const run = { ...r, flags: { ...r.flags, extra: outer ? { outer } : {} } };
    ctx.setRun(run);
    return run;
  };
  const u = ctx.undo;
  switch (cmd) {
    case 'zoom':
      return start('v_zoom');
    case 'pan':
      return start('v_panBase');
    case 'regen':
      ctx.say(ctx.msg('regenerating'));
      ctx.view?.regen();
      ctx.finish(true);
      return null;
    case 'u':
      undoSteps(ctx, 1);
      ctx.finish(true);
      return null;
    case 'undo':
      ctx.say(ctx.msg('undoSettings'));
      return start('v_undo');
    case 'redo': {
      const label = u?.redo() ?? null;
      ctx.say(label ?? ctx.msg('nothingToRedo'));
      ctx.finish(true);
      return null;
    }
    case 'oops': {
      const count = u?.oops() ?? 0;
      if (count === 0) ctx.say(ctx.msg('oopsNothing'));
      ctx.finish();
      return null;
    }
    default:
      return null;
  }
}

function undoSteps<R extends ExtraRun>(ctx: ExtraContext<R>, count: number) {
  const u = ctx.undo;
  if (!u) return;
  const all = u.steps();
  const labels = u.undo(count);
  if (labels.length > 0) ctx.say(...labels);
  if (count > all || labels.length === 0) ctx.say(ctx.msg('nothingToUndo'));
  const mark = u.markAt();
  if (mark !== null && all - labels.length < mark) u.clearMark();
}

// ---------- entries ----------

/** The window of two corners, shown with the canvas' proportions (AutoCAD's ZOOM Window). */
function showWindow<R extends ExtraRun>(ctx: ExtraContext<R>, box: Bounds): boolean {
  const view = ctx.view;
  if (!view) return false;
  const w = box.maxX - box.minX;
  const h = box.maxY - box.minY;
  if (!(w > 0 || h > 0)) {
    ctx.say(ctx.msg('zoomWindowBad'));
    return false;
  }
  const now = view.current();
  const aspect = now.width > 0 && now.height > 0 ? now.height / now.width : 1;
  view.show((box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2, Math.max(h, w * aspect));
  return true;
}

const cornersBox = (a: Point, b: Point): Bounds => ({
  minX: Math.min(a.x, b.x),
  minY: Math.min(a.y, b.y),
  maxX: Math.max(a.x, b.x),
  maxY: Math.max(a.y, b.y),
});

export function viewPoint<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, p: Point): void {
  const d = viewData(r);
  const view = ctx.view;
  switch (r.step as ViewStep) {
    case 'v_zoom':
    case 'v_zoomFirst':
      go(ctx, r, 'v_zoomOther', { at: p });
      return;
    case 'v_zoomOther':
      if (d.at && showWindow(ctx, cornersBox(d.at, p))) done(ctx, r);
      return;
    case 'v_zoomCenter':
      go(ctx, r, 'v_zoomMag', { at: p, height: view?.current().height });
      return;
    case 'v_panBase':
      go(ctx, r, 'v_panSecond', { at: p });
      return;
    case 'v_panSecond':
      if (d.at && view) panBy(ctx, p.x - d.at.x, p.y - d.at.y);
      done(ctx, r);
      return;
    default:
      ctx.say(ctx.msg('zoomRequires'));
  }
}

function panBy<R extends ExtraRun>(ctx: ExtraContext<R>, dx: number, dy: number) {
  const view = ctx.view;
  if (!view) return;
  const now = view.current();
  // The drawing moves by the displacement: the view's centre goes the other way.
  view.show(now.cx - dx, now.cy - dy, now.height);
}

/** ZOOM `n` (against the whole drawing) or `nX` (against the view now). */
function zoomFactor<R extends ExtraRun>(ctx: ExtraContext<R>, factor: number, relative: boolean) {
  const view = ctx.view;
  if (!view) return false;
  if (!(factor > 0)) {
    ctx.say(ctx.msg('zoomPositive'));
    return false;
  }
  const now = view.current();
  const base = relative ? now.height : view.extentsHeight();
  view.show(now.cx, now.cy, base / factor);
  return true;
}

export function viewNumber<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, value: number): void {
  const d = viewData(r);
  switch (r.step as ViewStep) {
    case 'v_zoom':
    case 'v_zoomScale':
      if (zoomFactor(ctx, value, false)) done(ctx, r);
      return;
    case 'v_zoomMag': {
      // A number is the height of the view (AutoCAD); nX a magnification.
      if (!(value > 0)) {
        ctx.say(ctx.msg('zoomPositive'));
        return;
      }
      if (d.at) ctx.view?.show(d.at.x, d.at.y, value);
      done(ctx, r);
      return;
    }
    case 'v_undo': {
      if (!(value >= 1 && Number.isInteger(value))) {
        ctx.say(ctx.msg('badValue'));
        return;
      }
      undoSteps(ctx, value);
      ctx.finish(true);
      return;
    }
    case 'v_panBase':
    case 'v_panSecond':
      ctx.say(ctx.msg('badPoint'));
      return;
    default:
      ctx.say(ctx.msg('zoomRequires'));
  }
}

/** A word that is not an option: ZOOM's `nX` / `nXP`. True when it was taken. */
export function viewWord<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, word: string): boolean {
  const step = r.step as ViewStep;
  if (step !== 'v_zoom' && step !== 'v_zoomScale' && step !== 'v_zoomMag') return false;
  const m = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(XP|X)$/.exec(word.toUpperCase());
  if (!m) {
    ctx.say(ctx.msg('zoomRequires'));
    return true;
  }
  if (m[2] === 'XP') {
    ctx.say(ctx.msg('zoomPaper'));
    return true;
  }
  const factor = Number(m[1]);
  if (step === 'v_zoomMag') {
    const d = viewData(r);
    const view = ctx.view;
    if (!(factor > 0)) {
      ctx.say(ctx.msg('zoomPositive'));
      return true;
    }
    if (d.at && view) view.show(d.at.x, d.at.y, view.current().height / factor);
    done(ctx, r);
    return true;
  }
  if (zoomFactor(ctx, factor, true)) done(ctx, r);
  return true;
}

export function viewOption<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, key: string): void {
  const view = ctx.view;
  const u = ctx.undo;
  if (r.step === 'v_zoom') {
    switch (key) {
      case 'A':
      case 'E':
        view?.extents();
        done(ctx, r);
        return;
      case 'C':
        go(ctx, r, 'v_zoomCenter');
        return;
      case 'D':
        // AutoCAD's view box of ZOOM Dynamic is not on this screen: say so, never fake it.
        ctx.say(ctx.msg('zoomDynamic'));
        return;
      case 'P':
        if (!view?.previous()) ctx.say(ctx.msg('noPreviousView'));
        done(ctx, r);
        return;
      case 'S':
        go(ctx, r, 'v_zoomScale');
        return;
      case 'W':
        go(ctx, r, 'v_zoomFirst');
        return;
      case 'O':
        if (viewData(r).outer) {
          ctx.say(ctx.msg('zoomObjectInside'));
          return;
        }
        if (ctx.handles.length > 0) {
          zoomToSelection(ctx);
          ctx.finish(true);
          return;
        }
        ctx.setRun({ ...r, step: 'select' });
        return;
    }
    return;
  }
  if (r.step === 'v_undo') {
    switch (key) {
      case 'M':
        u?.mark();
        ctx.finish(true);
        return;
      case 'B': {
        const mark = u?.markAt() ?? null;
        const steps = u?.steps() ?? 0;
        if (mark !== null && mark <= steps) {
          const labels = u?.undo(steps - mark) ?? [];
          if (labels.length > 0) ctx.say(...labels);
          ctx.say(ctx.msg('markEncountered'));
          u?.clearMark();
          ctx.finish(true);
          return;
        }
        go(ctx, r, 'v_undoAll');
        return;
      }
      default: {
        const word = UNDO_OPTIONS.find((o) => o.key === key)?.word ?? key;
        ctx.say(ctx.msg('undoOptionNotHere', { option: word }));
        return;
      }
    }
  }
  if (r.step === 'v_undoAll') {
    if (key === 'Y') undoSteps(ctx, u?.steps() ?? 0);
    ctx.finish(true);
  }
}

export function viewEnter<R extends ExtraRun>(ctx: ExtraContext<R>, r: R): void {
  const d = viewData(r);
  switch (r.step as ViewStep) {
    case 'v_zoom':
      // <real time>: the mouse wheel zooms at the pointer at any time on this screen.
      ctx.say(ctx.msg('zoomRealtime'));
      done(ctx, r);
      return;
    case 'v_zoomMag':
      if (d.at && ctx.view) ctx.view.show(d.at.x, d.at.y, ctx.view.current().height);
      done(ctx, r);
      return;
    case 'v_panSecond':
      // Enter: the base point is the displacement (as MOVE).
      if (d.at) panBy(ctx, d.at.x, d.at.y);
      done(ctx, r);
      return;
    case 'v_undo':
      undoSteps(ctx, 1);
      ctx.finish(true);
      return;
    case 'v_undoAll':
      undoSteps(ctx, ctx.undo?.steps() ?? 0);
      ctx.finish(true);
      return;
    default:
      done(ctx, r);
  }
}

/** ZOOM Object after «Select objects:». */
export function viewAfterSelect<R extends ExtraRun>(ctx: ExtraContext<R>): null {
  if (ctx.handles.length > 0) zoomToSelection(ctx);
  ctx.finish();
  return null;
}

function zoomToSelection<R extends ExtraRun>(ctx: ExtraContext<R>) {
  let box: Bounds | null = null;
  const grow = (x: number, y: number) => {
    box = box
      ? {
          minX: Math.min(box.minX, x),
          minY: Math.min(box.minY, y),
          maxX: Math.max(box.maxX, x),
          maxY: Math.max(box.maxY, y),
        }
      : { minX: x, minY: y, maxX: x, maxY: y };
  };
  for (const index of ctx.selection) {
    const curve = ctx.shown.curveOf.get(index);
    if (curve) {
      for (const p of curve.points) grow(p[0], p[1]);
      continue;
    }
    const b = boxOf(ctx.scene, index);
    const moved = ctx.shown.transformOf.get(index);
    for (const [x, y] of [
      [b.minX, b.minY],
      [b.maxX, b.minY],
      [b.minX, b.maxY],
      [b.maxX, b.maxY],
    ] as const) {
      const q = moved ? applyAffine(moved, x, y) : { x, y };
      grow(q.x, q.y);
    }
  }
  const found = box as Bounds | null;
  if (found) showWindow(ctx, found);
}

export function viewSketch(r: ExtraRun, at: Point): { points: Point[]; closed: boolean } | null {
  const d = viewData(r);
  if (!d.at) return null;
  if (r.step === 'v_zoomOther') {
    const a = d.at;
    return {
      points: [a, { x: at.x, y: a.y }, at, { x: a.x, y: at.y }],
      closed: true,
    };
  }
  if (r.step === 'v_panSecond') return { points: [d.at, at], closed: false };
  return null;
}
