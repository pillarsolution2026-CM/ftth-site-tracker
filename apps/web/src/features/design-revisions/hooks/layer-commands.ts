import { boxThrough } from '../model/affine';
import type { CommandId, CommandOption, Point } from '../model/cad-commands';
import { copyEdits, roundCoord, type CanvasEdit } from '../model/canvas-edit';
import { effectiveLayer } from '../model/drawing-preview';
import { boxOf } from '../model/drawing-scene';
import type { ExtraContext, ExtraRun } from './extra-commands';

/**
 * The Layers, Groups and Block commands added for the owner (2026-11-24), on the same command line:
 * LAYOFF, LAYISO, LAYUNISO, LAYFRZ, LAYTHW, LAYLCK, LAYULK, LAYON, LAYERP (screen only, ADR-051),
 * LAYCUR, COPYTOLAYER, LAYMRG, LAYDEL (saved as corrections), LAYWALK and FIND (dialogs), GROUP,
 * UNGROUP, GROUPEDIT, PICKSTYLE, BLOCK (screen-only groups), INSERT (a copy of a block reference)
 * and EATTEDIT (the attributes dialog).
 */

export const LAYER_COMMANDS: ReadonlySet<CommandId> = new Set<CommandId>([
  'layoff',
  'layiso',
  'layuniso',
  'layfrz',
  'laythw',
  'laylck',
  'layulk',
  'layon',
  'layerp',
  'laycur',
  'copytolayer',
  'laymrg',
  'laydel',
  'laywalk',
  'find',
  'group',
  'ungroup',
  'groupedit',
  'pickstyle',
  'block',
  'insert',
  'eattedit',
]);

/** Commands that start with «Select objects:» (noun-verb or verb-noun). */
const SELECTING_LAYER: ReadonlySet<CommandId> = new Set<CommandId>([
  'layiso',
  'laycur',
  'copytolayer',
  'group',
  'ungroup',
]);

export type LayerStep =
  | 'l_offPick'
  | 'l_frzPick'
  | 'l_lckPick'
  | 'l_ulkPick'
  | 'l_ctlDest'
  | 'l_ctlBase'
  | 'l_ctlSecond'
  | 'l_name'
  | 'l_mrgFrom'
  | 'l_mrgTo'
  | 'l_mrgConfirm'
  | 'l_delPick'
  | 'l_delConfirm'
  | 'l_geGroup'
  | 'l_geOpt'
  | 'l_geAdd'
  | 'l_geRemove'
  | 'l_blkName'
  | 'l_insPick'
  | 'l_insAt'
  | 'l_attPick';

export type LayerPromptKey =
  | 'layoffPick'
  | 'layfrzPick'
  | 'laylckPick'
  | 'layulkPick'
  | 'copyToLayerDest'
  | 'copyToLayerBase'
  | 'copyToLayerSecond'
  | 'layerNameEntry'
  | 'mergeFrom'
  | 'mergeTo'
  | 'layerConfirm'
  | 'deletePick'
  | 'groupPick'
  | 'groupOptions'
  | 'groupAdd'
  | 'groupRemove'
  | 'blockName'
  | 'insertPick'
  | 'insertPoint'
  | 'attributePick';

export const LAYER_OBJECT_STEPS: readonly string[] = [
  'l_offPick',
  'l_frzPick',
  'l_lckPick',
  'l_ulkPick',
  'l_ctlDest',
  'l_mrgFrom',
  'l_mrgTo',
  'l_delPick',
  'l_geGroup',
  'l_geAdd',
  'l_geRemove',
  'l_insPick',
  'l_attPick',
];
export const LAYER_TRACKED: readonly string[] = ['l_ctlSecond', 'l_insAt'];
/** Steps where the command line takes free text (a layer, group or block name). */
export const LAYER_TEXT_STEPS: readonly string[] = ['l_name', 'l_blkName'];

/** What the layer commands keep while they run. */
export interface LayerData {
  /** COPYTOLAYER: the layer the copies go to; LAYMRG: the layer merged from / into. */
  layer?: string;
  from?: string;
  /** Which question the Name option answers. */
  naming?: 'ctl' | 'from' | 'to' | 'del' | 'rename';
  group?: string;
  source?: number;
  blockHandles?: string[];
}

