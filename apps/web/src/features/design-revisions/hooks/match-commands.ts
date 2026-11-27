import { applyAffine } from '../model/affine';
import type { CommandId, CommandOption } from '../model/cad-commands';
import { roundCoord, type CanvasEdit } from '../model/canvas-edit';
import { effectiveLayer } from '../model/drawing-preview';
import { objectStyle } from '../model/properties';
import type { ExtraContext, ExtraRun } from './extra-commands';

/**
 * AutoCAD's MATCHPROP (owner 2026-11-26, item 34): «Select source object:», then «Current active
 * settings: …» and «Select destination object(s) or [Settings]:» again and again (a pick, a window
 * or a crossing changes those objects at once) until Enter. What is copied: the colour, line type
 * and line weight the source is drawn with (its own colour in the file too, not only a style made
 * here), its layer, and a text's height. Settings opens the Property Settings dialog.
 */

/** The Property Settings of AutoCAD's dialog, in its order. */
export const MATCH_PROPERTIES = [
  'color',
  'layer',
  'linetype',
  'ltscale',
  'lineweight',
  'transparency',
  'thickness',
  'plotstyle',
  'dim',
  'text',
  'hatch',
  'polyline',
  'viewport',
  'table',
  'material',
  'multileader',
  'center',
] as const;
export type MatchProperty = (typeof MATCH_PROPERTIES)[number];
export type MatchSettings = Readonly<Record<MatchProperty, boolean>>;

/** The names AutoCAD prints in «Current active settings:». */
export const MATCH_NAMES: Readonly<Record<MatchProperty, string>> = {
  color: 'Color',
  layer: 'Layer',
  linetype: 'Ltype',
  ltscale: 'Ltscale',
  lineweight: 'Lineweight',
  transparency: 'Transparency',
  thickness: 'Thickness',
  plotstyle: 'PlotStyle',
  dim: 'Dim',
  text: 'Text',
  hatch: 'Hatch',
  polyline: 'Polyline',
  viewport: 'Viewport',
  table: 'Table',
  material: 'Material',
  multileader: 'Multileader',
  center: 'Center object',
};

/**
 * Settings the web screen cannot copy, and why (an i18n key under `design.cad.match.why`): the view
 * does not carry them or no correction can change them. Shown greyed in the dialog.
 */
export const MATCH_UNSUPPORTED: Readonly<Partial<Record<MatchProperty, string>>> = {
  ltscale: 'noCorrection',
  transparency: 'noCorrection',
  thickness: 'threeD',
  plotstyle: 'noPlot',
  dim: 'noCorrection',
  hatch: 'noCorrection',
  polyline: 'noCorrection',
  viewport: 'paperSpace',
  table: 'noCorrection',
  material: 'threeD',
  multileader: 'noCorrection',
  center: 'noCorrection',
};

/** AutoCAD's default: every setting on. */
export const DEFAULT_MATCH_SETTINGS: MatchSettings = Object.fromEntries(
  MATCH_PROPERTIES.map((p) => [p, true]),
) as Record<MatchProperty, boolean>;

/** «Current active settings: Color Layer …» — the settings turned on, AutoCAD's names. */
export const activeSettings = (settings: MatchSettings) =>
  MATCH_PROPERTIES.filter((p) => settings[p])
    .map((p) => MATCH_NAMES[p])
    .join(' ');

export const isMatchCommand = (cmd: CommandId) => cmd === 'matchprop';

export type MatchStep = 'm_source';
export const MATCH_OBJECT_STEPS: readonly string[] = ['m_source'];

interface MatchData {
  target?: number;
}

const sourceOf = (r: ExtraRun): number | undefined =>
  (r.flags.extra as MatchData | undefined)?.target;

/** The prompt of a MATCHPROP step (the destinations are «Select objects:» with Settings). */
export function matchPrompt(r: ExtraRun): {
  key: 'matchSource' | 'matchDest';
  options: CommandOption[];
  fallback: string | null;
} {
  return r.step === 'm_source'
    ? { key: 'matchSource', options: [], fallback: null }
    : { key: 'matchDest', options: [{ word: 'Settings', key: 'S' }], fallback: null };
}

function toDestinations<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, source: number): R {
  ctx.say(ctx.msg('matchSettings', { settings: activeSettings(ctx.settings.match) }));
  ctx.setSelection(new Set());
  const run = { ...r, step: 'select', flags: { ...r.flags, extra: { target: source } } };
  ctx.setRun(run);
  return run;
}

