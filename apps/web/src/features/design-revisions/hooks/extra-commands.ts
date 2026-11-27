import { applyAffine, boxThrough } from '../model/affine';
import { acadNumber, type CommandId, type CommandOption, type Point } from '../model/cad-commands';
import {
  curveEdit,
  pointsCurveEdit,
  roundCoord,
  setCurveEdit,
  type CanvasEdit,
} from '../model/canvas-edit';
import {
  arrayOffsets,
  asLoop,
  breakCurve,
  chainLoop,
  cvSpline,
  divideCurve,
  ellipsePoints,
  fitSpline,
  helixPoints,
  lengthenEnd,
  loopAround,
  measureCurve,
  polygonOnEdge,
  polygonPoints,
  splitAt,
} from '../model/draw-shapes';
import { effectiveLayer, type DrawingPreview } from '../model/drawing-preview';
import { HATCH_FIELD_DEFAULTS } from '../model/hatch-patterns';
import { boxOf, type DrawingScene } from '../model/drawing-scene';
import { curveLength, distance, GeometryError, nearestOnCurve, type Pt } from '../model/geometry';
import type { Bounds } from '../model/view-transform';
import type { WorkspaceDialog } from './use-drawing-viewer';
import type { LayerScreen } from './use-layer-screen';
import {
  DEFAULT_MATCH_SETTINGS,
  isMatchCommand,
  MATCH_OBJECT_STEPS,
  matchAfterSelect,
  matchBegin,
  matchObject,
  matchOption,
  matchPrompt,
  type MatchSettings,
} from './match-commands';
import {
  blockAfterSelect,
  isLayerCommand,
  LAYER_OBJECT_STEPS,
  LAYER_TRACKED,
  layerAfterSelect,
  layerBegin,
  layerEnter,
  layerObject,
  layerOption,
  layerPoint,
  layerPrompt,
  layerSketch,
  layerText,
  type LayerPromptKey,
  type LayerStep,
} from './layer-commands';
import {
  DEFAULT_HATCH_SETTINGS,
  HATCH_OBJECT_STEPS,
  hatchBegin,
  hatchEnter,
  hatchObject,
  hatchOption,
  hatchPoint,
  hatchPrompt,
  isHatchCommand,
  type HatchPromptKey,
  type HatchSettings,
  type HatchStep,
} from './hatch-command';
import {
  DEFAULT_TEXT_SETTINGS,
  isTextCommand,
  TEXT_OBJECT_STEPS,
  TEXT_TRACKED,
  textAfterSelect,
  textBegin,
  textEnter,
  textNumber,
  textObject,
  textOption,
  textPoint,
  textPrompt,
  textSketch,
  textText,
  type TextPromptKey,
  type TextStep,
  type TextToolSettings,
} from './text-commands';
import {
  isMoreCommand,
  MORE_OBJECT_STEPS,
  MORE_TRACKED,
  moreAfterSelect,
  moreBegin,
  moreEnter,
  moreNumber,
  moreObject,
  moreOption,
  morePoint,
  morePrompt,
  moreSketch,
  type MorePromptKey,
  type MoreStep,
} from './more-commands';
import type { UndoControl, ZoomView } from './view-commands';

/**
 * The Draw and Modify commands added for the owner (2026-11-24), on the same command line as the
 * others: BREAK, BREAKATPOINT, LENGTHEN, REVERSE, ARRAYRECT, OVERKILL, DRAWORDER, SPLINE, ELLIPSE,
 * POLYGON, XLINE, RAY, DIVIDE, MEASURE, REGION, HATCH, GRADIENT, BOUNDARY, WIPEOUT, HELIX and
 * DONUT. Curves they draw are kept as polylines (`add_curve`), shapes the build does not read as
 * screen shapes (`add_shape`), the draw order as `set_order`. Prompts follow AutoCAD's.
 */

export const EXTRA_COMMANDS: ReadonlySet<CommandId> = new Set<CommandId>([
  'break',
  'breakatpoint',
  'lengthen',
  'reverse',
  'arrayrect',
  'overkill',
  'draworder',
  'spline',
  'ellipse',
  'polygon',
  'xline',
  'ray',
  'divide',
  'measure',
  'region',
  'hatch',
  'gradient',
  'boundary',
  'wipeout',
  'helix',
  'donut',
]);

/** Commands that start with «Select objects:» (noun-verb or verb-noun). */
const SELECTING_EXTRA: ReadonlySet<CommandId> = new Set<CommandId>([
  'reverse',
  'arrayrect',
  'overkill',
  'draworder',
  'region',
]);

export type ExtraStep =
  | MoreStep
  | LayerStep
  | HatchStep
  | TextStep
  | 'x_brPick'
  | 'x_brFirst'
  | 'x_brSecond'
  | 'x_bapPick'
  | 'x_bapPoint'
  | 'x_lenPick'
  | 'x_lenValue'
  | 'x_lenChange'
  | 'x_arrOpt'
  | 'x_arrCols'
  | 'x_arrRows'
  | 'x_arrColSp'
  | 'x_arrRowSp'
  | 'x_ordOpt'
  | 'x_ordRef'
  | 'x_splFirst'
  | 'x_splNext'
  | 'x_splMethod'
  | 'x_xlPoint'
  | 'x_xlThrough'
  | 'x_rayStart'
  | 'x_rayThrough'
  | 'x_divPick'
  | 'x_divCount'
  | 'x_mePick'
  | 'x_meLength'
  | 'x_boPick'
  | 'x_wipeFirst'
  | 'x_wipeNext'
  | 'x_wipePoly'
  | 'x_helCenter'
  | 'x_helBase'
  | 'x_helTop'
  | 'x_helTurns'
  | 'x_helHeight'
  | 'x_doInner'
  | 'x_doOuter'
  | 'x_doCenter'
  | 'x_polSides'
  | 'x_polCenter'
  | 'x_polMode'
  | 'x_polRadius'
  | 'x_polEdge1'
  | 'x_polEdge2'
  | 'x_elAxis'
  | 'x_elOther'
  | 'x_elCenter'
  | 'x_elAxisEnd'
  | 'x_elDist'
  | 'x_elRotation'
  | 'x_elStart'
  | 'x_elEnd';

/** Prompts of the added commands (i18n keys under `design.cad.cmd`). */
export type ExtraPromptKey =
  | MorePromptKey
  | LayerPromptKey
  | 'matchSource'
  | 'matchDest'
  | HatchPromptKey
  | TextPromptKey
  | 'breakSelect'
  | 'breakFirst'
  | 'breakSecond'
  | 'breakAtPoint'
  | 'lengthenSelect'
  | 'lengthenDelta'
  | 'lengthenTotal'
  | 'lengthenPercent'
  | 'lengthenChange'
  | 'arrayOptions'
  | 'arrayColumns'
  | 'arrayRows'
  | 'arrayColumnSpacing'
  | 'arrayRowSpacing'
  | 'orderOption'
  | 'orderReference'
  | 'splineFirst'
  | 'splineNext'
  | 'splineMethod'
  | 'xlinePoint'
  | 'xlineThrough'
  | 'rayStart'
  | 'divideSelect'
  | 'divideCount'
  | 'measureSelect'
  | 'measureLength'
  | 'wipeoutFirst'
  | 'wipeoutNext'
  | 'wipeoutPolyline'
  | 'helixCenter'
  | 'helixBase'
  | 'helixTop'
  | 'helixTurns'
  | 'helixHeight'
  | 'donutInner'
  | 'donutOuter'
  | 'donutCenter'
  | 'polygonSides'
  | 'polygonCenter'
  | 'polygonMode'
  | 'polygonRadius'
  | 'polygonEdge1'
  | 'polygonEdge2'
  | 'ellipseAxis'
  | 'ellipseArcAxis'
  | 'ellipseOther'
  | 'ellipseCenter'
  | 'ellipseAxisEnd'
  | 'ellipseDistance'
  | 'ellipseRotation'
  | 'ellipseStart'
  | 'ellipseEnd';