interface Prompt {
  key: LayerPromptKey | 'selectObjects';
  options: CommandOption[];
  fallback: string | null;
}

const opt = (word: string, key: string): CommandOption => ({ word, key });
const layerData = (r: ExtraRun): LayerData => (r.flags.extra as LayerData | undefined) ?? {};
const go = <R extends ExtraRun>(
  ctx: ExtraContext<R>,
  r: R,
  step: LayerStep | 'select',
  patch: LayerData = {},
): R => {
  const run = { ...r, step, flags: { ...r.flags, extra: { ...layerData(r), ...patch } } };
  ctx.setRun(run);
  return run;
};

export const isLayerCommand = (cmd: CommandId) => LAYER_COMMANDS.has(cmd);

export function layerPrompt(r: ExtraRun): Prompt | null {
  const p = (
    key: Prompt['key'],
    options: CommandOption[] = [],
    fallback: string | null = null,
  ) => ({
    key,
    options,
    fallback,
  });
  switch (r.step as LayerStep) {
    case 'l_offPick':
      return p('layoffPick', r.made.length > 0 ? [opt('Undo', 'U')] : []);
    case 'l_frzPick':
      return p('layfrzPick', r.made.length > 0 ? [opt('Undo', 'U')] : []);
    case 'l_lckPick':
      return p('laylckPick');
    case 'l_ulkPick':
      return p('layulkPick');
    case 'l_ctlDest':
      return p('copyToLayerDest', [opt('Name', 'N')]);
    case 'l_ctlBase':
      return p('copyToLayerBase', [opt('eXit', 'X')], 'eXit');
    case 'l_ctlSecond':
      return p('copyToLayerSecond');
    case 'l_name':
      return p('layerNameEntry');
    case 'l_mrgFrom':
      return p('mergeFrom', [opt('Name', 'N')]);
    case 'l_mrgTo':
      return p('mergeTo', [opt('Name', 'N')]);
    case 'l_mrgConfirm':
    case 'l_delConfirm':
      return p('layerConfirm', [opt('Yes', 'Y'), opt('No', 'N')], 'No');
    case 'l_delPick':
      return p('deletePick', [opt('Name', 'N')]);
    case 'l_geGroup':
      return p('groupPick');
    case 'l_geOpt':
      return p('groupOptions', [
        opt('Add objects', 'A'),
        opt('Remove objects', 'R'),
        opt('REName', 'REN'),
      ]);
    case 'l_geAdd':
      return p('groupAdd');
    case 'l_geRemove':
      return p('groupRemove');
    case 'l_blkName':
      return p('blockName');
    case 'l_insPick':
      return p('insertPick');
    case 'l_insAt':
      return p('insertPoint');
    case 'l_attPick':
      return p('attributePick');
  }
  return null;
}

/** The layer indexes of the picked objects. */
function pickedLayers<R extends ExtraRun>(ctx: ExtraContext<R>): number[] {
  const out = new Set<number>();
  for (const index of ctx.selection) out.add(effectiveLayer(ctx.scene, ctx.shown, index));
  out.delete(-1);
  return [...out];
}

function layerNames<R extends ExtraRun>(ctx: ExtraContext<R>, layers: readonly number[]): string {
  return layers.map((i) => ctx.scene.view.layers[i]?.name ?? '').join(', ');
}

/** The groups a handle belongs to. */
function groupsOf<R extends ExtraRun>(ctx: ExtraContext<R>, handles: readonly string[]): string[] {
  const wanted = new Set(handles);
  return [...ctx.shown.groups]
    .filter(([, g]) => g.handles.some((h) => wanted.has(h)))
    .map(([n]) => n);
}

function nextGroupName<R extends ExtraRun>(ctx: ExtraContext<R>, prefix: string): string {
  for (let n = 1; ; n++) if (!ctx.shown.groups.has(`${prefix}${n}`)) return `${prefix}${n}`;
}

