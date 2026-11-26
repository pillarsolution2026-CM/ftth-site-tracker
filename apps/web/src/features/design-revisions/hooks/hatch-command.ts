import type {
  GradientPattern,
  HatchDrawOrder,
  HatchIslandStyle,
  HatchLinePattern,
} from '@ftth/shared';
import { MAX_HATCH_LOOPS } from '@ftth/shared';
import { boxThrough } from '../model/affine';
import { acadNumber, type CommandId, type CommandOption, type Point } from '../model/cad-commands';
import { roundCoord, type CanvasEdit } from '../model/canvas-edit';
import { asLoop, insidePolygon, loopAround, polygonArea } from '../model/draw-shapes';
import { boxOf } from '../model/drawing-scene';
import type { Pt } from '../model/geometry';
import { HATCH_FIELD_DEFAULTS, islandsOf } from '../model/hatch-patterns';
import type { ExtraContext, ExtraRun } from './extra-commands';

/**
 * HATCH and GRADIENT as AutoCAD (ADR-055 part 8): while the command runs, the «Hatch Creation»
 * ribbon tab sets the hatch; each «Pick internal point» (or selected closed object) adds a boundary
 * — with its islands, by the island detection — to ONE hatch, drawn at once as a preview, until
 * Enter or «Close Hatch Creation». Undo takes the last boundary back, Remove takes one away,
 * Set Origin moves the pattern origin. Saved as `add_shape` (screen only).
 */

export const HATCH_COMMANDS: ReadonlySet<CommandId> = new Set<CommandId>(['hatch', 'gradient']);
export const isHatchCommand = (cmd: CommandId) => HATCH_COMMANDS.has(cmd);

export type HatchType = 'pattern' | 'solid' | 'gradient' | 'user';

/** The Hatch Creation tab's values (AutoCAD keeps them from one hatch to the next). */
export interface HatchSettings {
  type: HatchType;
  pattern: HatchLinePattern;
  gradient: GradientPattern;
  scale: number;
  /** User defined: the spacing of the lines, drawing units. */
  spacing: number;
  double: boolean;
  angle: number;
  /** null = Use Current (the layer's colour). */
  color: string | null;
  /** Pattern: background colour (null = None); gradient: its second colour (null = white). */
  background: string | null;
  color2: string | null;
  transparency: number;
  /** null = the drawing's 0,0. */
  origin: [number, number] | null;
  island: HatchIslandStyle;
  drawOrder: HatchDrawOrder;
  separate: boolean;
  /** Gap tolerance: ends this far apart still close a boundary (0 = exact). */
  gap: number;
}

export const DEFAULT_HATCH_SETTINGS: HatchSettings = {
  type: 'pattern',
  pattern: 'ANSI31',
  gradient: 'GR_LINEAR',
  scale: 1,
  spacing: 1,
  double: false,
  angle: 0,
  color: null,
  background: null,
  color2: null,
  transparency: 0,
  origin: null,
  island: 'normal',
  drawOrder: 'behind',
  separate: false,
  gap: 0,
};

export type HatchStep = 'h_pick' | 'h_select' | 'h_remove' | 'h_origin';
export type HatchPromptKey = 'hatchPick' | 'hatchSelect' | 'hatchRemove' | 'hatchOrigin';
export const HATCH_OBJECT_STEPS: readonly string[] = ['h_select', 'h_remove'];

/** One pick: its outer boundary and the islands found in it. */
export type HatchPick = Pt[][];

export interface HatchData {
  picks?: HatchPick[];
}

interface Prompt {
  key: HatchPromptKey;
  options: CommandOption[];
  fallback: string | null;
}

const opt = (word: string, key: string): CommandOption => ({ word, key });
const hatchData = (r: ExtraRun): HatchData => (r.flags.extra as HatchData | undefined) ?? {};
const picksOf = (r: ExtraRun) => hatchData(r).picks ?? [];
const go = <R extends ExtraRun>(
  ctx: ExtraContext<R>,
  r: R,
  step: HatchStep,
  patch: HatchData = {},
) => ctx.setRun({ ...r, step, flags: { ...r.flags, extra: { ...hatchData(r), ...patch } } });