/** Steps that wait for an object pick (a click picks, a typed point is refused). */
export const EXTRA_OBJECT_STEPS: readonly string[] = [
  ...MORE_OBJECT_STEPS,
  ...LAYER_OBJECT_STEPS,
  ...MATCH_OBJECT_STEPS,
  ...TEXT_OBJECT_STEPS,
  ...HATCH_OBJECT_STEPS,
  'x_brPick',
  'x_bapPick',
  'x_lenPick',
  'x_lenChange',
  'x_ordRef',
  'x_divPick',
  'x_mePick',
  'x_wipePoly',
];
/** Steps that follow the pointer for the rubber band. */
export const EXTRA_TRACKED: readonly string[] = [
  ...MORE_TRACKED,
  ...LAYER_TRACKED,
  ...TEXT_TRACKED,
  'x_brSecond',
  'x_bapPoint',
  'x_splNext',
  'x_xlThrough',
  'x_rayThrough',
  'x_wipeNext',
  'x_helBase',
  'x_helTop',
  'x_helHeight',
  'x_doCenter',
  'x_polRadius',
  'x_polEdge2',
  'x_elOther',
  'x_elAxisEnd',
  'x_elDist',
  'x_elStart',
  'x_elEnd',
];

/** What the added commands remember between runs (AutoCAD keeps the last values). */
export interface ExtraSettings {
  /** The Hatch Creation tab (ADR-055 part 8). */
  hatch: HatchSettings;
  donut: { inner: number; outer: number };
  polygon: { sides: number; inscribed: boolean };
  lengthen: { mode: 'DE' | 'T' | 'P'; value: number };
  helixTurns: number;
  /** HELIX height: asked as AutoCAD does, though a 2D view only shows the turns. */
  helixHeight: number;
  splineCv: boolean;
  /** PICKSTYLE: picking one member of a group picks the whole group. */
  groupPick: boolean;
  /** The Text panel's last answers (ADR-055 part 7). */
  text: TextToolSettings;
  /** MATCHPROP's Property Settings (item 34). */
  match: MatchSettings;
}

export const DEFAULT_EXTRA_SETTINGS: ExtraSettings = {
  hatch: DEFAULT_HATCH_SETTINGS,
  donut: { inner: 0.5, outer: 1 },
  polygon: { sides: 4, inscribed: true },
  lengthen: { mode: 'DE', value: 0 },
  helixTurns: 3,
  helixHeight: 1,
  splineCv: false,
  groupPick: true,
  text: DEFAULT_TEXT_SETTINGS,
  match: DEFAULT_MATCH_SETTINGS,
};

/** Per run: what the added command has taken so far. */
export interface ExtraData {
  target?: number;
  /** BREAK's first point, the ellipse's centre, the polygon's centre. */
  at?: Point;
  /** XLINE Hor / Ver: the direction of every line. */
  fixed?: Pt;
  ellipse?: { center: Pt; axis: Pt; ratio: number };
  arc?: boolean;
  startAngle?: number;
  baseRadius?: number;
  topRadius?: number;
  columns?: number;
  rows?: number;
  columnSpacing?: number;
  rowSpacing?: number;
  order?: 'A' | 'U';
  refs?: number[];
  splineCv?: boolean;
  /** An option chosen before the objects were picked (ribbon «Bring to Front» and the like). */
  pending?: string;
}

/** The part of the workspace's run the added commands read and write. */
export interface ExtraRun {
  cmd: CommandId;
  step: string;
  points: Point[];
  base: Point | null;
  made: number[];
  flags: { extra?: ExtraData };
}

export interface ExtraContext<R extends ExtraRun> {
  scene: DrawingScene;
  shown: DrawingPreview;
  selection: ReadonlySet<number>;
  handles: string[];
  drawLayer: string;
  editCount: number;
  settings: ExtraSettings;
  setSettings: (patch: Partial<ExtraSettings>) => void;
  say: (...lines: string[]) => void;
  msg: (key: string, params?: Record<string, string | number>) => string;
  add: (edits: CanvasEdit[]) => number[];
  finish: (keepSelection?: boolean) => void;
  setRun: (run: R) => void;
  setSelection: (selection: ReadonlySet<number>) => void;
  curveGeom: (index: number) => { points: Pt[]; closed: boolean } | null;
  pickable: (index: number) => boolean;
  layerNameOf: (index: number) => string;
  needDrawLayer: () => boolean;
  geometryMessage: (caught: unknown) => void;
  /** Takes back the last `count` edits (a command's Undo option). */
  drop?: (count: number) => void;
  /** Layers an item may move to (they have a usable rule). */
  usableLayers: readonly string[];
  layerScreen?: LayerScreen;
  openDialog?: (dialog: WorkspaceDialog | null) => void;
  /** ZOOM / PAN / REGEN: the view of the drawing (round 3). */
  view?: ZoomView;
  /** U / UNDO / REDO / OOPS typed (round 3). */
  undo?: UndoControl;
}

interface Prompt {
  key: ExtraPromptKey | 'selectObjects';
  options: CommandOption[];
  fallback: string | null;
}

const opt = (word: string, key: string): CommandOption => ({ word, key });
const pt = (p: Point): Pt => [p.x, p.y];
const xy = (p: Pt): Point => ({ x: p[0], y: p[1] });
const angleDeg = (from: Pt, to: Pt) =>
  (Math.atan2(to[1] - from[1], to[0] - from[0]) * 180) / Math.PI;

const go = <R extends ExtraRun>(
  ctx: ExtraContext<R>,
  r: R,
  step: ExtraStep,
  patch: Partial<ExtraData> = {},
  points?: Point[],
) =>
  ctx.setRun({
    ...r,
    step,
    points: points ?? r.points,
    flags: { ...r.flags, extra: { ...r.flags.extra, ...patch } },
  });

const data = (r: ExtraRun): ExtraData => r.flags.extra ?? {};

/** Whether the run is one of the added commands. */
export const isExtra = (cmd: CommandId) =>
  EXTRA_COMMANDS.has(cmd) ||
  isLayerCommand(cmd) ||
  isTextCommand(cmd) ||
  isMatchCommand(cmd) ||
  isMoreCommand(cmd);

// ---------- prompts ----------