/** MATCHPROP starts: one object picked first is the source (AutoCAD), else it asks for one. */
export function matchBegin<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  fresh: (step: string) => R,
): R {
  const [only] = [...ctx.selection];
  if (only !== undefined && ctx.handles.length === 1)
    return toDestinations(ctx, fresh('select'), only);
  ctx.setSelection(new Set());
  const r = fresh('m_source');
  ctx.setRun(r);
  return r;
}

/** A pick at «Select source object:». */
export function matchObject<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  r: R,
  index: number | null,
): void {
  if (index === null || !ctx.pickable(index)) {
    ctx.say(ctx.msg('nothingThere'));
    return;
  }
  toDestinations(ctx, r, index);
}

/** The height a text is drawn at now (its scale applied), null for other objects. */
function textHeight<R extends ExtraRun>(ctx: ExtraContext<R>, index: number) {
  const entity = ctx.scene.view.entities[index];
  const text = entity?.texts[0];
  if (!entity || !text || (entity.kind !== 'TEXT' && entity.kind !== 'MTEXT')) return null;
  const t = ctx.shown.transformOf.get(index);
  const scale = t ? Math.sqrt(Math.abs(t[0] * t[3] - t[1] * t[2])) : 1;
  const at = t ? applyAffine(t, text.x, text.y) : { x: text.x, y: text.y };
  return { height: text.height * scale, at };
}

/** The edits that make one destination like the source (none when it is already alike). */
export function matchEdits<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  source: number,
  destination: number,
  settings: MatchSettings,
): CanvasEdit[] {
  const { scene, shown } = ctx;
  const handle = scene.view.entities[destination]?.handle;
  if (!handle || destination === source) return [];
  const out: CanvasEdit[] = [];
  const from = objectStyle(scene, shown, source);
  const was = objectStyle(scene, shown, destination);
  const style = {
    color: settings.color ? from.color : was.color,
    linetype: settings.linetype ? from.linetype : was.linetype,
    lineweight: settings.lineweight ? from.lineweight : was.lineweight,
  };
  if (
    style.color !== was.color ||
    style.linetype !== was.linetype ||
    style.lineweight !== was.lineweight
  ) {
    out.push({ kind: 'set_style', handle, ...style });
  }
  if (settings.layer) {
    const layer = ctx.layerNameOf(source);
    const same =
      effectiveLayer(scene, shown, source) === effectiveLayer(scene, shown, destination) ||
      layer === ctx.layerNameOf(destination);
    if (layer && !same && ctx.usableLayers.includes(layer)) {
      out.push({ kind: 'move_layer', handle, toLayer: layer });
    }
  }
  if (settings.text) {
    const a = textHeight(ctx, source);
    const b = textHeight(ctx, destination);
    if (a && b && b.height > 0 && Math.abs(a.height - b.height) > 1e-9) {
      out.push({
        kind: 'scale_item',
        handle,
        x: roundCoord(b.at.x),
        y: roundCoord(b.at.y),
        factor: roundCoord(a.height / b.height),
      });
    }
  }
  return out;
}

/** Destinations picked or windowed: they change at once, the prompt asks again (AutoCAD). */
export function matchDestinations<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  r: R,
  indexes: Iterable<number>,
): void {
  const source = sourceOf(r);
  if (source === undefined) return;
  const seen = new Set<string>();
  const out: CanvasEdit[] = [];
  for (const index of indexes) {
    const handle = ctx.scene.view.entities[index]?.handle;
    if (!handle || seen.has(handle) || !ctx.pickable(index)) continue;
    seen.add(handle);
    out.push(...matchEdits(ctx, source, index, ctx.settings.match));
  }
  if (out.length > 0) ctx.add(out);
  ctx.setSelection(new Set());
}

/** Enter at the destinations: objects chosen by a selection word (ALL, P…) change; it ends. */
export function matchAfterSelect<R extends ExtraRun>(ctx: ExtraContext<R>, r: R): null {
  if (ctx.selection.size > 0) matchDestinations(ctx, r, ctx.selection);
  ctx.finish();
  return null;
}

/** Settings: the Property Settings dialog (the prompt asks again after OK). */
export function matchOption<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, key: string): void {
  if (key === 'S' && r.step === 'select') ctx.openDialog?.({ kind: 'matchprop' });
  else ctx.say(ctx.msg('badKeyword'));
}
