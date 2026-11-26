import type { CommandId, CommandOption, Point } from '../model/cad-commands';
import { pointsCurveEdit, setCurveEdit, type CanvasEdit } from '../model/canvas-edit';
import type { Pt } from '../model/geometry';
import type { ExtraContext, ExtraRun } from './extra-commands';

/**
 * Round 3 Modify commands (audit 4.2): EXPLODE here; EXTEND shares TRIM's pick in the workspace
 * (a plain pick extends, Shift trims). EXPLODE turns a polyline into its segments (`erase_item` +
 * one `add_curve` per segment, on the polyline's layer). Blocks are not exploded: the view of the
 * file has no block definitions, so AutoCAD's count of objects «not able to be exploded» says so.
 */

export const MODIFY2_COMMANDS: ReadonlySet<CommandId> = new Set<CommandId>(['explode', 'pedit']);

/** Prompts of EXTEND (asked in the workspace's TRIM steps) and PEDIT. */
export type Modify2PromptKey = 'extendPick' | 'extendEdges' | 'peditPick' | 'peditOption';
export type Modify2Step = 'm_peditPick' | 'm_peditOption';

export const MODIFY2_OBJECT_STEPS: readonly string[] = ['m_peditPick'];

interface Modify2Data {
  target?: number;
  closed?: boolean;
  /** Closed / open before each PEDIT change, for its Undo. */
  before?: boolean[];
}

const opt = (word: string, key: string): CommandOption => ({ word, key });
const modData = (r: ExtraRun): Modify2Data => (r.flags.extra as Modify2Data | undefined) ?? {};

/** PEDIT's options: Open in place of Close on a closed polyline (AutoCAD). */
export function modify2Prompt(
  r: ExtraRun,
): { key: Modify2PromptKey; options: CommandOption[]; fallback: string | null } | null {
  if (r.step === 'm_peditPick') return { key: 'peditPick', options: [], fallback: null };
  if (r.step !== 'm_peditOption') return null;
  return {
    key: 'peditOption',
    options: [
      modData(r).closed ? opt('Open', 'O') : opt('Close', 'C'),
      opt('Join', 'J'),
      opt('Width', 'W'),
      opt('Edit vertex', 'E'),
      opt('Fit', 'F'),
      opt('Spline', 'S'),
      opt('Decurve', 'D'),
      opt('Ltype gen', 'L'),
      opt('Reverse', 'R'),
      opt('Undo', 'U'),
    ],
    fallback: null,
  };
}

export const isModify2Command = (cmd: CommandId) => MODIFY2_COMMANDS.has(cmd);

export function modify2Begin<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  cmd: CommandId,
  fresh: (step: string) => R,
): R | null {
  if (cmd === 'pedit') {
    // A polyline picked first is taken at once (PICKFIRST).
    const [only] = [...ctx.selection];
    const run = fresh('m_peditPick');
    ctx.setRun(run);
    if (only !== undefined && ctx.selection.size === 1) {
      modify2Object(ctx, run, only);
      return run;
    }
    ctx.setSelection(new Set());
    return run;
  }
  const r = fresh('select');
  if (ctx.handles.length > 0) return modify2AfterSelect(ctx, r);
  ctx.setRun(r);
  return r;
}

/** The segments of a polyline as two-point paths. */
export function segmentsOf(points: readonly Pt[], closed: boolean): Pt[][] {
  const out: Pt[][] = [];
  for (let i = 1; i < points.length; i++) out.push([points[i - 1] as Pt, points[i] as Pt]);
  if (closed && points.length > 2) out.push([points[points.length - 1] as Pt, points[0] as Pt]);
  return out;
}