export function extraPrompt(r: ExtraRun, settings: ExtraSettings): Prompt | null {
  if (isMoreCommand(r.cmd)) return morePrompt(r);
  if (isLayerCommand(r.cmd)) return layerPrompt(r);
  if (isMatchCommand(r.cmd)) return matchPrompt(r);
  if (isTextCommand(r.cmd)) return textPrompt(r, settings.text);
  if (isHatchCommand(r.cmd)) return hatchPrompt(r);
  const p = (
    key: Prompt['key'],
    options: CommandOption[] = [],
    fallback: string | null = null,
  ): Prompt => ({ key, options, fallback });
  const d = data(r);
  switch (r.step as ExtraStep) {
    case 'x_brPick':
      return p('breakSelect');
    case 'x_brFirst':
      return p('breakFirst');
    case 'x_brSecond':
      return p('breakSecond', [opt('First point', 'F')]);
    case 'x_bapPick':
      return p('breakSelect');
    case 'x_bapPoint':
      return p('breakAtPoint');
    case 'x_lenPick':
      return p(
        'lengthenSelect',
        [opt('DElta', 'DE'), opt('Percent', 'P'), opt('Total', 'T')],
        null,
      );
    case 'x_lenValue':
      return settings.lengthen.mode === 'T'
        ? p('lengthenTotal', [], acadNumber(settings.lengthen.value))
        : settings.lengthen.mode === 'P'
          ? p('lengthenPercent', [], acadNumber(settings.lengthen.value || 100))
          : p('lengthenDelta', [], acadNumber(settings.lengthen.value));
    case 'x_lenChange':
      return p('lengthenChange', [opt('Undo', 'U')]);
    case 'x_arrOpt':
      return p(
        'arrayOptions',
        [
          opt('COUnt', 'COU'),
          opt('Spacing', 'S'),
          opt('COLumns', 'COL'),
          opt('Rows', 'R'),
          opt('eXit', 'X'),
        ],
        'eXit',
      );
    case 'x_arrCols':
      return p('arrayColumns', [], String(d.columns ?? 4));
    case 'x_arrRows':
      return p('arrayRows', [], String(d.rows ?? 3));
    case 'x_arrColSp':
      return p('arrayColumnSpacing', [], acadNumber(d.columnSpacing ?? 0));
    case 'x_arrRowSp':
      return p('arrayRowSpacing', [], acadNumber(d.rowSpacing ?? 0));
    case 'x_ordOpt':
      return p(
        'orderOption',
        [opt('Above objects', 'A'), opt('Under objects', 'U'), opt('Front', 'F'), opt('Back', 'B')],
        'Back',
      );
    case 'x_ordRef':
      return p('orderReference');
    case 'x_splFirst':
      return p('splineFirst', [opt('Method', 'M')]);
    case 'x_splNext':
      // Undo once there are two points, Close once there are three (AutoCAD's order).
      return p(
        'splineNext',
        r.points.length >= 3
          ? [opt('Undo', 'U'), opt('Close', 'C')]
          : r.points.length >= 2
            ? [opt('Undo', 'U')]
            : [],
      );
    case 'x_splMethod':
      return p('splineMethod', [opt('Fit', 'F'), opt('CV', 'CV')], d.splineCv ? 'CV' : 'Fit');
    case 'x_xlPoint':
      return p('xlinePoint', [opt('Hor', 'H'), opt('Ver', 'V')]);
    case 'x_xlThrough':
    case 'x_rayThrough':
      return p('xlineThrough');
    case 'x_rayStart':
      return p('rayStart');
    case 'x_divPick':
      return p('divideSelect');
    case 'x_divCount':
      return p('divideCount');
    case 'x_mePick':
      return p('measureSelect');
    case 'x_meLength':
      return p('measureLength');
    case 'x_boPick':
      return p('hatchPick');
    case 'x_wipeFirst':
      return p('wipeoutFirst', [opt('Polyline', 'P')], 'Polyline');
    case 'x_wipeNext':
      return p(
        'wipeoutNext',
        r.points.length >= 3 ? [opt('Close', 'C'), opt('Undo', 'U')] : [opt('Undo', 'U')],
      );
    case 'x_wipePoly':
      return p('wipeoutPolyline');
    case 'x_helCenter':
      return p('helixCenter');
    case 'x_helBase':
      return p('helixBase', [], acadNumber(1));
    case 'x_helTop':
      return p('helixTop', [], acadNumber(d.baseRadius ?? 1));
    case 'x_helTurns':
      return p('helixTurns', [], acadNumber(settings.helixTurns));
    case 'x_helHeight':
      return p('helixHeight', [opt('Turns', 'T')], acadNumber(settings.helixHeight));
    case 'x_doInner':
      return p('donutInner', [], acadNumber(settings.donut.inner));
    case 'x_doOuter':
      return p('donutOuter', [], acadNumber(settings.donut.outer));
    case 'x_doCenter':
      return p('donutCenter', [], 'exit');
    case 'x_polSides':
      return p('polygonSides', [], String(settings.polygon.sides));
    case 'x_polCenter':
      return p('polygonCenter', [opt('Edge', 'E')]);
    case 'x_polMode':
      return p(
        'polygonMode',
        [opt('Inscribed in circle', 'I'), opt('Circumscribed about circle', 'C')],
        settings.polygon.inscribed ? 'I' : 'C',
      );
    case 'x_polRadius':
      return p('polygonRadius');
    case 'x_polEdge1':
      return p('polygonEdge1');
    case 'x_polEdge2':
      return p('polygonEdge2');
    case 'x_elAxis':
      return d.arc
        ? p('ellipseArcAxis', [opt('Center', 'C')])
        : p('ellipseAxis', [opt('Arc', 'A'), opt('Center', 'C')]);
    case 'x_elOther':
      return p('ellipseOther');
    case 'x_elCenter':
      return p('ellipseCenter');
    case 'x_elAxisEnd':
      return p('ellipseAxisEnd');
    case 'x_elDist':
      return p('ellipseDistance', [opt('Rotation', 'R')]);
    case 'x_elRotation':
      return p('ellipseRotation');
    case 'x_elStart':
      return p('ellipseStart');
    case 'x_elEnd':
      return p('ellipseEnd', [opt('Included angle', 'I')]);
  }
  return null;
}

// ---------- start ----------

/**
 * Starts an added command. Returns the step to start on, or null when it finished at once
 * (noun-verb on picked objects).
 */
export function extraBegin<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  cmd: CommandId,
  fresh: (step: string) => R,
): R | null {
  if (isLayerCommand(cmd)) return layerBegin(ctx, cmd, fresh);
  if (isMatchCommand(cmd)) return matchBegin(ctx, fresh);
  if (isTextCommand(cmd)) return textBegin(ctx, cmd, fresh);
  if (isHatchCommand(cmd)) return hatchBegin(ctx, cmd, fresh);
  if (isMoreCommand(cmd)) return moreBegin(ctx, cmd, fresh);
  const picked = ctx.handles.length > 0;
  const start = (step: ExtraStep, extra: ExtraData = {}): R => {
    const r = fresh(step);
    const run = { ...r, flags: { ...r.flags, extra } };
    ctx.setRun(run);
    return run;
  };
  if (SELECTING_EXTRA.has(cmd)) {
    const r = fresh('select');
    if (picked) return extraAfterSelect(ctx, r);
    ctx.setRun(r);
    return r;
  }
  ctx.setSelection(new Set());
  switch (cmd) {
    case 'break':
      return start('x_brPick');
    case 'breakatpoint':
      return start('x_bapPick');
    case 'lengthen':
      return start('x_lenPick');
    case 'spline':
      ctx.say(ctx.msg('splineSettings', { method: ctx.settings.splineCv ? 'CV' : 'Fit' }));
      return start('x_splFirst', { splineCv: ctx.settings.splineCv });
    case 'ellipse':
      return start('x_elAxis');
    case 'polygon':
      return start('x_polSides');
    case 'xline':
      return start('x_xlPoint');
    case 'ray':
      return start('x_rayStart');
    case 'divide':
      return start('x_divPick');
    case 'measure':
      return start('x_mePick');
    case 'boundary':
      return start('x_boPick');
    case 'wipeout':
      return start('x_wipeFirst');
    case 'helix':
      ctx.say(ctx.msg('helixSettings', { turns: acadNumber(ctx.settings.helixTurns) }));
      return start('x_helCenter');
    case 'donut':
      return start('x_doInner');
    default:
      return null;
  }
}

/**
 * After «Select objects:» of REVERSE, ARRAYRECT, OVERKILL, DRAWORDER, REGION: the run that goes
 * on, or null when the command is done.
 */