export function layerBegin<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  cmd: CommandId,
  fresh: (step: string) => R,
): R | null {
  const screen = ctx.layerScreen;
  const start = (step: LayerStep): R => {
    const r = fresh(step);
    ctx.setRun(r);
    return r;
  };
  if (SELECTING_LAYER.has(cmd)) {
    const r = fresh('select');
    if (ctx.handles.length > 0) return layerAfterSelect(ctx, r);
    ctx.setRun(r);
    return r;
  }
  const byPick = PICK_STEP[cmd];
  if (byPick) {
    // Objects picked first: their layers at once; else one object at a time (AutoCAD).
    if (ctx.handles.length > 0) return layerAfterSelect(ctx, fresh('select'));
    ctx.setSelection(new Set());
    return start(byPick);
  }
  switch (cmd) {
    case 'layuniso':
      ctx.say(ctx.msg(screen?.unisolate() ? 'layersRestored' : 'noIsolation'));
      ctx.finish(true);
      return null;
    case 'laythw':
      screen?.thawAll();
      ctx.say(ctx.msg('allThawed'));
      ctx.finish(true);
      return null;
    case 'layon':
      screen?.allOn();
      ctx.say(ctx.msg('allOn'));
      ctx.finish(true);
      return null;
    case 'layerp':
      ctx.say(ctx.msg(screen?.previous() ? 'layersRestored' : 'noPrevious'));
      ctx.finish(true);
      return null;
    case 'laywalk':
      ctx.openDialog?.({ kind: 'laywalk' });
      ctx.finish(true);
      return null;
    case 'find':
      ctx.openDialog?.({ kind: 'find' });
      ctx.finish(true);
      return null;
    case 'pickstyle': {
      const on = !ctx.settings.groupPick;
      ctx.setSettings({ groupPick: on });
      ctx.say(ctx.msg(on ? 'groupPickOn' : 'groupPickOff'));
      ctx.finish(true);
      return null;
    }
    case 'laymrg':
      ctx.setSelection(new Set());
      return start('l_mrgFrom');
    case 'laydel':
      ctx.setSelection(new Set());
      return start('l_delPick');
    case 'groupedit':
      return start('l_geGroup');
    case 'block': {
      const r = fresh('l_blkName');
      const run = { ...r, flags: { ...r.flags, extra: { blockHandles: ctx.handles } } };
      ctx.setRun(run);
      return run;
    }
    case 'insert':
      ctx.setSelection(new Set());
      return start('l_insPick');
    case 'eattedit': {
      const [only] = [...ctx.selection];
      if (only !== undefined && ctx.selection.size === 1 && isBlock(ctx, only)) {
        ctx.openDialog?.({ kind: 'attributes', index: only });
        ctx.finish();
        return null;
      }
      ctx.setSelection(new Set());
      return start('l_attPick');
    }
    default:
      return null;
  }
}

/** LAYOFF, LAYFRZ, LAYLCK, LAYULK ask for one object on the layer (LAYOFF / LAYFRZ repeat). */
const PICK_STEP: Partial<Record<CommandId, LayerStep>> = {
  layoff: 'l_offPick',
  layfrz: 'l_frzPick',
  laylck: 'l_lckPick',
  layulk: 'l_ulkPick',
};

/** A pick at «Select an object on the layer to be …»: that layer changes on the screen. */
function layerByPick<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, index: number): void {
  const screen = ctx.layerScreen;
  const layer = effectiveLayer(ctx.scene, ctx.shown, index);
  const layers = layer < 0 ? [] : [layer];
  const said = { layers: layerNames(ctx, layers) };
  switch (r.step as LayerStep) {
    case 'l_offPick':
    case 'l_frzPick':
      if (r.step === 'l_offPick') screen?.off(layers);
      else screen?.freeze(layers);
      ctx.say(ctx.msg(r.step === 'l_offPick' ? 'layersOff' : 'layersFrozen', said));
      ctx.setRun({ ...r, made: [...r.made, 0] });
      return;
    case 'l_lckPick':
      screen?.lock(layers);
      ctx.say(ctx.msg('layersLocked', said));
      ctx.finish();
      return;
    case 'l_ulkPick':
      screen?.unlock(layers);
      ctx.say(ctx.msg('layersUnlocked', said));
      ctx.finish();
      return;
    default:
  }
}