export function modify2AfterSelect<R extends ExtraRun>(ctx: ExtraContext<R>, r: R): R | null {
  if (r.cmd === 'explode') {
    const edits: CanvasEdit[] = [];
    let refused = 0;
    const seen = new Set<string>();
    for (const index of ctx.selection) {
      const entity = ctx.scene.view.entities[index];
      if (!entity || seen.has(entity.handle)) continue;
      seen.add(entity.handle);
      const kind = entity.kind.toUpperCase();
      const geom = ctx.curveGeom(index);
      if (!geom || (kind !== 'LWPOLYLINE' && kind !== 'POLYLINE')) {
        refused++;
        continue;
      }
      const layer = ctx.layerNameOf(index);
      edits.push({ kind: 'erase_item', handle: entity.handle });
      for (const seg of segmentsOf(geom.points, geom.closed)) {
        edits.push(pointsCurveEdit(layer, seg, false));
      }
    }
    if (edits.length > 0) ctx.add(edits);
    if (refused > 0) ctx.say(ctx.msg('explodeRefused', { count: refused }));
  }
  ctx.finish();
  return null;
}

// ---------- PEDIT ----------

/** «Select polyline or [Multiple]:» — the polyline is taken, its options are asked. */
export function modify2Object<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  r: R,
  index: number | null,
): void {
  if (r.step !== 'm_peditPick') return;
  if (index === null || !ctx.pickable(index)) {
    ctx.say(ctx.msg('nothingThere'));
    return;
  }
  const kind = ctx.scene.view.entities[index]?.kind.toUpperCase() ?? '';
  const geom = ctx.curveGeom(index);
  if (!geom || (kind !== 'LWPOLYLINE' && kind !== 'POLYLINE')) {
    // AutoCAD offers to turn a line into a polyline; the corrections have no such change.
    ctx.say(ctx.msg('peditNotPolyline'));
    return;
  }
  ctx.setSelection(new Set([index]));
  ctx.setRun({
    ...r,
    step: 'm_peditOption',
    flags: { ...r.flags, extra: { target: index, closed: geom.closed, before: [] } },
  });
}

export function modify2Option<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, key: string): void {
  if (r.step !== 'm_peditOption') return;
  const d = modData(r);
  const index = d.target ?? -1;
  const geom = ctx.curveGeom(index);
  const handle = ctx.scene.view.entities[index]?.handle;
  const change = (points: Pt[], closed: boolean) => {
    if (!handle) return;
    ctx.add([setCurveEdit(handle, points, closed)]);
    ctx.setRun({
      ...r,
      flags: {
        ...r.flags,
        extra: { ...d, closed, before: [...(d.before ?? []), d.closed ?? false] },
      },
    });
  };
  if (!geom) return;
  switch (key) {
    case 'C':
      if (geom.points.length < 3) ctx.say(ctx.msg('peditTooShort'));
      else change(geom.points, true);
      return;
    case 'O':
      change(geom.points, false);
      return;
    case 'R':
      change([...geom.points].reverse(), geom.closed);
      return;
    case 'U': {
      const back = d.before ?? [];
      if (back.length === 0) {
        ctx.say(ctx.msg('nothingToUndo'));
        return;
      }
      ctx.drop?.(1);
      ctx.setRun({
        ...r,
        flags: {
          ...r.flags,
          extra: { ...d, closed: back[back.length - 1], before: back.slice(0, -1) },
        },
      });
      return;
    }
    case 'J':
      // The build joins routes end to end (merge_routes): JOIN does that with AutoCAD's rules.
      ctx.say(ctx.msg('peditJoin'));
      return;
    case 'W':
      ctx.say(ctx.msg('peditWidth'));
      return;
    case 'D':
      ctx.say(ctx.msg('peditDecurve'));
      return;
    default:
      ctx.say(ctx.msg('peditNotHere'));
  }
}

export function modify2Enter<R extends ExtraRun>(ctx: ExtraContext<R>, r: R): void {
  void r;
  ctx.finish();
}

/** The polylines PEDIT works on are picked with a click, not typed. */
export const modify2Point = <R extends ExtraRun>(ctx: ExtraContext<R>, p: Point) => {
  void p;
  ctx.say(ctx.msg('badSelection'));
};