export function extraAfterSelect<R extends ExtraRun>(ctx: ExtraContext<R>, r: R): R | null {
  if (r.cmd === 'block') {
    blockAfterSelect(ctx, r);
    return null;
  }
  if (isLayerCommand(r.cmd)) return layerAfterSelect(ctx, r);
  if (isMatchCommand(r.cmd)) return matchAfterSelect(ctx, r);
  if (isTextCommand(r.cmd)) return textAfterSelect(ctx, r);
  if (isMoreCommand(r.cmd)) return moreAfterSelect(ctx, r);
  if (ctx.handles.length === 0) {
    ctx.finish();
    return null;
  }
  switch (r.cmd) {
    case 'reverse': {
      const out: CanvasEdit[] = [];
      for (const index of ctx.selection) {
        const geom = ctx.curveGeom(index);
        const handle = ctx.scene.view.entities[index]?.handle;
        if (!geom || !handle) continue;
        out.push(setCurveEdit(handle, [...geom.points].reverse(), geom.closed));
      }
      if (out.length > 0) ctx.add(out);
      ctx.say(ctx.msg('reversed', { count: out.length }));
      ctx.finish();
      return null;
    }
    case 'overkill': {
      const gone = duplicates(ctx);
      if (gone.length > 0) ctx.add(gone.map((handle) => ({ kind: 'erase_item', handle })));
      ctx.say(ctx.msg('overkillDone', { count: gone.length }));
      ctx.finish();
      return null;
    }
    case 'region':
      region(ctx);
      return null;
    case 'arrayrect': {
      const box = selectionBox(ctx);
      const w = box ? box.maxX - box.minX : 0;
      const h = box ? box.maxY - box.minY : 0;
      const side = Math.max(w, h, 1);
      ctx.say(ctx.msg('arraySettings'));
      const run = {
        ...r,
        step: 'x_arrOpt',
        flags: {
          ...r.flags,
          extra: {
            columns: 4,
            rows: 3,
            columnSpacing: roundCoord((w || side) * 1.5),
            rowSpacing: roundCoord((h || side) * 1.5),
          },
        },
      };
      ctx.setRun(run);
      ctx.say(ctx.msg('arrayCount', { columns: 4, rows: 3 }));
      return run;
    }
    case 'draworder': {
      const run = { ...r, step: 'x_ordOpt' };
      ctx.setRun(run);
      const pending = data(r).pending;
      if (pending) {
        extraOption(ctx, run, pending);
        return null;
      }
      return run;
    }
    default:
      ctx.finish();
      return null;
  }
}

// ---------- entries ----------

export function extraPoint<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, p: Point): void {
  if (isLayerCommand(r.cmd)) return layerPoint(ctx, r, p);
  if (isTextCommand(r.cmd)) return textPoint(ctx, r, p);
  if (isHatchCommand(r.cmd)) return hatchPoint(ctx, r, p);
  if (isMoreCommand(r.cmd)) return morePoint(ctx, r, p);
  const d = data(r);
  const s = ctx.settings;
  try {
    switch (r.step as ExtraStep) {
      case 'x_brFirst':
        go(ctx, r, 'x_brSecond', { at: p });
        return;
      case 'x_brSecond':
        breakAt(ctx, d.target ?? -1, d.at ?? p, p);
        return;
      case 'x_bapPoint':
        breakAtPoint(ctx, d.target ?? -1, p);
        return;
      case 'x_splFirst':
        if (!ctx.needDrawLayer()) return;
        go(ctx, r, 'x_splNext', {}, [p]);
        return;
      case 'x_splNext':
        go(ctx, r, 'x_splNext', {}, [...r.points, p]);
        return;
      case 'x_xlPoint':
        if (!ctx.needDrawLayer()) return;
        if (d.fixed) {
          addShape(ctx, 'xline', [pt(p), [p.x + d.fixed[0], p.y + d.fixed[1]]]);
          return;
        }
        go(ctx, r, 'x_xlThrough', {}, [p]);
        return;
      case 'x_xlThrough':
      case 'x_rayThrough': {
        const from = r.points[0];
        if (!from || (from.x === p.x && from.y === p.y)) {
          ctx.say(ctx.msg('badPoint'));
          return;
        }
        addShape(ctx, r.step === 'x_rayThrough' ? 'ray' : 'xline', [pt(from), pt(p)]);
        return;
      }
      case 'x_rayStart':
        if (!ctx.needDrawLayer()) return;
        go(ctx, r, 'x_rayThrough', {}, [p]);
        return;
      case 'x_boPick': {
        const loop = loopAround(loopsNear(ctx, pt(p)), pt(p));
        if (!loop) {
          ctx.say(ctx.msg('hatchNone'));
          return;
        }
        if (!ctx.needDrawLayer()) return;
        ctx.add([pointsCurveEdit(ctx.drawLayer, loop, true)]);
        ctx.say(ctx.msg('boundaryDone'));
        return;
      }
      case 'x_wipeFirst':
        if (!ctx.needDrawLayer()) return;
        go(ctx, r, 'x_wipeNext', {}, [p]);
        return;
      case 'x_wipeNext':
        go(ctx, r, 'x_wipeNext', {}, [...r.points, p]);
        return;
      case 'x_helCenter':
        if (!ctx.needDrawLayer()) return;
        go(ctx, r, 'x_helBase', { at: p });
        return;
      case 'x_helBase':
        if (d.at) extraNumber(ctx, r, distance(pt(d.at), pt(p)));
        return;
      case 'x_helTop':
        if (d.at) extraNumber(ctx, r, distance(pt(d.at), pt(p)));
        return;
      case 'x_helHeight':
        if (d.at) extraNumber(ctx, r, distance(pt(d.at), pt(p)));
        return;
      case 'x_doCenter':
        if (!ctx.needDrawLayer()) return;
        addShape(ctx, 'donut', [pt(p)], { inner: s.donut.inner, outer: s.donut.outer });
        return;
      case 'x_polCenter':
        if (!ctx.needDrawLayer()) return;
        go(ctx, r, 'x_polMode', { at: p });
        return;
      case 'x_polRadius': {
        if (!d.at) return;
        const c = pt(d.at);
        const radius = distance(c, pt(p));
        const angle = angleDeg(c, pt(p));
        // The point gives the radius and the direction (a vertex, or an edge's middle).
        polygon(ctx, polygonPoints(c, s.polygon.sides, radius, s.polygon.inscribed, angle));
        return;
      }
      case 'x_polEdge1':
        if (!ctx.needDrawLayer()) return;
        go(ctx, r, 'x_polEdge2', { at: p });
        return;
      case 'x_polEdge2':
        if (d.at) polygon(ctx, polygonOnEdge(pt(d.at), pt(p), s.polygon.sides));
        return;
      case 'x_elAxis':
        if (!ctx.needDrawLayer()) return;
        go(ctx, r, 'x_elOther', { at: p });
        return;
      case 'x_elOther': {
        if (!d.at) return;
        const a = pt(d.at);
        const b = pt(p);
        if (distance(a, b) === 0) throw new GeometryError('SHAPE');
        const center: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        go(ctx, r, 'x_elDist', {
          ellipse: { center, axis: [b[0] - center[0], b[1] - center[1]], ratio: 1 },
        });
        return;
      }
      case 'x_elCenter':
        if (!ctx.needDrawLayer()) return;
        go(ctx, r, 'x_elAxisEnd', { at: p });
        return;
      case 'x_elAxisEnd': {
        if (!d.at) return;
        const center = pt(d.at);
        const axis: Pt = [p.x - center[0], p.y - center[1]];
        if (Math.hypot(axis[0], axis[1]) === 0) throw new GeometryError('SHAPE');
        go(ctx, r, 'x_elDist', { ellipse: { center, axis, ratio: 1 } });
        return;
      }
      case 'x_elDist': {
        if (!d.ellipse) return;
        const other = otherAxis(d.ellipse, pt(p));
        extraNumber(ctx, r, other);
        return;
      }
      case 'x_elStart':
      case 'x_elEnd': {
        if (!d.ellipse) return;
        extraNumber(ctx, r, ellipseAngle(d.ellipse, pt(p)));
        return;
      }
      default:
        ctx.say(ctx.msg('badSelection'));
    }
  } catch (caught) {
    ctx.geometryMessage(caught);
  }
}