const isBlock = <R extends ExtraRun>(ctx: ExtraContext<R>, index: number) =>
  ctx.scene.view.entities[index]?.kind === 'INSERT';

export function layerAfterSelect<R extends ExtraRun>(ctx: ExtraContext<R>, r: R): R | null {
  const screen = ctx.layerScreen;
  if (ctx.handles.length === 0) {
    ctx.finish();
    return null;
  }
  const layers = pickedLayers(ctx);
  const done = (key: string) => {
    ctx.say(ctx.msg(key, { layers: layerNames(ctx, layers) }));
    ctx.finish();
    return null;
  };
  switch (r.cmd) {
    case 'layoff':
      screen?.off(layers);
      return done('layersOff');
    case 'layiso':
      screen?.isolate(layers);
      return done('layersIsolated');
    case 'layfrz':
      screen?.freeze(layers);
      return done('layersFrozen');
    case 'laylck':
      screen?.lock(layers);
      return done('layersLocked');
    case 'layulk':
      screen?.unlock(layers);
      return done('layersUnlocked');
    case 'laycur': {
      if (!ctx.drawLayer) {
        ctx.say(ctx.msg('needLayer'));
        ctx.finish();
        return null;
      }
      if (!ctx.usableLayers.includes(ctx.drawLayer)) {
        ctx.say(ctx.msg('layerNoRule', { layer: ctx.drawLayer }));
        ctx.finish();
        return null;
      }
      ctx.add(
        ctx.handles.map((handle) => ({ kind: 'move_layer', handle, toLayer: ctx.drawLayer })),
      );
      ctx.say(ctx.msg('changedToLayer', { count: ctx.handles.length, layer: ctx.drawLayer }));
      ctx.finish();
      return null;
    }
    case 'copytolayer':
      return go(ctx, r, 'l_ctlDest');
    case 'group': {
      const name = nextGroupName(ctx, '*A');
      ctx.add([{ kind: 'set_group', name, handles: ctx.handles, block: false }]);
      ctx.say(ctx.msg('groupMade', { name, count: ctx.handles.length }));
      ctx.finish();
      return null;
    }
    case 'ungroup': {
      const names = groupsOf(ctx, ctx.handles);
      if (names.length === 0) {
        ctx.say(ctx.msg('notInGroup'));
      } else {
        ctx.add(names.map((name) => ({ kind: 'set_group', name, handles: [], block: false })));
        ctx.say(ctx.msg('groupExploded', { name: names.join(', ') }));
      }
      ctx.finish();
      return null;
    }
    default:
      ctx.finish();
      return null;
  }
}

export function layerPoint<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, p: Point): void {
  const d = layerData(r);
  switch (r.step as LayerStep) {
    case 'l_ctlBase':
      ctx.setRun({ ...r, step: 'l_ctlSecond', base: p });
      return;
    case 'l_ctlSecond':
      if (r.base) copyTo(ctx, d.layer ?? '', p.x - r.base.x, p.y - r.base.y);
      return;
    case 'l_insAt': {
      if (d.source === undefined) return;
      const at = blockCentre(ctx, d.source);
      const handle = ctx.scene.view.entities[d.source]?.handle;
      if (!handle) return;
      ctx.add([
        {
          kind: 'copy_item',
          handle,
          dx: roundCoord(p.x - at.x),
          dy: roundCoord(p.y - at.y),
          toLayer: null,
        },
      ]);
      return;
    }
    default:
      ctx.say(ctx.msg('badSelection'));
  }
}

