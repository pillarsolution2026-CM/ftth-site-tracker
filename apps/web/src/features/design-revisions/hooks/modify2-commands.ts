import type { CommandId } from '../model/cad-commands';
import { pointsCurveEdit, type CanvasEdit } from '../model/canvas-edit';
import type { Pt } from '../model/geometry';
import type { ExtraContext, ExtraRun } from './extra-commands';

/**
 * Round 3 Modify commands (audit 4.2): EXPLODE here; EXTEND shares TRIM's pick in the workspace
 * (a plain pick extends, Shift trims). EXPLODE turns a polyline into its segments (`erase_item` +
 * one `add_curve` per segment, on the polyline's layer). Blocks are not exploded: the view of the
 * file has no block definitions, so AutoCAD's count of objects «not able to be exploded» says so.
 */

export const MODIFY2_COMMANDS: ReadonlySet<CommandId> = new Set<CommandId>(['explode']);

/** Prompts of EXTEND (asked in the workspace's TRIM steps). */
export type Modify2PromptKey = 'extendPick' | 'extendEdges';
export type Modify2Step = never;

export const isModify2Command = (cmd: CommandId) => MODIFY2_COMMANDS.has(cmd);

export function modify2Begin<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  cmd: CommandId,
  fresh: (step: string) => R,
): R | null {
  void cmd;
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