export function extraNumber<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, value: number): void {
  if (isMoreCommand(r.cmd)) return moreNumber(ctx, r, value);
  if (isTextCommand(r.cmd)) return textNumber(ctx, r, value);
  if (isHatchCommand(r.cmd)) {
    ctx.say(ctx.msg('badPoint'));
    return;
  }
  if (isLayerCommand(r.cmd)) {
    ctx.say(ctx.msg('badValue'));
    return;
  }
  const d = data(r);
  const s = ctx.settings;
  const positive = (then: () => void, allowZero = false) => {
    if (value > 0 || (allowZero && value === 0)) then();
    else ctx.say(ctx.msg('badValue'));
  };
  try {
    switch (r.step as ExtraStep) {
      case 'x_lenValue':
        if (s.lengthen.mode !== 'DE' && !(value > 0)) {
          ctx.say(ctx.msg('badValue'));
          return;
        }
        ctx.setSettings({ lengthen: { mode: s.lengthen.mode, value } });
        go(ctx, r, 'x_lenChange');
        return;
      case 'x_arrCols':
        positive(() => {
          if (!Number.isInteger(value)) return ctx.say(ctx.msg('badValue'));
          // COUnt asks for the rows next; COLumns goes back to the options.
          go(ctx, r, d.refs?.length === 1 ? 'x_arrRows' : 'x_arrOpt', { columns: value });
        });
        return;
      case 'x_arrRows':
        positive(() => {
          if (!Number.isInteger(value)) return ctx.say(ctx.msg('badValue'));
          go(ctx, r, 'x_arrOpt', { rows: value, refs: [] });
        });
        return;
      case 'x_arrColSp':
        go(ctx, r, d.refs?.length === 1 ? 'x_arrRowSp' : 'x_arrOpt', { columnSpacing: value });
        return;
      case 'x_arrRowSp':
        go(ctx, r, 'x_arrOpt', { rowSpacing: value, refs: [] });
        return;
      case 'x_divCount':
        if (!(Number.isInteger(value) && value >= 2 && value <= 32767)) {
          ctx.say(ctx.msg('divideRange'));
          return;
        }
        divideOrMeasure(ctx, d.target ?? -1, (g) => divideCurve(g.points, g.closed, value));
        return;
      case 'x_meLength':
        positive(() =>
          divideOrMeasure(ctx, d.target ?? -1, (g) => measureCurve(g.points, g.closed, value)),
        );
        return;
      case 'x_helBase':
        positive(() => go(ctx, r, 'x_helTop', { baseRadius: value }));
        return;
      case 'x_helTop':
        positive(() => go(ctx, r, 'x_helHeight', { topRadius: value }), true);
        return;
      case 'x_helTurns':
        // Turns: AutoCAD asks the height again after it.
        positive(() => {
          ctx.setSettings({ helixTurns: value });
          go(ctx, r, 'x_helHeight');
        });
        return;
      case 'x_helHeight':
        positive(() => {
          ctx.setSettings({ helixHeight: value });
          helix(ctx, d, s.helixTurns);
        });
        return;
      case 'x_doInner':
        if (value < 0) return ctx.say(ctx.msg('badValue'));
        ctx.setSettings({ donut: { ...s.donut, inner: value } });
        go(ctx, r, 'x_doOuter');
        return;
      case 'x_doOuter':
        if (!(value > s.donut.inner)) return ctx.say(ctx.msg('badValue'));
        ctx.setSettings({ donut: { ...s.donut, outer: value } });
        go(ctx, r, 'x_doCenter');
        return;
      case 'x_polSides':
        if (!(Number.isInteger(value) && value >= 3 && value <= 1024)) {
          ctx.say(ctx.msg('polygonSidesRange'));
          return;
        }
        ctx.setSettings({ polygon: { ...s.polygon, sides: value } });
        go(ctx, r, 'x_polCenter');
        return;
      case 'x_polRadius':
        positive(() => {
          if (!d.at) return;
          polygon(ctx, polygonPoints(pt(d.at), s.polygon.sides, value, s.polygon.inscribed));
        });
        return;
      case 'x_elDist':
        positive(() => {
          if (!d.ellipse) return;
          const major = Math.hypot(d.ellipse.axis[0], d.ellipse.axis[1]);
          ellipseDone(ctx, r, { ...d.ellipse, ratio: value / major });
        });
        return;
      case 'x_elRotation':
        if (!d.ellipse || !(Math.abs(value) < 89.4)) return ctx.say(ctx.msg('badValue'));
        ellipseDone(ctx, r, { ...d.ellipse, ratio: Math.cos((value * Math.PI) / 180) });
        return;
      case 'x_elStart':
        go(ctx, r, 'x_elEnd', { startAngle: value });
        return;
      case 'x_elEnd':
        if (!d.ellipse) return;
        curve(
          ctx,
          ellipsePoints(
            d.ellipse.center,
            d.ellipse.axis,
            d.ellipse.ratio,
            d.startAngle ?? 0,
            value,
          ),
          false,
        );
        return;
      default:
        ctx.say(ctx.msg('badValue'));
    }
  } catch (caught) {
    ctx.geometryMessage(caught);
  }
}

export function extraOption<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, key: string): void {
  if (isLayerCommand(r.cmd)) return layerOption(ctx, r, key);
  if (isMatchCommand(r.cmd)) return matchOption(ctx, r, key);
  if (isTextCommand(r.cmd)) return textOption(ctx, r, key);
  if (isHatchCommand(r.cmd)) return hatchOption(ctx, r, key);
  if (isMoreCommand(r.cmd)) return moreOption(ctx, r, key);
  const d = data(r);
  const s = ctx.settings;
  try {
    switch (r.step as ExtraStep) {
      case 'x_brSecond':
        if (key === 'F') go(ctx, r, 'x_brFirst');
        return;
      case 'x_lenPick':
        ctx.setSettings({
          lengthen: { mode: key as 'DE' | 'T' | 'P', value: key === 'P' ? 100 : s.lengthen.value },
        });
        go(ctx, r, 'x_lenValue');
        return;
      case 'x_lenChange':
        if (key !== 'U') return;
        if (r.made.length === 0 || !ctx.drop) {
          ctx.say(ctx.msg('nothingToUndo'));
          return;
        }
        ctx.drop(r.made[r.made.length - 1] ?? 0);
        ctx.setRun({ ...r, made: r.made.slice(0, -1) });
        return;
      case 'x_arrOpt':
        if (key === 'X') return arrayDone(ctx, d);
        if (key === 'COU') return go(ctx, r, 'x_arrCols', { refs: [1] });
        if (key === 'COL') return go(ctx, r, 'x_arrCols', { refs: [] });
        if (key === 'R') return go(ctx, r, 'x_arrRows');
        if (key === 'S') return go(ctx, r, 'x_arrColSp', { refs: [1] });
        return;
      case 'x_ordOpt':
        if (key === 'F' || key === 'B') {
          orderTo(ctx, key === 'F' ? 'front' : 'back');
          return;
        }
        ctx.say(ctx.msg('orderPickReference'));
        go(ctx, r, 'x_ordRef', { order: key as 'A' | 'U', refs: [] });
        return;
      case 'x_splFirst':
        if (key === 'M') go(ctx, r, 'x_splMethod');
        else if (key === 'CV' || key === 'F') {
          ctx.setSettings({ splineCv: key === 'CV' });
          go(ctx, r, 'x_splFirst', { splineCv: key === 'CV' });
        }
        return;
      case 'x_splMethod':
        ctx.setSettings({ splineCv: key === 'CV' });
        go(ctx, r, 'x_splFirst', { splineCv: key === 'CV' });
        return;
      case 'x_splNext':
        if (key === 'U') {
          if (r.points.length <= 1) ctx.say(ctx.msg('nothingToUndo'));
          else go(ctx, r, 'x_splNext', {}, r.points.slice(0, -1));
        } else if (key === 'C') splineDone(ctx, r, true);
        return;
      case 'x_xlPoint':
        if (!ctx.needDrawLayer()) return;
        go(ctx, r, 'x_xlPoint', { fixed: key === 'H' ? [1, 0] : [0, 1] });
        ctx.say(ctx.msg(key === 'H' ? 'xlineHor' : 'xlineVer'));
        return;
      case 'x_wipeFirst':
        if (key === 'P') go(ctx, r, 'x_wipePoly');
        return;
      case 'x_wipeNext':
        if (key === 'U') {
          if (r.points.length <= 1) ctx.say(ctx.msg('nothingToUndo'));
          else go(ctx, r, 'x_wipeNext', {}, r.points.slice(0, -1));
        } else if (key === 'C') wipeoutDone(ctx, r);
        return;
      case 'x_polCenter':
        if (key === 'E') go(ctx, r, 'x_polEdge1');
        return;
      case 'x_polMode':
        ctx.setSettings({ polygon: { ...s.polygon, inscribed: key === 'I' } });
        go(ctx, r, 'x_polRadius');
        return;
      case 'x_elAxis':
        if (key === 'A') go(ctx, r, 'x_elAxis', { arc: true });
        else if (key === 'C') go(ctx, r, 'x_elCenter');
        return;
      case 'x_elDist':
        if (key === 'R') go(ctx, r, 'x_elRotation');
        return;
      case 'x_elEnd':
        if (key === 'I') ctx.say(ctx.msg('ellipseIncluded'));
        return;
      case 'x_helHeight':
        if (key === 'T') go(ctx, r, 'x_helTurns');
        return;
      default:
        ctx.say(ctx.msg('badKeyword'));
    }
  } catch (caught) {
    ctx.geometryMessage(caught);
  }
}