export function hatchPrompt(r: ExtraRun): Prompt | null {
  switch (r.step as HatchStep) {
    case 'h_pick':
      return {
        key: 'hatchPick',
        options: [opt('Select objects', 'S'), opt('Undo', 'U'), opt('Remove boundaries', 'B')],
        fallback: null,
      };
    case 'h_select':
      return {
        key: 'hatchSelect',
        options: [opt('picK internal point', 'K'), opt('Undo', 'U'), opt('Remove boundaries', 'B')],
        fallback: null,
      };
    case 'h_remove':
      return { key: 'hatchRemove', options: [opt('Add boundaries', 'A')], fallback: null };
    case 'h_origin':
      return { key: 'hatchOrigin', options: [], fallback: null };
  }
  return null;
}

export function hatchBegin<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  cmd: CommandId,
  fresh: (step: string) => R,
): R {
  const h = ctx.settings.hatch;
  if (cmd === 'gradient' && h.type !== 'gradient') {
    ctx.setSettings({ hatch: { ...h, type: 'gradient' } });
  } else if (cmd === 'hatch' && h.type === 'gradient') {
    ctx.setSettings({ hatch: { ...h, type: 'pattern' } });
  }
  ctx.say(
    cmd === 'gradient'
      ? ctx.msg('gradientSettings', { angle: acadNumber(h.angle) })
      : ctx.msg('hatchSettings', {
          pattern: patternName(h),
          scale: acadNumber(h.type === 'user' ? h.spacing : h.scale),
          angle: acadNumber(h.angle),
        }),
  );
  ctx.setSelection(new Set());
  const r = fresh('h_pick');
  const run = { ...r, flags: { ...r.flags, extra: { picks: [] } satisfies HatchData } };
  ctx.setRun(run);
  return run;
}

const patternName = (h: HatchSettings) =>
  h.type === 'solid'
    ? 'SOLID'
    : h.type === 'user'
      ? 'USER'
      : h.type === 'gradient'
        ? h.gradient
        : h.pattern;

export function hatchPoint<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, p: Point): void {
  const at: Pt = [p.x, p.y];
  if (r.step === 'h_origin') {
    ctx.setSettings({
      hatch: { ...ctx.settings.hatch, origin: [roundCoord(p.x), roundCoord(p.y)] },
    });
    go(ctx, r, 'h_pick');
    return;
  }
  if (r.step === 'h_remove') {
    removeAt(ctx, r, at);
    return;
  }
  if (r.step !== 'h_pick') return;
  const gap = ctx.settings.hatch.gap;
  const outer = loopAround(loopsNear(ctx, at, gap), at);
  if (!outer) {
    ctx.say(ctx.msg('hatchNone'));
    return;
  }
  const islands =
    ctx.settings.hatch.island === 'ignore' ? [] : islandsOf(outer, loopsInside(ctx, outer, gap));
  addPick(ctx, r, [outer, ...islands]);
}

/** A pick on a step that waits for an object (Select objects, Remove boundaries). */
export function hatchObject<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  r: R,
  index: number | null,
  at: Point,
): void {
  if (r.step === 'h_remove') {
    removeAt(ctx, r, [at.x, at.y]);
    return;
  }
  if (index === null || !ctx.pickable(index)) {
    ctx.say(ctx.msg('nothingThere'));
    return;
  }
  const loop = loopOf(ctx, index, ctx.settings.hatch.gap);
  if (!loop) {
    ctx.say(ctx.msg('hatchNone'));
    return;
  }
  addPick(ctx, r, [loop]);
}