export function layerOption<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, key: string): void {
  const d = layerData(r);
  switch (r.step as LayerStep) {
    case 'l_offPick':
    case 'l_frzPick':
      // Undo: the layer turned off / frozen last comes back (the screen's previous state).
      if (key === 'U' && r.made.length > 0 && ctx.layerScreen?.previous()) {
        ctx.setRun({ ...r, made: r.made.slice(0, -1) });
      } else ctx.say(ctx.msg('nothingToUndo'));
      return;
    case 'l_ctlDest':
      if (key === 'N') go(ctx, r, 'l_name', { naming: 'ctl' });
      return;
    case 'l_ctlBase':
      if (key === 'X') copyTo(ctx, d.layer ?? '', 0, 0);
      return;
    case 'l_mrgFrom':
      if (key === 'N') go(ctx, r, 'l_name', { naming: 'from' });
      return;
    case 'l_mrgTo':
      if (key === 'N') go(ctx, r, 'l_name', { naming: 'to' });
      return;
    case 'l_delPick':
      if (key === 'N') go(ctx, r, 'l_name', { naming: 'del' });
      return;
    case 'l_mrgConfirm':
      if (key === 'Y' && d.from && d.layer) {
        ctx.add([{ kind: 'merge_layer', from: d.from, to: d.layer }]);
        ctx.say(ctx.msg('layerMerged', { from: d.from, to: d.layer }));
      }
      ctx.finish();
      return;
    case 'l_delConfirm':
      if (key === 'Y' && d.layer) {
        ctx.add([{ kind: 'delete_layer', layer: d.layer }]);
        ctx.say(ctx.msg('layerDeleted', { layer: d.layer }));
      }
      ctx.finish();
      return;
    case 'l_geOpt':
      if (key === 'A') go(ctx, r, 'l_geAdd');
      else if (key === 'R') go(ctx, r, 'l_geRemove');
      else if (key === 'REN') go(ctx, r, 'l_name', { naming: 'rename' });
      return;
    default:
      ctx.say(ctx.msg('badKeyword'));
  }
}

/** Free text: a layer, group or block name. */
export function layerText<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, value: string): void {
  const d = layerData(r);
  const name = value.trim();
  if (r.step === 'l_blkName') {
    if (!name) {
      ctx.finish();
      return;
    }
    if (ctx.shown.groups.has(name)) {
      ctx.say(ctx.msg('nameTaken', { name }));
      return;
    }
    const handles = d.blockHandles ?? [];
    if (handles.length > 0) {
      ctx.add([{ kind: 'set_group', name, handles, block: true }]);
      ctx.say(ctx.msg('blockMade', { name, count: handles.length }));
      ctx.finish();
      return;
    }
    go(ctx, r, 'select', { group: name });
    return;
  }
  if (!name) {
    ctx.finish();
    return;
  }
  switch (d.naming) {
    case 'ctl':
      go(ctx, r, 'l_ctlBase', { layer: name });
      return;
    case 'from':
      go(ctx, r, 'l_mrgTo', { from: name });
      return;
    case 'to':
      if (name === d.from) {
        ctx.say(ctx.msg('sameLayer'));
        return;
      }
      go(ctx, r, 'l_mrgConfirm', { layer: name });
      ctx.say(ctx.msg('mergeWarning', { from: d.from ?? '', to: name }));
      return;
    case 'del':
      go(ctx, r, 'l_delConfirm', { layer: name });
      ctx.say(ctx.msg('deleteWarning', { layer: name }));
      return;
    case 'rename': {
      const group = d.group;
      const old = group ? ctx.shown.groups.get(group) : undefined;
      if (!group || !old) return ctx.finish();
      ctx.add([
        { kind: 'set_group', name, handles: [...old.handles], block: old.block },
        { kind: 'set_group', name: group, handles: [], block: old.block },
      ]);
      ctx.finish();
      return;
    }
    default:
      ctx.finish();
  }
}

export function layerEnter<R extends ExtraRun>(ctx: ExtraContext<R>, r: R): void {
  const d = layerData(r);
  switch (r.step as LayerStep) {
    case 'l_ctlBase':
      copyTo(ctx, d.layer ?? '', 0, 0);
      return;
    case 'l_mrgConfirm':
    case 'l_delConfirm':
      ctx.say(ctx.msg('cancel'));
      ctx.finish();
      return;
    default:
      ctx.finish();
  }
}