/** Enter / Space on a step of an added command. */
/** Free text on a step of an added command (a layer, group or block name). */
export function extraText<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, value: string): void {
  if (isLayerCommand(r.cmd)) layerText(ctx, r, value);
  else if (isTextCommand(r.cmd)) textText(ctx, r, value);
}

export function extraEnter<R extends ExtraRun>(ctx: ExtraContext<R>, r: R): void {
  if (isLayerCommand(r.cmd)) return layerEnter(ctx, r);
  if (isTextCommand(r.cmd)) return textEnter(ctx, r);
  if (isHatchCommand(r.cmd)) return hatchEnter(ctx, r);
  if (isMoreCommand(r.cmd)) return moreEnter(ctx, r);
  const d = data(r);
  const s = ctx.settings;
  switch (r.step as ExtraStep) {
    case 'x_lenValue':
      go(ctx, r, 'x_lenChange');
      return;
    case 'x_arrOpt':
      arrayDone(ctx, d);
      return;
    case 'x_arrCols':
      if (d.refs?.length === 1) go(ctx, r, 'x_arrRows', { refs: [] });
      else go(ctx, r, 'x_arrOpt');
      return;
    case 'x_arrRows':
    case 'x_arrRowSp':
      go(ctx, r, 'x_arrOpt', { refs: [] });
      return;
    case 'x_arrColSp':
      go(ctx, r, d.refs?.length === 1 ? 'x_arrRowSp' : 'x_arrOpt');
      return;
    case 'x_ordOpt':
      orderTo(ctx, 'back');
      return;
    case 'x_ordRef':
      orderTo(ctx, d.order === 'U' ? 'under' : 'above', d.refs ?? []);
      return;
    case 'x_splNext':
      splineDone(ctx, r, false);
      return;
    case 'x_splMethod':
      go(ctx, r, 'x_splFirst');
      return;
    case 'x_wipeFirst':
      go(ctx, r, 'x_wipePoly');
      return;
    case 'x_wipeNext':
      wipeoutDone(ctx, r);
      return;
    case 'x_helBase':
      go(ctx, r, 'x_helTop', { baseRadius: 1 });
      return;
    case 'x_helTop':
      go(ctx, r, 'x_helHeight', { topRadius: d.baseRadius ?? 1 });
      return;
    case 'x_helTurns':
      go(ctx, r, 'x_helHeight');
      return;
    case 'x_helHeight':
      try {
        helix(ctx, d, s.helixTurns);
      } catch (caught) {
        ctx.geometryMessage(caught);
      }
      return;
    case 'x_doInner':
      go(ctx, r, 'x_doOuter');
      return;
    case 'x_doOuter':
      go(ctx, r, 'x_doCenter');
      return;
    case 'x_polSides':
      go(ctx, r, 'x_polCenter');
      return;
    case 'x_polMode':
      go(ctx, r, 'x_polRadius');
      return;
    default:
      ctx.finish();
  }
}

/** A pick on a step that waits for an object. */
export function extraObject<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  r: R,
  index: number | null,
  at: Point,
): void {
  if (isLayerCommand(r.cmd)) return layerObject(ctx, r, index);
  if (isMatchCommand(r.cmd)) return matchObject(ctx, r, index);
  if (isTextCommand(r.cmd)) return textObject(ctx, r, index);
  if (isHatchCommand(r.cmd)) return hatchObject(ctx, r, index, at);
  if (isMoreCommand(r.cmd)) return moreObject(ctx, r, index, at);
  const d = data(r);
  if (index === null || !ctx.pickable(index)) {
    ctx.say(ctx.msg('nothingThere'));
    return;
  }
  try {
    switch (r.step as ExtraStep) {
      case 'x_brPick':
      case 'x_bapPick': {
        const geom = ctx.curveGeom(index);
        if (!geom) {
          ctx.say(ctx.msg('notCurve'));
          return;
        }
        if (r.step === 'x_bapPick') {
          if (geom.closed) throw new GeometryError('SPLIT_CLOSED');
          go(ctx, r, 'x_bapPoint', { target: index });
        } else go(ctx, r, 'x_brSecond', { target: index, at });
        return;
      }
      case 'x_lenPick': {
        const geom = ctx.curveGeom(index);
        if (!geom) {
          ctx.say(ctx.msg('notCurve'));
          return;
        }
        ctx.say(
          ctx.msg('currentLength', { length: acadNumber(curveLength(geom.points, geom.closed)) }),
        );
        return;
      }
      case 'x_lenChange': {
        const geom = ctx.curveGeom(index);
        const handle = ctx.scene.view.entities[index]?.handle;
        if (!geom || !handle || geom.closed) {
          ctx.say(ctx.msg('notCurve'));
          return;
        }
        const { mode, value } = ctx.settings.lengthen;
        const total = curveLength(geom.points, false);
        const delta =
          mode === 'DE' ? value : mode === 'T' ? value - total : (total * value) / 100 - total;
        const first = geom.points[0] as Pt;
        const last = geom.points[geom.points.length - 1] as Pt;
        const atStart = distance(pt(at), first) < distance(pt(at), last);
        const made = ctx.add([
          setCurveEdit(handle, lengthenEnd(geom.points, atStart, delta), false),
        ]);
        ctx.setRun({ ...r, made: [...r.made, made.length] });
        return;
      }
      case 'x_ordRef': {
        go(ctx, r, 'x_ordRef', { refs: [...(d.refs ?? []), index] });
        ctx.say(ctx.msg('found', { count: 1 }));
        return;
      }
      case 'x_divPick':
      case 'x_mePick': {
        if (!ctx.curveGeom(index) && !loopOf(ctx, index)) {
          ctx.say(ctx.msg('notCurve'));
          return;
        }
        if (!ctx.needDrawLayer()) return;
        go(ctx, r, r.step === 'x_divPick' ? 'x_divCount' : 'x_meLength', { target: index });
        return;
      }
      case 'x_wipePoly': {
        const loop = loopOf(ctx, index);
        if (!loop) {
          ctx.say(ctx.msg('wipeoutNotClosed'));
          return;
        }
        if (!ctx.needDrawLayer()) return;
        addShape(ctx, 'wipeout', loop);
        ctx.finish();
        return;
      }
      default:
        return;
    }
  } catch (caught) {
    ctx.geometryMessage(caught);
  }
}