export function hatchOption<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, key: string): void {
  switch (key) {
    case 'S':
      go(ctx, r, 'h_select');
      return;
    case 'K':
    case 'A':
      go(ctx, r, 'h_pick');
      return;
    case 'B':
      go(ctx, r, 'h_remove');
      return;
    case 'O':
      go(ctx, r, 'h_origin');
      return;
    case 'U': {
      const picks = picksOf(r);
      if (picks.length === 0) ctx.say(ctx.msg('hatchNoBoundary'));
      go(ctx, r, r.step as HatchStep, { picks: picks.slice(0, -1) });
      return;
    }
  }
}

/** Enter, or «Close Hatch Creation»: the hatch is made (one, or one per pick when separate). */
export function hatchEnter<R extends ExtraRun>(ctx: ExtraContext<R>, r: R): void {
  if (r.step === 'h_remove' || r.step === 'h_select' || r.step === 'h_origin') {
    if (r.step !== 'h_select' || picksOf(r).length === 0) {
      go(ctx, r, 'h_pick');
      return;
    }
  }
  const made = hatchEdits(r, ctx.settings.hatch, ctx.drawLayer);
  if (made.length > 0) {
    if (!ctx.needDrawLayer()) return;
    ctx.add(made);
  }
  ctx.finish();
}

/** The hatch being made, drawn as a preview while the command runs. */
export function hatchPending(r: ExtraRun, h: HatchSettings, layer: string): CanvasEdit[] {
  if (!isHatchCommand(r.cmd)) return [];
  return hatchEdits(r, h, layer);
}

/** Boundaries picked so far (the Hatch Creation tab shows the count). */
export const hatchLoopCount = (r: ExtraRun) => picksOf(r).reduce((n, pick) => n + pick.length, 0);

/** The `add_shape` edits of the picks with these settings. */
export function hatchEdits(r: ExtraRun, h: HatchSettings, layer: string): CanvasEdit[] {
  const picks = picksOf(r).filter((pick) => pick.length > 0);
  if (picks.length === 0) return [];
  const groups = h.separate ? picks : [picks.flat()];
  return groups.map((loops) => shapeEdit(loops, h, layer));
}

const round = (loop: readonly Pt[]): [number, number][] =>
  loop.map((p) => [roundCoord(p[0]), roundCoord(p[1])]);

export function shapeEdit(loops: readonly Pt[][], h: HatchSettings, layer: string): CanvasEdit {
  const [first, ...rest] = loops;
  const gradient = h.type === 'gradient';
  return {
    kind: 'add_shape',
    shape: gradient ? 'gradient' : 'hatch',
    layer,
    points: round(first ?? []),
    pattern: gradient
      ? h.gradient
      : h.type === 'solid'
        ? 'SOLID'
        : h.type === 'user'
          ? 'USER'
          : h.pattern,
    scale: h.type === 'user' ? h.spacing : h.scale,
    angle: h.angle,
    color: h.color,
    color2: gradient ? h.color2 : null,
    inner: null,
    outer: null,
    ...HATCH_FIELD_DEFAULTS,
    loops: rest.slice(0, MAX_HATCH_LOOPS).map(round),
    island: h.island,
    background: gradient || h.type === 'solid' ? null : h.background,
    transparency: h.transparency,
    origin: h.origin,
    double: h.type === 'user' && h.double,
    drawOrder: h.drawOrder,
  };
}

function addPick<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, pick: HatchPick): void {
  const picks = [...picksOf(r), pick];
  const count = picks.reduce((n, p) => n + p.length, 0);
  if (count > MAX_HATCH_LOOPS + 1) {
    ctx.say(ctx.msg('tooManyEdits', { count: MAX_HATCH_LOOPS }));
    return;
  }
  ctx.say(ctx.msg('hatchLoops', { count }));
  go(ctx, r, r.step as HatchStep, { picks });
}