/** After «Select objects:» of BLOCK named first. */
export function blockAfterSelect<R extends ExtraRun>(ctx: ExtraContext<R>, r: R): void {
  const name = layerData(r).group;
  if (!name || ctx.handles.length === 0) {
    ctx.finish();
    return;
  }
  ctx.add([{ kind: 'set_group', name, handles: ctx.handles, block: true }]);
  ctx.say(ctx.msg('blockMade', { name, count: ctx.handles.length }));
  ctx.finish();
}

const PICKED_LAYER_STEPS: ReadonlySet<string> = new Set(Object.values(PICK_STEP));

export function layerObject<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  r: R,
  index: number | null,
): void {
  const d = layerData(r);
  if (index !== null && PICKED_LAYER_STEPS.has(r.step) && !ctx.shown.erased.has(index)) {
    // An object on a locked layer counts here (LAYULK unlocks it).
    layerByPick(ctx, r, index);
    return;
  }
  if (index === null || !ctx.pickable(index)) {
    ctx.say(ctx.msg('nothingThere'));
    return;
  }
  const layer = ctx.layerNameOf(index);
  const handle = ctx.scene.view.entities[index]?.handle ?? '';
  switch (r.step as LayerStep) {
    case 'l_ctlDest':
      ctx.say(ctx.msg('destinationLayer', { layer }));
      go(ctx, r, 'l_ctlBase', { layer });
      return;
    case 'l_mrgFrom':
      go(ctx, r, 'l_mrgTo', { from: layer });
      ctx.say(ctx.msg('selectedLayers', { layers: layer }));
      return;
    case 'l_mrgTo':
      if (layer === d.from) {
        ctx.say(ctx.msg('sameLayer'));
        return;
      }
      go(ctx, r, 'l_mrgConfirm', { layer });
      ctx.say(ctx.msg('mergeWarning', { from: d.from ?? '', to: layer }));
      return;
    case 'l_delPick':
      go(ctx, r, 'l_delConfirm', { layer });
      ctx.say(ctx.msg('deleteWarning', { layer }));
      return;
    case 'l_geGroup': {
      const [name] = groupsOf(ctx, [handle]);
      if (!name) {
        ctx.say(ctx.msg('notInGroup'));
        return;
      }
      go(ctx, r, 'l_geOpt', { group: name });
      return;
    }
    case 'l_geAdd':
    case 'l_geRemove': {
      const group = d.group ? ctx.shown.groups.get(d.group) : undefined;
      if (!d.group || !group) return ctx.finish();
      const handles: string[] =
        r.step === 'l_geAdd'
          ? [...new Set([...group.handles, handle])]
          : group.handles.filter((h) => h !== handle);
      ctx.add([{ kind: 'set_group', name: d.group, handles, block: group.block }]);
      return;
    }
    case 'l_insPick':
      if (!isBlock(ctx, index)) {
        ctx.say(ctx.msg('notBlock'));
        return;
      }
      go(ctx, r, 'l_insAt', { source: index });
      return;
    case 'l_attPick':
      if (!isBlock(ctx, index)) {
        ctx.say(ctx.msg('notBlock'));
        return;
      }
      ctx.openDialog?.({ kind: 'attributes', index });
      ctx.finish();
      return;
    default:
      return;
  }
}

function copyTo<R extends ExtraRun>(ctx: ExtraContext<R>, layer: string, dx: number, dy: number) {
  if (!layer) return ctx.finish();
  const edits: CanvasEdit[] = copyEdits(ctx.handles, dx, dy, layer);
  ctx.add(edits);
  ctx.say(ctx.msg('copiedToLayer', { count: ctx.handles.length, layer }));
  ctx.finish();
}

/** Where a block reference sits: the middle of its drawn box (moves applied). */
function blockCentre<R extends ExtraRun>(ctx: ExtraContext<R>, index: number): Point {
  const t = ctx.shown.transformOf.get(index);
  const b = t ? boxThrough(t, boxOf(ctx.scene, index)) : boxOf(ctx.scene, index);
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

export function layerSketch(r: ExtraRun, at: Point): { points: Point[]; closed: boolean } | null {
  if (r.step === 'l_ctlSecond' && r.base) return { points: [r.base, at], closed: false };
  return null;
}