/** What is drawn while an added command waits for a point: the shape it would make. */
export function extraSketch(
  r: ExtraRun,
  at: Point,
  settings: ExtraSettings,
): { points: Point[]; closed: boolean } | null {
  if (isLayerCommand(r.cmd)) return layerSketch(r, at);
  if (isTextCommand(r.cmd)) return textSketch(r, at);
  if (isMoreCommand(r.cmd)) return moreSketch(r, at);
  const d = data(r);
  const a = pt(at);
  try {
    switch (r.step as ExtraStep) {
      case 'x_splNext': {
        const pts = [...r.points, at].map(pt);
        const made = d.splineCv ? cvSpline(pts) : fitSpline(pts);
        return { points: made.map(xy), closed: false };
      }
      case 'x_xlThrough':
      case 'x_rayThrough':
      case 'x_brSecond':
      case 'x_helBase':
      case 'x_elOther':
      case 'x_elAxisEnd':
      case 'x_polEdge2': {
        const from =
          r.step === 'x_brSecond' ||
          r.step.startsWith('x_hel') ||
          r.step.startsWith('x_el') ||
          r.step === 'x_polEdge2'
            ? d.at
            : r.points[0];
        if (!from) return null;
        if (r.step === 'x_polEdge2') {
          return {
            points: polygonOnEdge(pt(from), a, settings.polygon.sides).map(xy),
            closed: true,
          };
        }
        return { points: [from, at], closed: false };
      }
      case 'x_wipeNext':
        return { points: [...r.points, at], closed: r.points.length >= 2 };
      case 'x_polRadius': {
        if (!d.at) return null;
        const c = pt(d.at);
        const radius = distance(c, a);
        if (radius === 0) return null;
        return {
          points: polygonPoints(
            c,
            settings.polygon.sides,
            radius,
            settings.polygon.inscribed,
            angleDeg(c, a),
          ).map(xy),
          closed: true,
        };
      }
      case 'x_elDist': {
        if (!d.ellipse) return null;
        const major = Math.hypot(d.ellipse.axis[0], d.ellipse.axis[1]);
        const ratio = otherAxis(d.ellipse, a) / major;
        if (!(ratio > 0)) return null;
        return {
          points: ellipsePoints(d.ellipse.center, d.ellipse.axis, ratio).map(xy),
          closed: true,
        };
      }
      case 'x_elStart':
      case 'x_elEnd': {
        if (!d.ellipse) return null;
        const e = d.ellipse;
        const from = r.step === 'x_elStart' ? 0 : (d.startAngle ?? 0);
        return {
          points: ellipsePoints(e.center, e.axis, e.ratio, from, ellipseAngle(e, a)).map(xy),
          closed: false,
        };
      }
      case 'x_helTop': {
        if (!d.at || d.baseRadius === undefined) return null;
        const top = distance(pt(d.at), a);
        return {
          points: helixPoints(pt(d.at), d.baseRadius, top, settings.helixTurns).map(xy),
          closed: false,
        };
      }
      case 'x_doCenter': {
        const radius = settings.donut.outer / 2;
        const ring = polygonPoints(a, 48, radius, true);
        return { points: ring.map(xy), closed: true };
      }
      case 'x_bapPoint':
        return null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// ---------- helpers ----------

function selectionBox<R extends ExtraRun>(ctx: ExtraContext<R>): Bounds | null {
  let box: Bounds | null = null;
  for (const index of ctx.selection) {
    const t = ctx.shown.transformOf.get(index);
    const b = t ? boxThrough(t, boxOf(ctx.scene, index)) : boxOf(ctx.scene, index);
    box = box
      ? {
          minX: Math.min(box.minX, b.minX),
          minY: Math.min(box.minY, b.minY),
          maxX: Math.max(box.maxX, b.maxX),
          maxY: Math.max(box.maxY, b.maxY),
        }
      : b;
  }
  return box;
}

/** The closed outline of an object (a closed polyline, circle, ellipse or closed spline). */
function loopOf<R extends ExtraRun>(ctx: ExtraContext<R>, index: number): Pt[] | null {
  const geom = ctx.curveGeom(index);
  if (geom) return asLoop(geom.points, geom.closed, tolerance(ctx));
  const entity = ctx.scene.view.entities[index];
  if (!entity || entity.paths.length !== 1) return null;
  const flat = entity.paths[0] as readonly number[];
  const moved = ctx.shown.transformOf.get(index);
  const points: Pt[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const p = { x: flat[i] as number, y: flat[i + 1] as number };
    points.push(pt(moved ? applyAffine(moved, p.x, p.y) : p));
  }
  return asLoop(points, false, tolerance(ctx));
}

/** The closed outlines that may hold a point: objects whose box holds it, and lines drawn now. */
function loopsNear<R extends ExtraRun>(ctx: ExtraContext<R>, p: Pt): Pt[][] {
  const out: Pt[][] = [];
  ctx.scene.view.entities.forEach((_, index) => {
    if (!ctx.pickable(index)) return;
    const t = ctx.shown.transformOf.get(index);
    const b = t ? boxThrough(t, boxOf(ctx.scene, index)) : boxOf(ctx.scene, index);
    if (
      !ctx.shown.curveOf.has(index) &&
      (p[0] < b.minX || p[0] > b.maxX || p[1] < b.minY || p[1] > b.maxY)
    ) {
      return;
    }
    const loop = loopOf(ctx, index);
    if (loop) out.push(loop);
  });
  // A page scene already has the lines drawn on the page as rows (ADR-061).
  for (const extra of ctx.scene.file ? [] : ctx.shown.extraCurves) {
    const points: Pt[] = [];
    for (let i = 0; i + 1 < extra.path.length; i += 2) {
      points.push([extra.path[i] as number, extra.path[i + 1] as number]);
    }
    const loop = asLoop(points, extra.closed, tolerance(ctx));
    if (loop) out.push(loop);
  }
  return out;
}

/** A small length in drawing units: ends this close meet (one millionth of the drawing). */
function tolerance<R extends ExtraRun>(ctx: ExtraContext<R>): number {
  const e = ctx.scene.view.extents;
  return Math.max(1e-6, Math.hypot(e.maxX - e.minX, e.maxY - e.minY) * 1e-6);
}

function curve<R extends ExtraRun>(ctx: ExtraContext<R>, points: Pt[], closed: boolean): void {
  ctx.add([pointsCurveEdit(ctx.drawLayer, points, closed)]);
  ctx.finish();
}

function polygon<R extends ExtraRun>(ctx: ExtraContext<R>, points: Pt[]): void {
  curve(ctx, points, true);
}

function addShape<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  shape: 'hatch' | 'gradient' | 'wipeout' | 'donut' | 'xline' | 'ray',
  points: readonly Pt[],
  extra: Partial<Extract<CanvasEdit, { kind: 'add_shape' }>> = {},
): void {
  ctx.add([
    {
      kind: 'add_shape',
      shape,
      layer: ctx.drawLayer,
      points: points.map((p) => [roundCoord(p[0]), roundCoord(p[1])] as [number, number]),
      pattern: null,
      scale: 1,
      angle: 0,
      color: null,
      color2: null,
      inner: null,
      outer: null,
      ...HATCH_FIELD_DEFAULTS,
      ...extra,
    },
  ]);
}

function breakAt<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  index: number,
  first: Point,
  second: Point,
): void {
  const geom = ctx.curveGeom(index);
  const handle = ctx.scene.view.entities[index]?.handle;
  if (!geom || !handle) return ctx.finish();
  const d1 = nearestOnCurve(geom.points, geom.closed, pt(first)).along;
  const d2 = nearestOnCurve(geom.points, geom.closed, pt(second)).along;
  const pieces = breakCurve(geom.points, geom.closed, d1, d2);
  replaceWith(ctx, index, handle, pieces);
}

function breakAtPoint<R extends ExtraRun>(ctx: ExtraContext<R>, index: number, at: Point): void {
  const geom = ctx.curveGeom(index);
  const handle = ctx.scene.view.entities[index]?.handle;
  if (!geom || !handle) return ctx.finish();
  const d = nearestOnCurve(geom.points, geom.closed, pt(at)).along;
  replaceWith(ctx, index, handle, splitAt(geom.points, geom.closed, d));
}

/** The curve keeps its handle with the first piece; the others are new lines on its layer. */
function replaceWith<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  index: number,
  handle: string,
  pieces: Pt[][],
): void {
  const [first, ...rest] = pieces;
  if (!first) {
    ctx.add([{ kind: 'erase_item', handle }]);
  } else {
    const layer = ctx.layerNameOf(index);
    ctx.add([
      setCurveEdit(handle, first, false),
      ...rest.map((piece) => curveEdit(layer, piece.map(xy), false)),
    ]);
  }
  ctx.finish();
}