/** Remove boundaries: the smallest picked loop around the point (an island, or a whole pick). */
function removeAt<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, at: Pt): void {
  let best: { pick: number; loop: number; area: number } | null = null;
  picksOf(r).forEach((pick, i) =>
    pick.forEach((loop, j) => {
      if (!insidePolygon(loop, at)) return;
      const area = polygonArea(loop);
      if (!best || area < best.area) best = { pick: i, loop: j, area };
    }),
  );
  const found = best as { pick: number; loop: number } | null;
  if (!found) {
    ctx.say(ctx.msg('nothingThere'));
    return;
  }
  const picks = picksOf(r)
    .map((pick, i) =>
      i !== found.pick ? pick : found.loop === 0 ? [] : pick.filter((_, j) => j !== found.loop),
    )
    .filter((pick) => pick.length > 0);
  ctx.say(ctx.msg('hatchRemoved'));
  go(ctx, r, 'h_remove', { picks });
}

// ---------- boundaries of the drawing ----------

function tolerance<R extends ExtraRun>(ctx: ExtraContext<R>, gap: number): number {
  const e = ctx.scene.view.extents;
  return Math.max(gap, 1e-6, Math.hypot(e.maxX - e.minX, e.maxY - e.minY) * 1e-6);
}

/** The closed outline of an object (a closed polyline, circle, ellipse, closed spline). */
function loopOf<R extends ExtraRun>(ctx: ExtraContext<R>, index: number, gap: number): Pt[] | null {
  const geom = ctx.curveGeom(index);
  if (geom) return asLoop(geom.points, geom.closed, tolerance(ctx, gap));
  const entity = ctx.scene.view.entities[index];
  if (!entity || entity.paths.length !== 1) return null;
  const flat = entity.paths[0] as readonly number[];
  const moved = ctx.shown.transformOf.get(index);
  const points: Pt[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const x = flat[i] as number;
    const y = flat[i + 1] as number;
    points.push(
      moved
        ? [moved[0] * x + moved[2] * y + moved[4], moved[1] * x + moved[3] * y + moved[5]]
        : [x, y],
    );
  }
  return asLoop(points, false, tolerance(ctx, gap));
}

type Box = { minX: number; minY: number; maxX: number; maxY: number };

/** Closed outlines of shown objects whose box passes `keep`, and of lines drawn on the page. */
function loopsWhere<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  gap: number,
  keep: (box: Box) => boolean,
): Pt[][] {
  const out: Pt[][] = [];
  ctx.scene.view.entities.forEach((_, index) => {
    if (!ctx.pickable(index)) return;
    const t = ctx.shown.transformOf.get(index);
    const b = t ? boxThrough(t, boxOf(ctx.scene, index)) : boxOf(ctx.scene, index);
    if (!ctx.shown.curveOf.has(index) && !keep(b)) return;
    const loop = loopOf(ctx, index, gap);
    if (loop) out.push(loop);
  });
  for (const extra of ctx.shown.extraCurves) {
    const points: Pt[] = [];
    for (let i = 0; i + 1 < extra.path.length; i += 2) {
      points.push([extra.path[i] as number, extra.path[i + 1] as number]);
    }
    const loop = asLoop(points, extra.closed, tolerance(ctx, gap));
    if (loop) out.push(loop);
  }
  return out;
}

function loopsNear<R extends ExtraRun>(ctx: ExtraContext<R>, p: Pt, gap: number): Pt[][] {
  return loopsWhere(
    ctx,
    gap,
    (b) => p[0] >= b.minX && p[0] <= b.maxX && p[1] >= b.minY && p[1] <= b.maxY,
  );
}

function loopsInside<R extends ExtraRun>(ctx: ExtraContext<R>, outer: Pt[], gap: number): Pt[][] {
  const xs = outer.map((p) => p[0]);
  const ys = outer.map((p) => p[1]);
  const o = {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
  const inner = loopsWhere(
    ctx,
    gap,
    (b) => b.minX >= o.minX && b.maxX <= o.maxX && b.minY >= o.minY && b.maxY <= o.maxY,
  );
  // The outer loop itself is found again: keep loops of a smaller area only.
  const area = polygonArea(outer);
  return inner.filter((loop) => polygonArea(loop) < area * (1 - 1e-9));
}