function divideOrMeasure<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  index: number,
  make: (geom: { points: Pt[]; closed: boolean }) => Pt[],
): void {
  const geom =
    ctx.curveGeom(index) ??
    (() => {
      const loop = loopOf(ctx, index);
      return loop ? { points: loop, closed: true } : null;
    })();
  if (!geom) return ctx.finish();
  const points = make(geom);
  ctx.add(
    points.map(
      (p) =>
        ({
          kind: 'add_item',
          layer: ctx.drawLayer,
          x: roundCoord(p[0]),
          y: roundCoord(p[1]),
        }) as CanvasEdit,
    ),
  );
  ctx.say(ctx.msg('pointsPlaced', { count: points.length }));
  ctx.finish();
}

function arrayDone<R extends ExtraRun>(ctx: ExtraContext<R>, d: ExtraData): void {
  const columns = d.columns ?? 4;
  const rows = d.rows ?? 3;
  const offsets = arrayOffsets(columns, rows, d.columnSpacing ?? 0, d.rowSpacing ?? 0);
  ctx.add(
    offsets.flatMap(([dx, dy]) =>
      ctx.handles.map(
        (handle) =>
          ({
            kind: 'copy_item',
            handle,
            dx: roundCoord(dx),
            dy: roundCoord(dy),
            toLayer: null,
          }) as CanvasEdit,
      ),
    ),
  );
  ctx.say(ctx.msg('arrayCount', { columns, rows }));
  ctx.finish();
}

function orderTo<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  where: 'front' | 'back' | 'above' | 'under',
  refs: readonly number[] = [],
): void {
  const orders = [...ctx.shown.orderOf.values(), 0];
  let order: number;
  if (where === 'front') order = Math.max(...orders) + 1;
  else if (where === 'back') order = Math.min(...orders) - 1;
  else {
    if (refs.length === 0) {
      ctx.finish();
      return;
    }
    const of = refs.map((i) => ctx.shown.orderOf.get(i) ?? 0);
    order = where === 'above' ? Math.max(...of) + 0.5 : Math.min(...of) - 0.5;
  }
  ctx.add(ctx.handles.map((handle) => ({ kind: 'set_order', handle, order })));
  ctx.say(ctx.msg('orderDone', { count: ctx.handles.length }));
  ctx.finish();
}

/** OVERKILL: handles of the picked objects that repeat another (same type, layer and shape). */
function duplicates<R extends ExtraRun>(ctx: ExtraContext<R>): string[] {
  const keyOf = new Map<string, string[]>();
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
  for (const index of ctx.selection) {
    const entity = ctx.scene.view.entities[index];
    if (!entity) continue;
    const geom = ctx.curveGeom(index);
    const moved = ctx.shown.transformOf.get(index);
    const shape = geom
      ? geom.points.map((p) => `${r6(p[0])},${r6(p[1])}`).join(';')
      : entity.paths
          .map((path) => {
            const out: string[] = [];
            for (let i = 0; i + 1 < path.length; i += 2) {
              const p = moved
                ? applyAffine(moved, path[i] as number, path[i + 1] as number)
                : { x: path[i] as number, y: path[i + 1] as number };
              out.push(`${r6(p.x)},${r6(p.y)}`);
            }
            return out.join(';');
          })
          .join('|');
    const texts = entity.texts.map((t) => `${t.text}@${r6(t.x)},${r6(t.y)}`).join('|');
    const key = `${entity.kind}|${effectiveLayer(ctx.scene, ctx.shown, index)}|${shape}|${texts}`;
    const list = keyOf.get(key) ?? [];
    if (!list.includes(entity.handle)) list.push(entity.handle);
    keyOf.set(key, list);
  }
  return [...keyOf.values()].flatMap((list) => list.slice(1));
}

/** REGION: closed objects are regions already; open pieces that close are joined into one. */
function region<R extends ExtraRun>(ctx: ExtraContext<R>): void {
  const open: { handle: string; points: Pt[] }[] = [];
  let loops = 0;
  for (const index of ctx.selection) {
    const geom = ctx.curveGeom(index);
    const handle = ctx.scene.view.entities[index]?.handle;
    if (!geom || !handle) continue;
    if (geom.closed || asLoop(geom.points, false, tolerance(ctx))) loops += 1;
    else open.push({ handle, points: geom.points });
  }
  if (open.length > 0) {
    const loop = chainLoop(
      open.map((o) => o.points),
      tolerance(ctx),
    );
    if (!loop) {
      ctx.say(ctx.msg('regionOpen'));
      ctx.finish();
      return;
    }
    const first = [...ctx.selection].find(
      (i) => ctx.scene.view.entities[i]?.handle === open[0]?.handle,
    );
    const layer = first === undefined ? ctx.drawLayer : ctx.layerNameOf(first);
    ctx.add([
      pointsCurveEdit(layer, loop, true),
      ...open.map((o) => ({ kind: 'erase_item', handle: o.handle }) as CanvasEdit),
    ]);
    loops += 1;
  }
  ctx.say(ctx.msg('regionDone', { count: loops }));
  ctx.finish();
}

function splineDone<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, closed: boolean): void {
  if (r.points.length < 2) {
    ctx.finish();
    return;
  }
  try {
    const pts = r.points.map(pt);
    const made = data(r).splineCv
      ? cvSpline(closed ? [...pts, pts[0] as Pt] : pts)
      : fitSpline(pts, closed);
    curve(ctx, made, closed && !data(r).splineCv);
  } catch (caught) {
    ctx.geometryMessage(caught);
  }
}

function wipeoutDone<R extends ExtraRun>(ctx: ExtraContext<R>, r: R): void {
  if (r.points.length < 3) {
    ctx.finish();
    return;
  }
  addShape(ctx, 'wipeout', r.points.map(pt));
  ctx.finish();
}

function helix<R extends ExtraRun>(ctx: ExtraContext<R>, d: ExtraData, turns: number): void {
  if (!d.at) return;
  const base = d.baseRadius ?? 1;
  curve(ctx, helixPoints(pt(d.at), base, d.topRadius ?? base, turns), false);
}

/** The half length of the other axis for a picked point: its distance from the first axis. */
function otherAxis(e: { center: Pt; axis: Pt }, p: Pt): number {
  const a = Math.hypot(e.axis[0], e.axis[1]);
  const ux = e.axis[0] / a;
  const uy = e.axis[1] / a;
  const dx = p[0] - e.center[0];
  const dy = p[1] - e.center[1];
  return Math.abs(-uy * dx + ux * dy);
}

/** The parameter angle (degrees) of a point seen on the ellipse. */
function ellipseAngle(e: { center: Pt; axis: Pt; ratio: number }, p: Pt): number {
  const a = Math.hypot(e.axis[0], e.axis[1]);
  const ux = e.axis[0] / a;
  const uy = e.axis[1] / a;
  const dx = p[0] - e.center[0];
  const dy = p[1] - e.center[1];
  const x = ux * dx + uy * dy;
  const y = (-uy * dx + ux * dy) / e.ratio;
  return (Math.atan2(y, x) * 180) / Math.PI;
}

function ellipseDone<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  r: R,
  e: { center: Pt; axis: Pt; ratio: number },
): void {
  if (!(e.ratio > 0)) throw new GeometryError('SHAPE');
  // AutoCAD keeps the longer axis as the major one.
  const shape =
    e.ratio > 1
      ? {
          center: e.center,
          axis: [-e.axis[1] * e.ratio, e.axis[0] * e.ratio] as Pt,
          ratio: 1 / e.ratio,
        }
      : e;
  if (data(r).arc) {
    go(ctx, r, 'x_elStart', { ellipse: shape });
    return;
  }
  curve(ctx, ellipsePoints(shape.center, shape.axis, shape.ratio), true);
}
