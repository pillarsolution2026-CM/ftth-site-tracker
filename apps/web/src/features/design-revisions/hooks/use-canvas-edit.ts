'use client';

import { useEffect, useMemo, useState } from 'react';
import type { MessageKey } from '@ftth/i18n';
import { errorCodeOf, errorReasonOf } from '@/shared/api/bff-client';
import { useI18n } from '@/shared/i18n/locale-provider';
import { useSaveCorrections } from '../api/queries';
import {
  applyAffine,
  mirrorAcross,
  rotationAbout,
  scaleAbout,
  translation,
  type Affine,
} from '../model/affine';
import {
  acadAngle,
  acadNumber,
  COMMANDS,
  PROMPTS_WITHOUT_OR,
  lookupCommand,
  matchOption,
  parseEntry,
  towards,
  type CommandId,
  type CommandOption,
  type Point,
} from '../model/cad-commands';
import {
  addEdits,
  arcCurveEdit,
  circleCurveEdit,
  copyEdits,
  curveEdit,
  editRequests,
  entitiesInBand,
  eraseEdits,
  handlesOf,
  isTextEntity,
  mirrorEdits,
  moveEdits,
  pointsCurveEdit,
  previewWithEdits,
  rotateEdits,
  roundCoord,
  scaleEdits,
  setCurveEdit,
  type Band,
  type CanvasEdit,
} from '../model/canvas-edit';
import { correctionError } from '../model/corrections';
import { effectiveLayer, type DrawingPreview, type PreviewStyle } from '../model/drawing-preview';
import { boxOf, type DrawingScene } from '../model/drawing-scene';
import { pageSceneOf } from '../model/page-scene';
import { joinProblem, type JoinPiece } from '../model/join';
import {
  arcThrough,
  circlePoints,
  circleThrough,
  distance,
  fillet,
  GeometryError,
  inBox,
  linearDimension,
  offsetCurve,
  rectanglePoints,
  stretchCurve,
  trimCurve,
  type Box,
  type Pt,
  nearestOnCurve,
} from '../model/geometry';
import {
  arcCenter,
  arcEndDirection,
  arcStartEnd,
  arcThroughEndDirection,
  chamferPolygon,
  circleTangentTangent,
  endDirection,
  extendCurve,
  filletPolyline,
  rectangleFrom,
  rotatedRectangle,
  tangentArc,
  throughDistance,
} from '../model/geometry-options';
import type { ErrorMessage } from '../model/revision-errors';
import {
  DEFAULT_EXTRA_SETTINGS,
  EXTRA_OBJECT_STEPS,
  EXTRA_TRACKED,
  extraAfterSelect,
  extraBegin,
  extraEnter,
  extraNumber,
  extraObject,
  extraOption,
  extraPoint,
  extraPrompt,
  extraSketch,
  extraText,
  isExtra,
  type ExtraContext,
  type ExtraData,
  type ExtraPromptKey,
  type ExtraSettings,
  type ExtraStep,
} from './extra-commands';
import { gripSketch, gripsOf, gripStretchEdits, type Grip } from '../model/grips';
import { LAYER_TEXT_STEPS } from './layer-commands';
import {
  isTextCommand,
  tablePlace,
  TEXT_TOOL_TEXT_STEPS,
  textKeepOnCancel,
  textPending,
  textSelectOption,
  textSelectPrompt,
} from './text-commands';
import type { TableSpec } from '../model/table';
import { hatchLoopCount, hatchPending, isHatchCommand, type HatchSettings } from './hatch-command';
import type { WorkspaceDialog } from './use-drawing-viewer';
import { useHistory, type HistoryPart, type UndoHistory } from './use-history';
import type { LayerScreen } from './use-layer-screen';

export type { Point } from '../model/cad-commands';

/**
 * The drawing's edit mode as an AutoCAD-like workspace (ADR-047, ADR-050, ADR-051). Commands are
 * started from the ribbon or typed on the command line (names and aliases as AutoCAD); each step
 * asks with AutoCAD's prompt and takes a click, a typed point (`x,y`, `@dx,dy`, `@d<a`), a number,
 * an option word, Enter / Space or Esc. Objects may be picked before the command (noun-verb) or
 * when it asks (verb-noun). Edits stay in the page until «حفظ».
 */

/** What the current step waits for (an i18n key under `design.cad.cmd`). */
export type PromptKey =
  | 'command'
  | 'gripStretch'
  | 'gripBase'
  | 'selectObjects'
  | 'stretchSelect'
  | 'basePoint'
  | 'secondPoint'
  | 'rotationAngle'
  | 'scaleFactor'
  | 'mirrorFirst'
  | 'mirrorSecond'
  | 'lineFirst'
  | 'nextPoint'
  | 'plineStart'
  | 'circleCenter'
  | 'circleRadius'
  | 'circleDiameter'
  | 'circleFirst'
  | 'circleSecond'
  | 'circleThird'
  | 'diameterFirst'
  | 'diameterSecond'
  | 'arcStart'
  | 'arcSecond'
  | 'arcEnd'
  | 'rectFirst'
  | 'rectOther'
  | 'pointAt'
  | 'trimPick'
  | 'filletFirst'
  | 'filletSecond'
  | 'filletRadius'
  | 'offsetDistance'
  | 'offsetPick'
  | 'offsetSide'
  | 'joinSelect'
  | 'textStart'
  | 'textHeight'
  | 'textValue'
  | 'editPick'
  | 'editValue'
  | 'dimFirst'
  | 'dimSecond'
  | 'dimLocation'
  | 'leaderStart'
  | 'leaderText'
  | 'matchSource'
  | 'matchDest'
  | 'laymcurPick'
  | 'laymchSelect'
  | 'laymchDest'
  | 'removeObjects'
  | 'displacement'
  | 'copyMode'
  | 'refAngle'
  | 'newAngle'
  | 'firstPoint'
  | 'refLength'
  | 'newLength'
  | 'mirrorErase'
  | 'arcEndpoint'
  | 'plineLength'
  | 'ttrFirst'
  | 'ttrSecond'
  | 'arcCenterPoint'
  | 'includedAngle'
  | 'arcRadius'
  | 'chamferFirst'
  | 'chamferSecond'
  | 'rectFilletRadius'
  | 'rectLength'
  | 'rectWidth'
  | 'rectRotation'
  | 'rectArea'
  | 'rectAreaBy'
  | 'rectAreaLength'
  | 'rectAreaWidth'
  | 'trimEdges'
  | 'trimErase'
  | 'filletTrim'
  | 'filletPoly'
  | 'offsetErase'
  | 'offsetLayer'
  | 'offsetThrough'
  | 'dimSelect'
  | 'dimTextValue'
  | 'layerName'
  | 'secondPointOr'
  | 'copyArrayCount'
  | 'insertionPoint'
  | 'fromBase'
  | 'fromOffset'
  | 'm2pFirst'
  | 'm2pSecond'
  | ExtraPromptKey;

export interface CommandPrompt {
  key: PromptKey;
  options: readonly CommandOption[];
  /** The default in AutoCAD's angle brackets. */
  fallback: string | null;
}

type Step =
  | 'select'
  | 'base'
  | 'second'
  | 'angle'
  | 'factor'
  | 'mirror1'
  | 'mirror2'
  | 'first'
  | 'next'
  | 'center'
  | 'radius'
  | 'diameter'
  | 'c3p1'
  | 'c3p2'
  | 'c3p3'
  | 'c2p1'
  | 'c2p2'
  | 'arc1'
  | 'arc2'
  | 'arc3'
  | 'corner1'
  | 'corner2'
  | 'pointAt'
  | 'trimPick'
  | 'filletFirst'
  | 'filletSecond'
  | 'filletRadius'
  | 'offsetDistance'
  | 'offsetPick'
  | 'offsetSide'
  | 'textStart'
  | 'textHeight'
  | 'textValue'
  | 'editPick'
  | 'editValue'
  | 'dim1'
  | 'dim2'
  | 'dim3'
  | 'leaderStart'
  | 'leaderNext'
  | 'leaderText'
  | 'source'
  | 'dest'
  | 'laymcurPick'
  | 'laymchDest'
  | 'displacement'
  | 'copyMode'
  | 'refAngle'
  | 'refAngle2'
  | 'newAngle'
  | 'newAngleP1'
  | 'newAngleP2'
  | 'refLength'
  | 'refLength2'
  | 'newLength'
  | 'newLengthP1'
  | 'newLengthP2'
  | 'mirrorErase'
  | 'plineLength'
  | 'plineArc2'
  | 'plineArc3'
  | 'ttr1'
  | 'ttr2'
  | 'ttrRadius'
  | 'arcCenter'
  | 'arcCStart'
  | 'arcCEnd'
  | 'arcCAngle'
  | 'arcEEnd'
  | 'arcEOpt'
  | 'arcERadius'
  | 'arcEAngle'
  | 'chamfer1'
  | 'chamfer2'
  | 'rectFillet'
  | 'rectLength'
  | 'rectWidth'
  | 'rectSide'
  | 'rectRotation'
  | 'rectArea'
  | 'rectAreaBy'
  | 'rectAreaLength'
  | 'rectAreaWidth'
  | 'trimEdges'
  | 'trimErase'
  | 'filletTrim'
  | 'filletPoly'
  | 'offsetErase'
  | 'offsetLayer'
  | 'dimSelect'
  | 'dimTextValue'
  | 'laymchName'
  | 'copyArrayCount'
  | 'copyArraySecond'
  | ExtraStep;

/** What a command's options set while it runs (AutoCAD's sub-options). */
interface Flags {
  /** ROTATE / SCALE Copy: the objects stay, a turned / scaled copy is made. */
  copy?: boolean;
  refAngle?: number;
  refLength?: number;
  /** PLINE: arc segments; the direction the polyline ends in; where each segment starts. */
  arcMode?: boolean;
  direction?: Pt;
  segments?: number[];
  /** CIRCLE Ttr: the lines picked and where. */
  tangents?: { seg: readonly [Pt, Pt]; at: Pt }[];
  chamfer1?: number;
  /** TRIM cuTting edges: only these objects cut. */
  edges?: number[];
  /** FILLET / OFFSET Multiple. */
  multiple?: boolean;
  multipleCount?: number;
  /** DIMLINEAR Text, Horizontal / Vertical. */
  dimText?: string | null;
  dimDirection?: 'h' | 'v';
  /** «Select objects:» after R (Remove), until A (Add). */
  removing?: boolean;
  /** POINT from «Multiple Points»: one point after another until Esc / Enter. */
  repeat?: boolean;
  /** What an added Draw / Modify command has taken (owner 2026-11-24). */
  extra?: ExtraData;
  /** COPY Array: how many items (the original is the first), and Fit (the point is the last). */
  arrayCount?: number;
  arrayFit?: boolean;
}

interface Run {
  cmd: CommandId;
  step: Step;
  /** Points taken so far (lines, polylines, arcs, dimensions, leaders). */
  points: Point[];
  base: Point | null;
  /** STRETCH's crossing window. */
  window: Box | null;
  /** The object this step works on (offset, fillet, match properties, text edit). */
  target: number | null;
  targetAt: Point | null;
  textAt: Point | null;
  height: number | null;
  /** Edits made by this command, for its Undo option (copies, segments, trims). */
  made: number[];
  flags: Flags;
}

const newRun = (cmd: CommandId, step: Step): Run => ({
  cmd,
  step,
  points: [],
  base: null,
  window: null,
  target: null,
  targetAt: null,
  textAt: null,
  height: null,
  made: [],
  flags: {},
});

/** Steps where the command line takes free text (spaces are part of it, not Enter). */
const TEXT_STEPS: readonly Step[] = [
  'textValue',
  'editValue',
  'leaderText',
  'dimTextValue',
  'laymchName',
];
/** Steps that take a point: the pointer is followed for the rubber band. */
const TRACKED: readonly Step[] = [
  'second',
  'angle',
  'factor',
  'mirror2',
  'next',
  'radius',
  'diameter',
  'c3p3',
  'c2p2',
  'arc2',
  'arc3',
  'corner2',
  'offsetSide',
  'dim2',
  'dim3',
  'leaderNext',
  'refAngle2',
  'newAngle',
  'newAngleP2',
  'refLength2',
  'newLength',
  'newLengthP2',
  'plineArc2',
  'plineArc3',
  'ttrRadius',
  'arcCEnd',
  'arcEOpt',
  'arcERadius',
  'rectSide',
  'rectRotation',
  'copyArraySecond',
];
const OBJECT_STEPS: readonly Step[] = [
  'trimPick',
  'filletFirst',
  'filletSecond',
  'offsetPick',
  'editPick',
  'source',
  'dest',
  'laymcurPick',
  'laymchDest',
  'trimEdges',
  'trimErase',
  'filletPoly',
  'ttr1',
  'ttr2',
  'dimSelect',
];

const isTextStep = (step: Step) =>
  TEXT_STEPS.includes(step) ||
  LAYER_TEXT_STEPS.includes(step) ||
  TEXT_TOOL_TEXT_STEPS.includes(step);
const isTracked = (step: Step) => TRACKED.includes(step) || EXTRA_TRACKED.includes(step);
const isObjectStep = (step: Step) =>
  OBJECT_STEPS.includes(step) || EXTRA_OBJECT_STEPS.includes(step);

const CURVE_KINDS = new Set(['LINE', 'LWPOLYLINE', 'POLYLINE']);
/** DXF type → the command that draws one like it (ADDSELECTED). */
const DRAW_LIKE: Readonly<Record<string, CommandId>> = {
  LINE: 'line',
  LWPOLYLINE: 'pline',
  POLYLINE: 'pline',
  CIRCLE: 'circle',
  ARC: 'arc',
  POINT: 'point',
  TEXT: 'text',
  MTEXT: 'text',
  DIMENSION: 'dimlinear',
  LEADER: 'leader',
};
const NONE: ReadonlySet<number> = new Set();
/** AutoCAD's grip editing in progress (a hot grip, owner 2026-11-26). */
interface GripRun {
  grip: Grip;
  base: Point;
  copy: boolean;
  step: 'stretch' | 'base';
}
const GRIP_NAME = '** STRETCH **';
const GRIP_OPTIONS: readonly CommandOption[] = [
  { word: 'Base point', key: 'B' },
  { word: 'Copy', key: 'C' },
  { word: 'Undo', key: 'U' },
  { word: 'eXit', key: 'X' },
];
const HISTORY_LINES = 50;
const opt = (word: string, key: string): CommandOption => ({ word, key });

/** The drawing's edit mode (ADR-047, ADR-050, ADR-051). */
export interface CanvasEditState {
  /** The project manager may edit (draft revision and design:write). */
  available: boolean;
  editing: boolean;
  start: () => void;
  /** The command running, null at «Type a command». */
  command: CommandId | null;
  run: (id: CommandId) => void;
  /** PICKSTYLE: picking one member of a group picks the group. */
  groupPick: boolean;
  /** EATTEDIT: the attribute of a block reference changes from one value to another. */
  setAttribute: (index: number, from: string, to: string) => void;
  /** FIND: a text's new content (a text, or an attribute of a block reference). */
  replaceText: (index: number, from: string, to: string) => void;
  /** Starts a command with one of its options already chosen (ribbon drop-downs, menus). */
  runWith: (id: CommandId, option: string) => void;
  /** TABLE: the Insert Table dialog's OK — the command line asks where the table goes. */
  placeTable: (spec: TableSpec) => void;
  /**
   * While HATCH / GRADIENT runs: the «Hatch Creation» tab's values (changed live, the preview
   * follows), the boundaries picked so far, and «Close Hatch Creation» (= Enter).
   */
  hatch: {
    settings: HatchSettings;
    set: (patch: Partial<HatchSettings>) => void;
    loops: number;
    close: () => void;
  } | null;
  prompt: CommandPrompt;
  /** Lines already on the command line (newest last). */
  history: readonly string[];
  input: string;
  setInput: (value: string) => void;
  /** Enter on the command line. */
  submit: () => void;
  chooseOption: (key: string) => void;
  /** Free text is typed now (a space is a space, not Enter). */
  textEntry: boolean;
  /** Changes when the command line should take the keyboard. */
  focusNonce: number;
  /** A key on the canvas; true when it was used. */
  key: (key: string, ctrl: boolean) => boolean;
  /**
   * The page scene (ADR-061): the file's entities, then the items drawn, pasted or copied on the
   * page as objects with FIX- / NEW- handles. Picking, grips, snaps and Properties use it.
   */
  scene: DrawingScene | null;
  // Selection
  chosen: ReadonlySet<number>;
  chosenCount: number;
  clearChosen: () => void;
  /** AutoCAD's SELECTSIMILAR: every shown object of the same type on the same layer. */
  selectSimilar: () => void;
  /** Ctrl+A: every shown, unlocked object (AutoCAD's «All»). */
  selectAll: () => void;
  /** The objects COPYCLIP / CUTCLIP / COPYBASE keep for PASTECLIP (Ctrl+C / X / Shift+C / V). */
  clipboardCount: number;
  /** The draw command ADDSELECTED would start for the one picked object; null when none fits. */
  addSelectedCommand: CommandId | null;
  /** AutoCAD's ADDSELECTED: draw a new object like the picked one, on its layer. */
  addSelected: () => void;
  /** A click on the canvas in the edit mode (`at`: the drawing point clicked). */
  pick: (entity: number | null, at: Point, additive: boolean) => void;
  /** AutoCAD's grips of the picked objects (none while a command runs). */
  grips: readonly Grip[];
  /** Boxes of the groups picked as one object. */
  groupBoxes: readonly { minX: number; minY: number; maxX: number; maxY: number }[];
  /** The hot grip of a grip STRETCH, null otherwise. */
  hotGrip: Grip | null;
  /** A click on a grip: AutoCAD's «** STRETCH **» starts from it. */
  startGrip: (grip: Grip) => void;
  /** Edits made outside the command line (the Properties palette). */
  apply: (edits: CanvasEdit[]) => void;
  /** The name shown before the prompt when it is not a command's («** STRETCH **»). */
  commandLabel: string | null;
  /** A drag on the canvas draws a selection box. */
  boxing: boolean;
  band: Band | null;
  setBand: (band: Band | null) => void;
  pickBand: (band: Band, additive: boolean) => void;
  // Pointer
  tracking: boolean;
  hover: (at: Point) => void;
  /** The step takes a point: object snaps, Ortho and Polar apply to it (status bar, item 14). */
  wantsPoint: boolean;
  /** The last point of the command (Ortho, Polar, Perpendicular, Tangent start there). */
  anchor: Point | null;
  ghost: { indexes: readonly number[]; step: Affine } | null;
  sketch: { points: readonly Point[]; closed: boolean } | null;
  /** The pointer a running command follows; the canvas subscribes, the workspace does not. */
  pointerStore: PointStore;
  /** The ghost and rubber band of the running command for a pointer position. */
  liveDraw: (pointer: Point | null) => LiveDraw;
  // Layers
  /** Layers items may be drawn on or moved to (they have a usable rule; added ones too). */
  layers: string[];
  /** Every layer: the drawing's and those added on the page. */
  allLayers: string[];
  currentLayer: string;
  /** The layer drop-down: with objects picked they move to it, else it becomes current. */
  chooseLayer: (value: string) => void;
  /** A new layer; `like` null = for drawing only (the build ignores what is on it). */
  addLayer: (name: string, like: string | null) => string | null;
  /**
   * What a layer means for the build (ADR-051): `rule` (its own rule in the mapping), `like` (the
   * mapped layer it was made to mean, on the page), or `none` (drawing only).
   */
  meaningOf: (
    layer: string,
  ) => { kind: 'rule' } | { kind: 'like'; like: string } | { kind: 'none' };
  /** A layer without a rule of its own takes the meaning of a mapped one (everything on it). */
  setMeaning: (layer: string, like: string) => void;
  renameLayer: (from: string, to: string) => string | null;
  deleteLayer: (name: string) => void;
  // Properties (screen only, ADR-051)
  /** The style of the first picked object (null fields: by layer); null with nothing picked. */
  selectionStyle: PreviewStyle | null;
  setStyle: (patch: Partial<PreviewStyle>) => void;
  // Unsaved edits
  edits: readonly CanvasEdit[];
  /** The saved corrections with the unsaved edits on top. */
  preview: DrawingPreview | null;
  undo: () => void;
  canUndo: boolean;
  /** One step forward again after Undo (Ctrl+Y); a new edit empties it, as in AutoCAD. */
  redo: () => void;
  canRedo: boolean;
  save: () => void;
  saving: boolean;
  cancel: () => void;
  error: ErrorMessage | null;
}

interface Input {
  projectId: string;
  cadFileId: string;
  available: boolean;
  scene: DrawingScene | null;
  preview: DrawingPreview | null;
  /** Layers an item may move to (they have a rule; owner 2026-11-09). */
  layers: string[];
  /** The entity's layer is on and not frozen (it is drawn). */
  isShown: (index: number) => boolean;
  /** The entity's layer is locked (screen only): it cannot be picked. */
  isLocked?: (index: number) => boolean;
  /** Text height of a text added without one (drawing units). */
  textHeight?: number;
  /** LAYER: open the Layer Properties palette. */
  onOpenLayers?: () => void;
  /** Layers with a rule of their own in the mapping (any target). */
  ruledLayers?: ReadonlySet<string>;
  /** The Layers panel on the screen (LAYOFF, LAYISO, …; owner 2026-11-24). */
  layerScreen?: LayerScreen;
  /** FIND, Layer Walk and Edit Attributes open a dialog. */
  openDialog?: (dialog: WorkspaceDialog | null) => void;
  /** How near two line ends must be to JOIN, drawing units (the build's route end tolerance). */
  joinTouch?: number;
  /** One Undo history for the edits and the screen states (item 13); its own when absent. */
  history?: UndoHistory;
  /** The screen states (layers, isolation…) the history puts back. */
  screen?: HistoryPart;
}

/** Line ends that meet when the drawing's scale is not known: only the very same point. */
const JOIN_TOUCH_FALLBACK = 1e-6;

/** AutoCAD's command name echoed when an edit made outside a command is undone. */
const EDIT_LABEL: Readonly<Record<string, string>> = {
  erase_item: 'ERASE',
  move_layer: 'LAYER',
  add_layer: 'LAYER',
  rename_layer: 'RENAME',
  delete_layer: 'LAYDEL',
  set_style: 'PROPERTIES',
  set_text: 'TEXTEDIT',
  set_attribute: 'EATTEDIT',
  set_order: 'DRAWORDER',
  set_group: 'GROUP',
};
/** Single-line text: the next line starts under the last one, 5/3 of the height lower. */
export const textLineBelow = (at: Point, height: number): Point => ({
  x: at.x,
  y: at.y - (height * 5) / 3,
});

/** Degrees counter-clockwise from the base point to the point (0 = to the right, as CAD). */
const directionOf = (base: Point, at: Point) =>
  (Math.atan2(at.y - base.y, at.x - base.x) * 180) / Math.PI;
const pt = (p: Point): Pt => [p.x, p.y];
const xy = (p: Pt): Point => ({ x: p[0], y: p[1] });

/** What a running command draws under the pointer. */
export interface LiveDraw {
  ghost: { indexes: readonly number[]; step: Affine } | null;
  sketch: { points: readonly Point[]; closed: boolean } | null;
}

/** A value outside React that the canvas subscribes to (the pointer on the drawing). */
export interface PointStore {
  get: () => Point | null;
  set: (next: Point | null) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createPointStore(): PointStore {
  let value: Point | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      if (next === value || (next && value && next.x === value.x && next.y === value.y)) return;
      value = next;
      listeners.forEach((l) => l());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useCanvasEdit(input: Input): CanvasEditState {
  const {
    projectId,
    cadFileId,
    available,
    scene: fileScene,
    preview: saved,
    layers: mapped,
    isShown,
  } = input;
  const isLocked = input.isLocked ?? (() => false);
  const textHeight = input.textHeight ?? 2.5;
  const { t } = useI18n();
  const saveMutation = useSaveCorrections(projectId, cadFileId);
  const [editing, setEditing] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [lastCmd, setLastCmd] = useState<CommandId | null>(null);
  const [selection, setSelection] = useState<ReadonlySet<number>>(NONE);
  const [band, setBand] = useState<Band | null>(null);
  // The pointer lives in a small store, not in React state: a move redraws only the canvas'
  // overlay (rubber band, ghost), never the whole workspace (round 2, items 26 / 30).
  const [pointerStore] = useState(createPointStore);
  const setPointer = pointerStore.set;
  const [text, setText] = useState('');
  const [history, setHistory] = useState<readonly string[]>([]);
  const [focusNonce, setFocusNonce] = useState(0);
  const [currentLayer, setCurrentLayer] = useState('');
  const [filletRadius, setFilletRadius] = useState(0);
  const [offsetDist, setOffsetDist] = useState(1);
  // AutoCAD keeps these settings from one use of a command to the next.
  const [copyMultiple, setCopyMultiple] = useState(true);
  // OFFSETDIST starts at -1 in AutoCAD: the first OFFSET offers <Through>.
  const [offsetThrough, setOffsetThrough] = useState(true);
  const [offsetErase, setOffsetErase] = useState(false);
  const [offsetOnCurrent, setOffsetOnCurrent] = useState(false);
  const [filletTrim, setFilletTrim] = useState(true);
  const [lastRadius, setLastRadius] = useState<number | null>(null);
  // ROTATE's last angle, SCALE's last factor and TEXTSIZE are the next defaults (AutoCAD).
  const [lastAngle, setLastAngle] = useState(0);
  const [lastFactor, setLastFactor] = useState(1);
  const [lastTextHeight, setLastTextHeight] = useState<number | null>(null);
  /** Where the last LINE ended: Enter at «Specify first point:» goes on from there. */
  const [lineEnd, setLineEnd] = useState<Point | null>(null);
  const [rect, setRect] = useState<{
    chamfer: [number, number] | null;
    fillet: number | null;
    rotation: number;
    length: number;
    width: number;
    area: number;
  }>({ chamfer: null, fillet: null, rotation: 0, length: 10, width: 10, area: 100 });
  const [previous, setPrevious] = useState<ReadonlySet<number>>(NONE);
  /** The clipboard stays in the page: the objects' handles and the base point (ADR-058 note). */
  const [clipboard, setClipboard] = useState<{ handles: string[]; base: Point } | null>(null);
  const [edits, setEdits] = useState<readonly CanvasEdit[]>([]);
  const [extraSettings, setExtraSettings] = useState<ExtraSettings>(DEFAULT_EXTRA_SETTINGS);
  const ownHistory = useHistory();
  const undoHistory = input.history ?? ownHistory;
  const [error, setError] = useState<ErrorMessage | null>(null);
  const [gripRun, setGripRun] = useState<GripRun | null>(null);

  // Leaving the page with unsaved edits asks first.
  const unsaved = edits.length > 0;
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);

  // What a running command shows before it is kept (a table being filled; ADR-055 part 7).
  const pending = useMemo(
    () =>
      run ? [...textPending(run), ...hatchPending(run, extraSettings.hatch, currentLayer)] : [],
    [run, extraSettings.hatch, currentLayer],
  );
  const shown = useMemo(
    () =>
      fileScene && saved
        ? previewWithEdits(
            fileScene,
            saved,
            pending.length > 0 ? [...edits, ...pending] : edits,
            textHeight,
            edits.length,
          )
        : null,
    [fileScene, saved, edits, pending, textHeight],
  );
  // Items drawn, pasted or copied on the page are objects (ADR-061, owner item 36): every
  // command below works on the page scene, the file's entities with the page's rows after them.
  const scene = useMemo(
    () => (fileScene && shown ? pageSceneOf(fileScene, shown) : fileScene),
    [fileScene, shown],
  );

  // Layers added or renamed (saved and unsaved) take the meaning of their source.
  const aliases = shown?.aliases ?? new Map<string, string>();
  const removed = useMemo(
    () =>
      new Set(
        edits.flatMap((edit) =>
          edit.kind === 'delete_layer'
            ? [edit.layer]
            : edit.kind === 'rename_layer'
              ? [edit.from]
              : [],
        ),
      ),
    [edits],
  );
  const layers = useMemo(() => {
    const out = new Set(mapped);
    for (const [name, like] of aliases) {
      // A layer with a rule of its own keeps it (the worker does the same, ADR-051).
      if (mapped.includes(like) && !input.ruledLayers?.has(name)) out.add(name);
    }
    return [...out].filter((name) => !removed.has(name)).sort((a, b) => a.localeCompare(b));
  }, [mapped, aliases, removed]);
  const allLayers = useMemo(() => {
    const out = new Set((scene?.view.layers ?? []).map((l) => l.name));
    for (const name of aliases.keys()) out.add(name);
    return [...out].filter((name) => !removed.has(name)).sort((a, b) => a.localeCompare(b));
  }, [scene, aliases, removed]);
  const current = allLayers.includes(currentLayer) ? currentLayer : '';
  // Owner 2026-11-19 (ADR-051): drawing goes on any layer; on one without a rule it is for
  // drawing only, and giving the layer a meaning makes the build read it.
  const drawLayer = current;
  const ruled = input.ruledLayers ?? new Set<string>();
  const [warned, setWarned] = useState<ReadonlySet<string>>(new Set());

  // ---------- helpers ----------

  const say = (...lines: string[]) =>
    setHistory((previous) => [...previous, ...lines].slice(-HISTORY_LINES));
  const msg = (key: string, params?: Record<string, string | number>) =>
    t(`design.cad.msg.${key}` as MessageKey, params);

  const handles = scene ? handlesOf(scene, selection) : [];
  /** The entity and, with group selection on, every shown member of its groups. */
  const groupMembers = (index: number): number[] => {
    if (!scene || !shown || shown.groups.size === 0) return [index];
    const handle = scene.view.entities[index]?.handle;
    const out = new Set([index]);
    for (const group of shown.groups.values()) {
      // PICKSTYLE for groups; a block made on the page is always one object (AutoCAD).
      if (!handle || !group.handles.includes(handle) || !(extraSettings.groupPick || group.block))
        continue;
      for (const h of group.handles) {
        for (const i of scene.byHandle.get(h) ?? []) if (pickable(i)) out.add(i);
      }
    }
    return [...out];
  };
  const addLike: CommandId | null = (() => {
    if (!scene || selection.size !== 1) return null;
    const [index] = selection;
    const kind = index === undefined ? '' : (scene.view.entities[index]?.kind ?? '');
    return DRAW_LIKE[kind] ?? null;
  })();
  const pickable = (index: number) =>
    shown !== null && !shown.erased.has(index) && isShown(index) && !isLocked(index);
  const layerNameOf = (index: number): string => {
    if (!scene || !shown) return '';
    const layer = effectiveLayer(scene, shown, index);
    return scene.view.layers[layer]?.name ?? '';
  };

  /** The points of a line or polyline as drawn now (moves and curve edits applied). */
  const curveGeom = (index: number): { points: Pt[]; closed: boolean } | null => {
    if (!scene || !shown) return null;
    const entity = scene.view.entities[index];
    if (!entity || !CURVE_KINDS.has(entity.kind)) return null;
    const replaced = shown.curveOf.get(index);
    if (replaced)
      return { points: replaced.points.map((p) => [p[0], p[1]] as Pt), closed: replaced.closed };
    if (entity.paths.length !== 1) return null;
    const flat = entity.paths[0] as readonly number[];
    const moved = shown.transformOf.get(index);
    let points: Pt[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const p = { x: flat[i] as number, y: flat[i + 1] as number };
      points.push(pt(moved ? applyAffine(moved, p.x, p.y) : p));
    }
    let closed = false;
    const first = points[0];
    const last = points[points.length - 1];
    if (points.length > 2 && first && last && first[0] === last[0] && first[1] === last[1]) {
      points = points.slice(0, -1);
      closed = true;
    }
    return points.length >= 2 ? { points, closed } : null;
  };

  /** Every shown path near a box, as polylines: the cutting edges of TRIM. */
  const edgesNear = (box: Box, skip: number): { points: Pt[]; closed: boolean }[] => {
    if (!scene || !shown) return [];
    const out: { points: Pt[]; closed: boolean }[] = [];
    const meets = (b: Box) =>
      b.minX <= box.maxX && b.maxX >= box.minX && b.minY <= box.maxY && b.maxY >= box.minY;
    scene.view.entities.forEach((entity, index) => {
      if (index === skip || shown.erased.has(index) || !isShown(index) || !entity.paths.length)
        return;
      const replaced = shown.curveOf.get(index);
      if (replaced) {
        out.push({
          points: replaced.points.map((p) => [p[0], p[1]] as Pt),
          closed: replaced.closed,
        });
        return;
      }
      const moved = shown.transformOf.get(index);
      if (!moved && !meets(boxOf(scene, index))) return;
      for (const flat of entity.paths) {
        const points: Pt[] = [];
        for (let i = 0; i + 1 < flat.length; i += 2) {
          const p = { x: flat[i] as number, y: flat[i + 1] as number };
          points.push(pt(moved ? applyAffine(moved, p.x, p.y) : p));
        }
        if (points.length >= 2) out.push({ points, closed: false });
      }
    });
    return out;
  };

  const boxAround = (points: readonly Pt[]): Box => {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const pad = 1e-6;
    return {
      minX: Math.min(...xs) - pad,
      minY: Math.min(...ys) - pad,
      maxX: Math.max(...xs) + pad,
      maxY: Math.max(...ys) + pad,
    };
  };

  /** Adds edits; returns their positions in the list (for the command's Undo). */
  const add = (added: CanvasEdit[]): number[] => {
    const at = edits.length;
    const label = run
      ? COMMANDS[run.cmd].name
      : (EDIT_LABEL[added[0]?.kind ?? ''] ?? added[0]?.kind.toUpperCase() ?? '');
    undoHistory.record(label, 'edits', { edits, currentLayer }, run !== null);
    setEdits((previous) => addEdits(previous, added));
    setError(null);
    return added.map((_, i) => at + i);
  };

  const geometryMessage = (caught: unknown) => {
    if (!(caught instanceof GeometryError)) throw caught;
    say(msg(`geometry.${caught.code}`));
  };

  // ---------- prompts ----------

  const promptOf = (r: Run | null): CommandPrompt => {
    const p = (key: PromptKey, options: CommandOption[] = [], fallback: string | null = null) => ({
      key,
      options,
      fallback,
    });
    if (!r) return p('command');
    const selectWords = isTextCommand(r.cmd) ? textSelectPrompt(r) : null;
    if (selectWords) return selectWords;
    if (isExtra(r.cmd) && r.step !== 'select') {
      const added = extraPrompt(r, extraSettings);
      if (added) return added;
    }
    const f = r.flags;
    switch (r.step) {
      case 'select':
        if (f.removing) return p('removeObjects');
        return r.cmd === 'stretch'
          ? p('stretchSelect')
          : r.cmd === 'join'
            ? p('joinSelect')
            : r.cmd === 'laymch'
              ? p('laymchSelect')
              : p('selectObjects');
      case 'base':
        return r.cmd === 'copy'
          ? p('basePoint', [opt('Displacement', 'D'), opt('mOde', 'O')], 'Displacement')
          : r.cmd === 'move' || r.cmd === 'stretch'
            ? p('basePoint', [opt('Displacement', 'D')], 'Displacement')
            : p('basePoint');
      case 'displacement':
        return p('displacement', [], '0.0000, 0.0000');
      case 'copyMode':
        return p(
          'copyMode',
          [opt('Single', 'S'), opt('Multiple', 'M')],
          copyMultiple ? 'Multiple' : 'Single',
        );
      case 'second':
        if (r.cmd === 'pasteclip') return p('insertionPoint');
        if (r.cmd === 'copy') {
          return r.made.length > 0
            ? p('secondPoint', [opt('Array', 'A'), opt('Exit', 'E'), opt('Undo', 'U')], 'Exit')
            : p('secondPoint', [opt('Array', 'A')], 'use first point as displacement');
        }
        return p('secondPointOr', [], 'use first point as displacement');
      case 'copyArrayCount':
        return p('copyArrayCount');
      case 'copyArraySecond':
        return p('secondPoint', [f.arrayFit ? opt('Array', 'A') : opt('Fit', 'F')]);
      case 'angle':
        return p('rotationAngle', [opt('Copy', 'C'), opt('Reference', 'R')], acadAngle(lastAngle));
      case 'refAngle':
        return p('refAngle', [], '0');
      case 'refAngle2':
      case 'newAngleP2':
      case 'refLength2':
      case 'newLengthP2':
        return p('secondPoint');
      case 'newAngle':
        return p('newAngle', [opt('Points', 'P')], '0');
      case 'newAngleP1':
      case 'newLengthP1':
        return p('firstPoint');
      case 'factor':
        return p('scaleFactor', [opt('Copy', 'C'), opt('Reference', 'R')], acadNumber(lastFactor));
      case 'refLength':
        return p('refLength', [], acadNumber(1));
      case 'newLength':
        return p('newLength', [opt('Points', 'P')], acadNumber(1));
      case 'mirror1':
        return p('mirrorFirst');
      case 'mirror2':
        return p('mirrorSecond');
      case 'mirrorErase':
        return p('mirrorErase', [opt('Yes', 'Y'), opt('No', 'N')], 'No');
      case 'first':
        return r.cmd === 'pline' ? p('plineStart') : p('lineFirst');
      case 'next':
        if (r.cmd === 'pline') {
          if (f.arcMode) {
            return p('arcEndpoint', [
              ...(r.points.length >= 3 ? [opt('CLose', 'CL')] : []),
              opt('Line', 'L'),
              opt('Second pt', 'S'),
              opt('Undo', 'U'),
            ]);
          }
          return p('nextPoint', [
            opt('Arc', 'A'),
            ...(r.points.length >= 3 ? [opt('Close', 'C')] : []),
            opt('Length', 'L'),
            opt('Undo', 'U'),
          ]);
        }
        return r.made.length >= 2
          ? p('nextPoint', [opt('Close', 'C'), opt('Undo', 'U')])
          : p('nextPoint', [opt('Undo', 'U')]);
      case 'plineLength':
        return p('plineLength');
      case 'plineArc2':
        return p('arcSecond');
      case 'plineArc3':
        return p('arcEnd');
      case 'center':
        return p('circleCenter', [
          opt('3P', '3P'),
          opt('2P', '2P'),
          opt('Ttr (tan tan radius)', 'T'),
        ]);
      case 'radius':
        return p(
          'circleRadius',
          [opt('Diameter', 'D')],
          lastRadius ? acadNumber(lastRadius) : null,
        );
      case 'diameter':
        return p('circleDiameter', [], lastRadius ? acadNumber(lastRadius * 2) : null);
      case 'c3p1':
        return p('circleFirst');
      case 'c3p2':
        return p('circleSecond');
      case 'c3p3':
        return p('circleThird');
      case 'c2p1':
        return p('diameterFirst');
      case 'c2p2':
        return p('diameterSecond');
      case 'ttr1':
        return p('ttrFirst');
      case 'ttr2':
        return p('ttrSecond');
      case 'ttrRadius':
        return p('circleRadius', [], lastRadius ? acadNumber(lastRadius) : null);
      case 'arc1':
        return p('arcStart', [opt('Center', 'C')]);
      case 'arc2':
        return p('arcSecond', [opt('Center', 'C'), opt('End', 'E')]);
      case 'arc3':
        return p('arcEnd');
      case 'arcCenter':
        return p('arcCenterPoint');
      case 'arcCStart':
        return p('arcStart');
      case 'arcCEnd':
        return p('arcEnd', [opt('Angle', 'A')]);
      case 'arcCAngle':
      case 'arcEAngle':
        return p('includedAngle');
      case 'arcEEnd':
        return p('arcEnd');
      case 'arcEOpt':
        return p('arcCenterPoint', [opt('Angle', 'A'), opt('Radius', 'R')]);
      case 'arcERadius':
        return p('arcRadius');
      case 'corner1':
        return p('rectFirst', [opt('Chamfer', 'C'), opt('Fillet', 'F')]);
      case 'chamfer1':
        return p('chamferFirst', [], acadNumber(rect.chamfer?.[0] ?? 0));
      case 'chamfer2':
        return p('chamferSecond', [], acadNumber(f.chamfer1 ?? rect.chamfer?.[1] ?? 0));
      case 'rectFillet':
        return p('rectFilletRadius', [], acadNumber(rect.fillet ?? 0));
      case 'corner2':
        return p('rectOther', [opt('Area', 'A'), opt('Dimensions', 'D'), opt('Rotation', 'R')]);
      case 'rectLength':
        return p('rectLength', [], acadNumber(rect.length));
      case 'rectWidth':
        return p('rectWidth', [], acadNumber(rect.width));
      case 'rectSide':
        return p('rectOther');
      case 'rectRotation':
        return p('rectRotation', [], acadNumber(rect.rotation));
      case 'rectArea':
        return p('rectArea', [], acadNumber(rect.area));
      case 'rectAreaBy':
        return p('rectAreaBy', [opt('Length', 'L'), opt('Width', 'W')], 'Length');
      case 'rectAreaLength':
        return p('rectAreaLength', [], acadNumber(rect.length));
      case 'rectAreaWidth':
        return p('rectAreaWidth', [], acadNumber(rect.width));
      case 'pointAt':
        return p('pointAt');
      case 'trimPick':
        // Undo is offered once something was trimmed (AutoCAD).
        return p('trimPick', [
          opt('cuTting edges', 'T'),
          opt('eRase', 'R'),
          ...(r.made.length > 0 ? [opt('Undo', 'U')] : []),
        ]);
      case 'trimEdges':
        return p('trimEdges', [], 'select all');
      case 'trimErase':
        return p('trimErase', [], 'exit');
      case 'filletFirst':
        return p('filletFirst', [
          opt('Undo', 'U'),
          opt('Polyline', 'P'),
          opt('Radius', 'R'),
          opt('Trim', 'T'),
          opt('Multiple', 'M'),
        ]);
      case 'filletSecond':
        return p('filletSecond', [opt('Radius', 'R')]);
      case 'filletRadius':
        return p('filletRadius', [], acadNumber(filletRadius));
      case 'filletTrim':
        return p(
          'filletTrim',
          [opt('Trim', 'T'), opt('No trim', 'N')],
          filletTrim ? 'Trim' : 'No trim',
        );
      case 'filletPoly':
        return p('filletPoly');
      case 'offsetDistance':
        return p(
          'offsetDistance',
          [opt('Through', 'T'), opt('Erase', 'E'), opt('Layer', 'L')],
          offsetThrough ? 'Through' : acadNumber(offsetDist),
        );
      case 'offsetErase':
        return p('offsetErase', [opt('Yes', 'Y'), opt('No', 'N')], offsetErase ? 'Yes' : 'No');
      case 'offsetLayer':
        return p(
          'offsetLayer',
          [opt('Current', 'C'), opt('Source', 'S')],
          offsetOnCurrent ? 'Current' : 'Source',
        );
      case 'offsetPick':
        return p('offsetPick', [opt('Exit', 'E'), opt('Undo', 'U')], 'Exit');
      case 'offsetSide':
        return p(
          offsetThrough ? 'offsetThrough' : 'offsetSide',
          [opt('Exit', 'E'), opt('Multiple', 'M'), opt('Undo', 'U')],
          'Exit',
        );
      case 'textStart':
        return p('textStart');
      case 'textHeight':
        return p('textHeight', [], acadNumber(lastTextHeight ?? textHeight));
      case 'textValue':
        return p('textValue');
      case 'editPick':
        return p('editPick', [opt('Undo', 'U')]);
      case 'editValue':
        return p('editValue');
      case 'dim1':
        return p('dimFirst', [], 'select object');
      case 'dimSelect':
        return p('dimSelect');
      case 'dim2':
        return p('dimSecond');
      case 'dim3':
        return p('dimLocation', [
          opt('Mtext', 'M'),
          opt('Text', 'T'),
          opt('Horizontal', 'H'),
          opt('Vertical', 'V'),
        ]);
      case 'dimTextValue':
        return p('dimTextValue');
      case 'leaderStart':
        return p('leaderStart');
      case 'leaderNext':
        return r.points.length >= 2
          ? p('nextPoint', [opt('Annotation', 'A'), opt('Undo', 'U')], 'Annotation')
          : p('nextPoint');
      case 'leaderText':
        return p('leaderText');
      case 'source':
        return p('matchSource');
      case 'dest':
        return p('matchDest');
      case 'laymcurPick':
        return p('laymcurPick');
      case 'laymchDest':
        return p('laymchDest', [opt('Name', 'N')]);
      case 'laymchName':
        return p('layerName');
    }
    return p('command');
  };

  const promptLine = (r: Run | null) =>
    formatPrompt(t, r ? COMMANDS[r.cmd].name : null, promptOf(r));

  // ---------- running ----------

  const finish = (keepSelection = false) => {
    undoHistory.close();
    if (handles.length > 0) setPrevious(selection);
    setRun(null);
    setPointer(null);
    setBand(null);
    setText('');
    if (!keepSelection) setSelection(NONE);
  };

  const go = (r: Run, step: Step, patch: Partial<Run> = {}) => setRun({ ...r, ...patch, step });
  const flag = (r: Run, patch: Partial<Flags>, step?: Step) =>
    setRun({ ...r, step: step ?? r.step, flags: { ...r.flags, ...patch } });

  /** The added Draw / Modify commands share this command line (owner 2026-11-24). */
  const extraCtx = (): ExtraContext<Run> | null =>
    scene && shown
      ? {
          scene,
          shown,
          selection,
          handles,
          drawLayer,
          editCount: edits.length,
          settings: extraSettings,
          setSettings: (patch) => setExtraSettings((previous) => ({ ...previous, ...patch })),
          say,
          msg,
          add,
          finish,
          setRun,
          setSelection,
          curveGeom,
          pickable,
          layerNameOf,
          needDrawLayer,
          geometryMessage,
          drop: dropEdits,
          usableLayers: layers,
          layerScreen: input.layerScreen,
          openDialog: input.openDialog,
        }
      : null;

  const begin = (cmd: CommandId): Run | null | undefined => {
    if (!scene) return null;
    setError(null);
    setLastCmd(cmd);
    setText('');
    setBand(null);
    setFocusNonce((n) => n + 1);
    say(msg('commandEcho', { name: COMMANDS[cmd].name }));
    const picked = handles.length > 0;
    const next = (step: Step): Run => {
      const r = newRun(cmd, step);
      setRun(r);
      return r;
    };
    const ctx = isExtra(cmd) ? extraCtx() : null;
    if (ctx) return extraBegin(ctx, cmd, (step) => newRun(cmd, step as Step));
    switch (cmd) {
      case 'move':
      case 'copy':
      case 'rotate':
      case 'scale':
        if (cmd === 'copy')
          say(msg('copySettings', { mode: copyMultiple ? 'Multiple' : 'Single' }));
        if (cmd === 'rotate') say(msg('rotateSettings'));
        return next(picked ? 'base' : 'select');
      case 'mirror':
        return next(picked ? 'mirror1' : 'select');
      case 'stretch':
        setSelection(NONE);
        return next('select');
      case 'erase':
        if (picked) {
          add(eraseEdits(handles));
          finish();
          return;
        }
        return next('select');
      case 'join':
        if (picked && handles.length >= 2) {
          join(handles);
          return;
        }
        return next('select');
      case 'laymch':
        return next(picked ? 'laymchDest' : 'select');
      case 'line':
        return next('first');
      case 'pline':
        return next('first');
      case 'circle':
        return next('center');
      case 'arc':
        return next('arc1');
      case 'rectang':
        if (rect.chamfer || rect.fillet) {
          say(
            rect.fillet
              ? msg('rectFilletMode', { radius: acadNumber(rect.fillet) })
              : msg('rectChamferMode', {
                  first: acadNumber(rect.chamfer?.[0] ?? 0),
                  second: acadNumber(rect.chamfer?.[1] ?? 0),
                }),
          );
        }
        return next('corner1');
      case 'point':
        say(msg('pointModes'));
        return next('pointAt');
      case 'trim':
        setSelection(NONE);
        say(msg('trimSettings'));
        return next('trimPick');
      case 'fillet':
        setSelection(NONE);
        say(
          msg('filletSettings', {
            mode: filletTrim ? 'TRIM' : 'NOTRIM',
            radius: acadNumber(filletRadius),
          }),
        );
        return next('filletFirst');
      case 'offset':
        setSelection(NONE);
        say(
          msg('offsetSettings', {
            erase: offsetErase ? 'Yes' : 'No',
            layer: offsetOnCurrent ? 'Current' : 'Source',
          }),
        );
        return next('offsetDistance');
      case 'text':
        say(msg('textSettings', { height: acadNumber(lastTextHeight ?? textHeight) }));
        return next('textStart');
      case 'textedit': {
        say(msg('textEditSettings'));
        const [only] = [...selection];
        if (only !== undefined && isTextEntity(scene, only)) {
          editText(only);
          return;
        }
        setSelection(NONE);
        return next('editPick');
      }
      case 'dimlinear':
        return next('dim1');
      case 'leader':
        return next('leaderStart');
      case 'layer':
        input.onOpenLayers?.();
        finish(true);
        return;
      case 'matchprop': {
        const [only] = [...selection];
        if (only !== undefined && selection.size === 1) {
          const r = newRun(cmd, 'dest');
          r.target = only;
          setRun(r);
          setSelection(NONE);
          say(msg('matchSettings'));
          return;
        }
        setSelection(NONE);
        return next('source');
      }
      case 'laymcur':
        return next('laymcurPick');
      case 'copyclip':
      case 'cutclip':
        if (picked) {
          clipSelected(cmd, null);
          return;
        }
        return next('select');
      case 'copybase':
        return next('base');
      case 'pasteclip': {
        if (!clipboard) {
          say(msg('clipboardEmpty'));
          finish();
          return;
        }
        const indexes = clipboard.handles.flatMap((handle) => scene.byHandle.get(handle) ?? []);
        setSelection(new Set(indexes));
        const r = newRun(cmd, 'second');
        r.base = clipboard.base;
        setRun(r);
        return r;
      }
    }
  };

  /** COPYCLIP / CUTCLIP / COPYBASE: the picked objects go to the page's clipboard. */
  const clipSelected = (cmd: CommandId, base: Point | null) => {
    if (!scene) return;
    const indexes = [...selection];
    let at = base;
    if (!at) {
      // AutoCAD's base point for COPYCLIP is the lower-left corner of the extents.
      let minX = Infinity;
      let minY = Infinity;
      for (const index of indexes) {
        const box = boxOf(scene, index);
        minX = Math.min(minX, box.minX);
        minY = Math.min(minY, box.minY);
      }
      at = { x: minX, y: minY };
    }
    setClipboard({ handles, base: at });
    say(msg('found', { count: handles.length }));
    if (cmd === 'cutclip') add(eraseEdits(handles));
    finish();
  };

  /** TEXTEDIT on a text; `from` (picked at its prompt): ask for the next one after it (Multiple). */
  const editText = (index: number, from: Run | null = null) => {
    const r: Run = from
      ? { ...from, step: 'editValue', target: index, flags: { ...from.flags, repeat: true } }
      : { ...newRun('textedit', 'editValue'), target: index };
    setRun(r);
    setSelection(new Set([index]));
    setText(shown?.textOf.get(index) ?? scene?.view.entities[index]?.texts[0]?.text ?? '');
    setFocusNonce((n) => n + 1);
  };

  const join = (picked: string[]) => {
    const curves = picked.filter((handle) =>
      (scene?.byHandle.get(handle) ?? []).some((index) => curveGeom(index) !== null),
    );
    if (curves.length < 2) {
      say(msg('joinNeedsTwo'));
      finish();
      return;
    }
    // The build refuses lines that do not meet end to end on one layer: say so now, as AutoCAD.
    const pieces: JoinPiece[] = [];
    for (const handle of curves) {
      for (const index of scene?.byHandle.get(handle) ?? []) {
        const geom = curveGeom(index);
        if (geom) pieces.push({ handle, layer: layerNameOf(index), ...geom });
      }
    }
    const problem = joinProblem(pieces, input.joinTouch ?? JOIN_TOUCH_FALLBACK);
    if (problem) {
      say(msg(problem === 'layers' ? 'joinLayers' : 'joinChain'));
      finish();
      return;
    }
    add([{ kind: 'merge_routes', handles: curves }]);
    say(msg('joined', { count: curves.length }));
    finish();
  };

  const needDrawLayer = (): boolean => {
    if (!drawLayer) {
      say(msg('needLayer'));
      return false;
    }
    // Once per layer: what is drawn on a layer without a meaning is not counted.
    if (!layers.includes(drawLayer) && !warned.has(drawLayer)) {
      say(msg('drawingOnly', { layer: drawLayer }));
      setWarned((previous) => new Set(previous).add(drawLayer));
    }
    return true;
  };

  /** After the objects are picked: the next step of the command. */
  const afterSelect = (r: Run) => {
    if (handles.length === 0) {
      finish();
      return;
    }
    const ctx = isExtra(r.cmd) ? extraCtx() : null;
    if (ctx) {
      extraAfterSelect(ctx, r);
      return;
    }
    switch (r.cmd) {
      case 'copyclip':
      case 'cutclip':
      case 'copybase':
        clipSelected(r.cmd, r.base);
        return;
      case 'erase':
        add(eraseEdits(handles));
        finish();
        return;
      case 'join':
        join(handles);
        return;
      case 'mirror':
        go(r, 'mirror1');
        return;
      case 'laymch':
        go(r, 'laymchDest');
        return;
      case 'stretch':
        if (!r.window) {
          say(msg('stretchWindow'));
          finish();
          return;
        }
        go(r, 'base');
        return;
      default:
        go(r, 'base');
    }
  };

  /** A copy of the picked objects stays where they are; the originals are then changed. */
  const keepCopy = (copy: boolean | undefined): CanvasEdit[] =>
    copy ? copyEdits(handles, 0, 0) : [];

  const moveBy = (r: Run, dx: number, dy: number) => {
    if (r.cmd === 'move') {
      add(moveEdits(handles, dx, dy));
      finish();
    } else if (r.cmd === 'copy') {
      const made = add(copyEdits(handles, dx, dy));
      if (!copyMultiple) finish();
      else go(r, 'second', { made: [...r.made, made.length] });
    } else if (r.cmd === 'stretch') {
      stretch(r, dx, dy);
    } else if (r.cmd === 'pasteclip') {
      // PASTECLIP: the objects come back where the insertion point puts them, once.
      add(copyEdits(handles, dx, dy));
      finish();
    }
  };

  /** COPY Array: the items after the original, a step apart (Fit: the point is the last item). */
  const copyArray = (r: Run, dx: number, dy: number) => {
    const count = r.flags.arrayCount ?? 2;
    const steps = r.flags.arrayFit ? count - 1 : 1;
    const out: CanvasEdit[] = [];
    for (let i = 1; i < count; i++) {
      out.push(...copyEdits(handles, (dx * i) / steps, (dy * i) / steps));
    }
    const made = add(out);
    if (!copyMultiple) {
      finish();
      return;
    }
    setRun({
      ...r,
      step: 'second',
      made: [...r.made, made.length],
      flags: { ...r.flags, arrayCount: undefined, arrayFit: undefined },
    });
  };

  const rotateBy = (r: Run, angle: number) => {
    if (!r.base) return;
    if (Math.abs(angle) > 360) {
      say(msg('badValue'));
      return;
    }
    add([...keepCopy(r.flags.copy), ...rotateEdits(handles, r.base.x, r.base.y, angle)]);
    setLastAngle(angle);
    finish();
  };

  const feedFactor = (r: Run, factor: number) => {
    if (!r.base) return;
    if (!(factor >= 0.001 && factor <= 1000)) {
      say(msg('badFactor'));
      return;
    }
    add([...keepCopy(r.flags.copy), ...scaleEdits(handles, r.base.x, r.base.y, factor)]);
    setLastFactor(factor);
    finish();
  };

  /** RECTANG: the rectangle with the chamfer or fillet of the corners asked for. */
  const rectangle = (corners: Pt[]) => {
    try {
      let shape = corners;
      if (rect.fillet && rect.fillet > 0) shape = filletPolyline(corners, true, rect.fillet).points;
      else if (rect.chamfer) shape = chamferPolygon(corners, rect.chamfer[0], rect.chamfer[1]);
      add([pointsCurveEdit(drawLayer, shape, true)]);
      finish();
    } catch (caught) {
      geometryMessage(caught);
    }
  };

  /** PLINE: points of the polyline so far, and where each segment started (for Undo). */
  const plineAdd = (r: Run, added: Point[], patch: Partial<Flags> = {}) =>
    setRun({
      ...r,
      points: [...r.points, ...added],
      flags: { ...r.flags, ...patch, segments: [...(r.flags.segments ?? []), r.points.length] },
    });

  const plineArcTo = (r: Run, end: Point) => {
    const pts = r.points.map(pt);
    const dir = r.flags.direction ?? endDirection(pts);
    const from = pt(r.points[r.points.length - 1] as Point);
    const arc = tangentArc(from, dir, pt(end));
    plineAdd(r, arc.map(xy), { direction: arcEndDirection(from, dir, pt(end)) });
  };

  /** A point given for the step (clicked, typed, or by direct distance). */
  /** The added commands take their own entries (except «Select objects:»). */
  const extraFor = (r: Run): ExtraContext<Run> | null =>
    isExtra(r.cmd) && r.step !== 'select' ? extraCtx() : null;

  const feedPoint = (r: Run, p: Point) => {
    const ctx = extraFor(r);
    if (ctx) {
      extraPoint(ctx, r, p);
      return;
    }
    const last = r.points[r.points.length - 1] ?? null;
    const f = r.flags;
    switch (r.step) {
      case 'base':
        if (r.cmd === 'copybase') {
          if (handles.length > 0) clipSelected(r.cmd, p);
          else go(r, 'select', { base: p });
          return;
        }
        go(r, r.cmd === 'rotate' ? 'angle' : r.cmd === 'scale' ? 'factor' : 'second', { base: p });
        setPointer(p);
        return;
      case 'displacement':
        // A typed point is the displacement itself (AutoCAD).
        moveBy(r, p.x, p.y);
        return;
      case 'second':
        if (r.base) moveBy(r, p.x - r.base.x, p.y - r.base.y);
        return;
      case 'copyArraySecond':
        if (r.base) copyArray(r, p.x - r.base.x, p.y - r.base.y);
        return;
      case 'angle':
        if (r.base) rotateBy(r, directionOf(r.base, p));
        return;
      case 'refAngle':
        go(r, 'refAngle2', { points: [p] });
        setPointer(p);
        return;
      case 'refAngle2': {
        const [a] = r.points;
        if (a) flag(r, { refAngle: directionOf(a, p) }, 'newAngle');
        return;
      }
      case 'newAngle':
        if (r.base) rotateBy(r, directionOf(r.base, p) - (f.refAngle ?? 0));
        return;
      case 'newAngleP1':
        go(r, 'newAngleP2', { points: [p] });
        setPointer(p);
        return;
      case 'newAngleP2': {
        const [a] = r.points;
        if (a) rotateBy(r, directionOf(a, p) - (f.refAngle ?? 0));
        return;
      }
      case 'factor':
        if (r.base) feedFactor(r, distance(pt(r.base), pt(p)));
        return;
      case 'refLength':
        go(r, 'refLength2', { points: [p] });
        setPointer(p);
        return;
      case 'refLength2': {
        const [a] = r.points;
        if (!a) return;
        const length = distance(pt(a), pt(p));
        if (length > 0) flag(r, { refLength: length }, 'newLength');
        else say(msg('badValue'));
        return;
      }
      case 'newLength':
        if (r.base) feedFactor(r, distance(pt(r.base), pt(p)) / (f.refLength ?? 1));
        return;
      case 'newLengthP1':
        go(r, 'newLengthP2', { points: [p] });
        setPointer(p);
        return;
      case 'newLengthP2': {
        const [a] = r.points;
        if (a) feedFactor(r, distance(pt(a), pt(p)) / (f.refLength ?? 1));
        return;
      }
      case 'mirror1':
        go(r, 'mirror2', { base: p });
        setPointer(p);
        return;
      case 'mirror2':
        if (!r.base || (p.x === r.base.x && p.y === r.base.y)) return;
        go(r, 'mirrorErase', { points: [r.base, p] });
        return;
      case 'first':
        if (!needDrawLayer()) return;
        go(r, 'next', { points: [p] });
        setPointer(p);
        return;
      case 'next':
        if (!last) return;
        if (r.cmd === 'line') {
          const made = add([curveEdit(drawLayer, [last, p], false)]);
          setLineEnd(p);
          go(r, 'next', { points: [...r.points, p], made: [...r.made, made.length] });
        } else if (f.arcMode) {
          plineArcTo(r, p);
        } else {
          plineAdd(r, [p], { direction: endDirection([pt(last), pt(p)]) });
        }
        return;
      case 'plineArc2':
        go(r, 'plineArc3', { base: p });
        return;
      case 'plineArc3': {
        if (!last || !r.base) return;
        try {
          const arc = arcThrough(pt(last), pt(r.base), pt(p)).slice(1);
          setRun({
            ...r,
            step: 'next',
            base: null,
            points: [...r.points, ...arc.map(xy)],
            flags: {
              ...f,
              direction: arcThroughEndDirection(pt(last), pt(r.base), pt(p)),
              segments: [...(f.segments ?? []), r.points.length],
            },
          });
        } catch (caught) {
          geometryMessage(caught);
        }
        return;
      }
      case 'center':
        if (!needDrawLayer()) return;
        go(r, 'radius', { base: p });
        setPointer(p);
        return;
      case 'radius':
      case 'diameter':
        if (r.base) circle(r.base, distance(pt(r.base), pt(p)) / (r.step === 'diameter' ? 2 : 1));
        return;
      case 'c3p1':
      case 'c3p2':
        go(r, r.step === 'c3p1' ? 'c3p2' : 'c3p3', { points: [...r.points, p] });
        setPointer(p);
        return;
      case 'c3p3': {
        const [a, b] = r.points;
        const c = a && b ? circleThrough(pt(a), pt(b), pt(p)) : null;
        if (!c) {
          say(msg('geometry.COLLINEAR'));
          return;
        }
        circle(xy(c.center), c.radius);
        return;
      }
      case 'c2p1':
        go(r, 'c2p2', { points: [p] });
        setPointer(p);
        return;
      case 'c2p2': {
        const [a] = r.points;
        if (!a) return;
        circle({ x: (a.x + p.x) / 2, y: (a.y + p.y) / 2 }, distance(pt(a), pt(p)) / 2);
        return;
      }
      case 'ttrRadius':
        if (r.points[0] && r.points[1]) feedNumber(r, distance(pt(r.points[0]), pt(p)));
        return;
      case 'arc1':
        if (!needDrawLayer()) return;
        go(r, 'arc2', { points: [p] });
        setPointer(p);
        return;
      case 'arc2':
        go(r, 'arc3', { points: [...r.points, p] });
        return;
      case 'arc3': {
        const [a, b] = r.points;
        if (!a || !b) return;
        drawArc(() => arcThrough(pt(a), pt(b), pt(p)));
        return;
      }
      case 'arcCenter':
        // C at the first prompt: centre, then start; C at the second: the start is known.
        if (r.points.length > 0) go(r, 'arcCEnd', { base: p });
        else go(r, 'arcCStart', { base: p });
        setPointer(p);
        return;
      case 'arcCStart':
        if (!needDrawLayer()) return;
        go(r, 'arcCEnd', { points: [p] });
        return;
      case 'arcCEnd': {
        const [s] = r.points;
        if (s && r.base) drawArc(() => arcCenter(pt(r.base as Point), pt(s), pt(p), null));
        return;
      }
      case 'arcEEnd':
        go(r, 'arcEOpt', { base: p });
        return;
      case 'arcEOpt': {
        // A centre point: from start about it, counter-clockwise to the end's direction.
        const [s] = r.points;
        if (s && r.base) drawArc(() => arcCenter(pt(p), pt(s), pt(r.base as Point), null));
        return;
      }
      case 'arcERadius': {
        const [s] = r.points;
        if (s && r.base) {
          const radius = distance(pt(r.base), pt(p));
          drawArc(() => arcStartEnd(pt(s), pt(r.base as Point), { radius }));
        }
        return;
      }
      case 'corner1':
        if (!needDrawLayer()) return;
        go(r, 'corner2', { base: p });
        setPointer(p);
        return;
      case 'corner2':
        if (!r.base) return;
        try {
          rectangle(
            rect.rotation
              ? rotatedRectangle(pt(r.base), pt(p), rect.rotation)
              : rectanglePoints(pt(r.base), pt(p)),
          );
        } catch (caught) {
          geometryMessage(caught);
        }
        return;
      case 'rectSide':
        if (!r.base) return;
        try {
          rectangle(rectangleFrom(pt(r.base), rect.length, rect.width, rect.rotation, pt(p)));
        } catch (caught) {
          geometryMessage(caught);
        }
        return;
      case 'rectRotation':
        if (r.base) {
          setRect((previous) => ({ ...previous, rotation: directionOf(r.base as Point, p) }));
          go(r, 'corner2');
        }
        return;
      case 'pointAt':
        if (!needDrawLayer()) return;
        add([{ kind: 'add_item', layer: drawLayer, x: roundCoord(p.x), y: roundCoord(p.y) }]);
        if (!f.repeat) finish();
        return;
      case 'offsetSide':
        offsetTo(r, p);
        return;
      case 'textStart':
        if (!needDrawLayer()) return;
        go(r, 'textHeight', { textAt: p });
        return;
      case 'textHeight':
        if (r.textAt) feedHeight(r, distance(pt(r.textAt), pt(p)));
        return;
      case 'dim1':
        go(r, 'dim2', { points: [p] });
        setPointer(p);
        return;
      case 'dim2':
        go(r, 'dim3', { points: [...r.points, p] });
        return;
      case 'dim3':
        dimension(r, p);
        return;
      case 'leaderStart':
        go(r, 'leaderNext', { points: [p] });
        setPointer(p);
        return;
      case 'leaderNext':
        go(r, 'leaderNext', { points: [...r.points, p] });
        return;
      default:
        return;
    }
  };

  const drawArc = (make: () => Pt[]) => {
    try {
      add([arcCurveEdit(drawLayer, make())]);
      finish();
    } catch (caught) {
      geometryMessage(caught);
    }
  };

  /** DIMLINEAR at the dimension line location, with Text / Horizontal / Vertical if chosen. */
  const dimension = (r: Run, at: Point) => {
    const [a, b] = r.points;
    if (!a || !b) return;
    let place = at;
    // Horizontal / Vertical: the line is put where it measures that way (above / beside).
    if (r.flags.dimDirection === 'h') {
      const top = Math.max(a.y, b.y);
      const bottom = Math.min(a.y, b.y);
      const y = at.y > bottom && at.y < top ? top + Math.max(1e-3, (top - bottom) * 0.1) : at.y;
      place = { x: (a.x + b.x) / 2, y };
    } else if (r.flags.dimDirection === 'v') {
      const right = Math.max(a.x, b.x);
      const left = Math.min(a.x, b.x);
      const x = at.x > left && at.x < right ? right + Math.max(1e-3, (right - left) * 0.1) : at.x;
      place = { x, y: (a.y + b.y) / 2 };
    }
    const dim = linearDimension(pt(a), pt(b), pt(place));
    add([
      {
        kind: 'add_note',
        note: 'dimension',
        layer: current || '0',
        points: [a, b, place].map((q) => [roundCoord(q.x), roundCoord(q.y)] as [number, number]),
        text: r.flags.dimText ?? null,
      },
    ]);
    say(msg('dimText', { value: r.flags.dimText ?? acadNumber(dim.value) }));
    finish();
  };

  const circle = (center: Point, radius: number) => {
    try {
      add([circleCurveEdit(drawLayer, pt(center), radius, circlePoints(pt(center), radius))]);
      setLastRadius(radius);
      finish();
    } catch (caught) {
      geometryMessage(caught);
    }
  };

  const feedHeight = (r: Run, typed: number | null) => {
    if (typed !== null && !(typed > 0)) {
      say(msg('badValue'));
      return;
    }
    // Enter keeps the last height (TEXTSIZE); a new one is kept for the next TEXT.
    const height = typed ?? lastTextHeight;
    if (typed !== null) setLastTextHeight(typed);
    go(r, 'textValue', { height });
    setFocusNonce((n) => n + 1);
  };

  const stretch = (r: Run, dx: number, dy: number) => {
    if (!scene || !shown || !r.window) return;
    const out: CanvasEdit[] = [];
    const done = new Set<string>();
    for (const index of selection) {
      const handle = scene.view.entities[index]?.handle;
      if (!handle || done.has(handle)) continue;
      done.add(handle);
      const geom = curveGeom(index);
      if (geom) {
        const moved = stretchCurve(geom.points, r.window, dx, dy);
        if (moved) out.push(setCurveEdit(handle, moved, geom.closed));
        continue;
      }
      // Blocks and texts move when their point is inside the window (AutoCAD).
      const box = boxOf(scene, index);
      const entity = scene.view.entities[index];
      const firstText = entity?.texts[0];
      const at: Point = firstText
        ? { x: firstText.x, y: firstText.y }
        : { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
      const moved = shown.transformOf.get(index);
      const now = moved ? applyAffine(moved, at.x, at.y) : at;
      if (inBox(r.window, pt(now))) out.push(...moveEdits([handle], dx, dy));
    }
    if (out.length > 0) add(out);
    finish();
  };

  const offsetTo = (r: Run, side: Point) => {
    if (r.target === null || !scene) return;
    const geom = curveGeom(r.target);
    const handle = scene.view.entities[r.target]?.handle;
    if (!geom || !handle) return;
    const layer = offsetOnCurrent && drawLayer ? drawLayer : layerNameOf(r.target);
    try {
      const dist = offsetThrough ? throughDistance(geom.points, geom.closed, pt(side)) : offsetDist;
      // Multiple: each new offset goes on from the last one (AutoCAD).
      const steps = (r.flags.multipleCount ?? 0) + 1;
      const points = offsetCurve(geom.points, geom.closed, dist * steps, pt(side));
      const out: CanvasEdit[] = [pointsCurveEdit(layer, points, geom.closed)];
      if (offsetErase && !r.flags.multiple) out.push({ kind: 'erase_item', handle });
      const made = add(out);
      if (r.flags.multiple) {
        flag({ ...r, made: [...r.made, made.length] }, { multipleCount: steps });
      } else {
        go(r, 'offsetPick', { target: null, made: [...r.made, made.length] });
        setSelection(NONE);
      }
    } catch (caught) {
      geometryMessage(caught);
    }
  };

  /** An object clicked for the step (`shift`: Shift held, as AutoCAD's shift-select). */
  const feedObject = (r: Run, index: number | null, at: Point, shift = false) => {
    const ctx = extraFor(r);
    if (ctx) {
      extraObject(ctx, r, index, at);
      return;
    }
    if (!scene) return;
    if (index === null || !pickable(index)) {
      if (r.step === 'trimPick' || r.step === 'dest' || r.step === 'trimErase') return;
      say(msg('nothingThere'));
      return;
    }
    const handle = scene.view.entities[index]?.handle ?? '';
    switch (r.step) {
      case 'trimPick': {
        const geom = curveGeom(index);
        if (!geom) {
          say(msg('notCurve'));
          return;
        }
        const edgeList = r.flags.edges
          ? r.flags.edges.flatMap((i) => {
              const g = curveGeom(i);
              return g && i !== index ? [g] : [];
            })
          : edgesNear(boxAround(geom.points), index);
        try {
          const out: CanvasEdit[] = [];
          if (shift) {
            // Shift-select extends the picked end to the nearest edge (AutoCAD).
            if (geom.closed) {
              say(msg('notCurve'));
              return;
            }
            out.push(setCurveEdit(handle, extendCurve(geom.points, edgeList, pt(at)), false));
          } else {
            const pieces = trimCurve(geom.points, geom.closed, edgeList, pt(at));
            const [first, second] = pieces;
            if (!first) out.push({ kind: 'erase_item', handle });
            else out.push(setCurveEdit(handle, first, false));
            if (second) out.push(pointsCurveEdit(layerNameOf(index), second, false));
          }
          const made = add(out);
          go(r, 'trimPick', { made: [...r.made, made.length] });
        } catch (caught) {
          geometryMessage(caught);
        }
        return;
      }
      case 'trimEdges':
        flag(r, { edges: [...(r.flags.edges ?? []), index] });
        setSelection((previous) => new Set(previous).add(index));
        say(msg('found', { count: 1 }));
        return;
      case 'trimErase': {
        const made = add([{ kind: 'erase_item', handle }]);
        go(r, 'trimErase', { made: [...r.made, made.length] });
        return;
      }
      case 'filletFirst':
        if (!curveGeom(index)) {
          say(msg('notCurve'));
          return;
        }
        go(r, 'filletSecond', { target: index, targetAt: at });
        setSelection(new Set([index]));
        return;
      case 'filletSecond': {
        if (r.target === null || !r.targetAt) return;
        const a = curveGeom(r.target);
        const b = curveGeom(index);
        const first = scene.view.entities[r.target]?.handle;
        if (!a || !b || !first) {
          say(msg('notCurve'));
          return;
        }
        if (index === r.target || first === handle) {
          say(msg('sameObject'));
          return;
        }
        try {
          // Shift-select: a sharp corner (radius 0) whatever the radius set.
          const radius = shift ? 0 : filletRadius;
          const [p, q, arc] = fillet(
            { points: a.points, closed: a.closed, pick: pt(r.targetAt) },
            { points: b.points, closed: b.closed, pick: pt(at) },
            radius,
          );
          if (!filletTrim) {
            // No trim: the lines stay as they are and only the arc is drawn.
            if (arc.length >= 2) add([pointsCurveEdit(layerNameOf(r.target), arc, false)]);
          } else {
            add([setCurveEdit(first, p, false), setCurveEdit(handle, q, false)]);
          }
          if (r.flags.multiple) {
            go(r, 'filletFirst', { target: null, targetAt: null });
            setSelection(NONE);
          } else finish();
        } catch (caught) {
          geometryMessage(caught);
        }
        return;
      }
      case 'filletPoly': {
        const geom = curveGeom(index);
        if (!geom || scene.view.entities[index]?.kind === 'LINE') {
          say(msg('notPolyline'));
          return;
        }
        try {
          const done = filletPolyline(geom.points, geom.closed, filletRadius);
          if (done.filleted > 0) add([setCurveEdit(handle, done.points, geom.closed)]);
          say(msg('polyFilleted', { count: done.filleted }));
          if (done.tooShort > 0) say(msg('tooShort', { count: done.tooShort }));
          finish();
        } catch (caught) {
          geometryMessage(caught);
        }
        return;
      }
      case 'ttr1':
      case 'ttr2': {
        const geom = curveGeom(index);
        if (!geom) {
          say(msg('notCurve'));
          return;
        }
        const near = nearestOnCurve(geom.points, geom.closed, pt(at));
        const loop = geom.closed ? [...geom.points, geom.points[0] as Pt] : geom.points;
        const seg = [loop[near.segment] as Pt, loop[near.segment + 1] as Pt] as const;
        const tangents = [...(r.flags.tangents ?? []), { seg, at: pt(at) }];
        if (r.step === 'ttr1') flag(r, { tangents }, 'ttr2');
        else flag(r, { tangents }, 'ttrRadius');
        return;
      }
      case 'dimSelect': {
        const geom = curveGeom(index);
        if (!geom) {
          say(msg('notCurve'));
          return;
        }
        const near = nearestOnCurve(geom.points, geom.closed, pt(at));
        const loop = geom.closed ? [...geom.points, geom.points[0] as Pt] : geom.points;
        go(r, 'dim3', { points: [xy(loop[near.segment] as Pt), xy(loop[near.segment + 1] as Pt)] });
        return;
      }
      case 'offsetPick':
        if (!curveGeom(index)) {
          say(msg('notCurve'));
          return;
        }
        setRun({
          ...r,
          step: 'offsetSide',
          target: index,
          flags: { ...r.flags, multiple: false, multipleCount: 0 },
        });
        setSelection(new Set([index]));
        return;
      case 'editPick':
        if (!isTextEntity(scene, index)) {
          say(msg('notText'));
          return;
        }
        editText(index, r);
        return;
      case 'source':
        go(r, 'dest', { target: index });
        say(msg('matchSettings'));
        return;
      case 'dest': {
        if (r.target === null) return;
        const style = shown?.styleOf.get(r.target) ?? {
          color: null,
          linetype: null,
          lineweight: null,
        };
        add([{ kind: 'set_style', handle, ...style }]);
        return;
      }
      case 'laymcurPick': {
        const layer = layerNameOf(index);
        setCurrentLayer(layer);
        say(msg('currentNow', { layer }));
        finish(true);
        return;
      }
      case 'laymchDest':
        toLayer(layerNameOf(index));
        return;
      default:
        return;
    }
  };

  /** LAYMCH: the picked objects go to that layer (it needs a rule: owner 2026-11-09). */
  const toLayer = (layer: string) => {
    if (!allLayers.includes(layer)) {
      say(msg('noSuchLayer', { layer }));
      return;
    }
    if (!layers.includes(layer)) {
      say(msg('layerNoRule', { layer }));
      return;
    }
    add(handles.map((h) => ({ kind: 'move_layer', handle: h, toLayer: layer }) as CanvasEdit));
    say(msg('changedToLayer', { count: handles.length, layer }));
    finish();
  };

  /** Enter (or Space, or an empty right answer) for the step: AutoCAD's default in <…>. */
  const feedEnter = (r: Run) => {
    const ctx = extraFor(r);
    if (ctx) {
      extraEnter(ctx, r);
      return;
    }
    const f = r.flags;
    switch (r.step) {
      case 'select':
        if (f.removing) {
          flag(r, { removing: false });
          afterSelect(r);
          return;
        }
        afterSelect(r);
        return;
      case 'base':
        if (r.cmd === 'move' || r.cmd === 'copy' || r.cmd === 'stretch') go(r, 'displacement');
        return;
      case 'displacement':
        finish();
        return;
      case 'copyMode':
        go(r, 'base');
        return;
      case 'second':
        if (r.cmd === 'copy' && r.made.length > 0) finish();
        // <use first point as displacement>
        else if (r.base) moveBy(r, r.base.x, r.base.y);
        return;
      case 'angle':
        rotateBy(r, lastAngle);
        return;
      case 'factor':
        feedFactor(r, lastFactor);
        return;
      case 'refAngle':
        flag(r, { refAngle: 0 }, 'newAngle');
        return;
      case 'newAngle':
        rotateBy(r, -(f.refAngle ?? 0));
        return;
      case 'refLength':
        flag(r, { refLength: 1 }, 'newLength');
        return;
      case 'newLength':
        feedFactor(r, 1 / (f.refLength ?? 1));
        return;
      case 'mirrorErase':
        mirror(r, false);
        return;
      case 'next':
        if (r.cmd === 'pline' && r.points.length >= 2) {
          add([curveEdit(drawLayer, r.points, false)]);
        }
        finish();
        return;
      case 'radius':
      case 'diameter':
        if (lastRadius && r.base) circle(r.base, lastRadius);
        return;
      case 'ttrRadius':
        if (lastRadius) feedNumber(r, lastRadius);
        return;
      case 'first':
        // LINE: Enter goes on from the end of the last line (AutoCAD).
        if (r.cmd === 'line') {
          if (lineEnd) feedPoint(r, lineEnd);
          else say(msg('noLineToContinue'));
          return;
        }
        finish();
        return;
      case 'copyArrayCount':
        return;
      case 'filletRadius':
        go(r, 'filletFirst');
        return;
      case 'filletTrim':
        go(r, 'filletFirst');
        return;
      case 'offsetDistance':
        go(r, 'offsetPick');
        return;
      case 'offsetErase':
      case 'offsetLayer':
        go(r, 'offsetDistance');
        return;
      case 'offsetSide':
        if (f.multiple) go(r, 'offsetPick', { target: null });
        else finish();
        return;
      case 'trimEdges':
        // <select all>: no edge picked means every object is an edge, as before.
        go(r, 'trimPick');
        setSelection(NONE);
        return;
      case 'trimErase':
        go(r, 'trimPick');
        return;
      case 'textHeight':
        feedHeight(r, null);
        return;
      case 'dim1':
        go(r, 'dimSelect');
        return;
      case 'chamfer1':
        feedNumber(r, rect.chamfer?.[0] ?? 0);
        return;
      case 'chamfer2':
        feedNumber(r, f.chamfer1 ?? 0);
        return;
      case 'rectFillet':
        feedNumber(r, rect.fillet ?? 0);
        return;
      case 'rectLength':
        feedNumber(r, rect.length);
        return;
      case 'rectWidth':
        feedNumber(r, rect.width);
        return;
      case 'rectRotation':
        feedNumber(r, rect.rotation);
        return;
      case 'rectArea':
        feedNumber(r, rect.area);
        return;
      case 'rectAreaBy':
        go(r, 'rectAreaLength');
        return;
      case 'rectAreaLength':
        feedNumber(r, rect.length);
        return;
      case 'rectAreaWidth':
        feedNumber(r, rect.width);
        return;
      case 'leaderNext':
        if (r.points.length >= 2) {
          go(r, 'leaderText');
          setFocusNonce((n) => n + 1);
        } else finish();
        return;
      default:
        finish();
    }
  };

  /** MIRROR after «Erase source objects?»: No keeps a copy where the objects were. */
  const mirror = (r: Run, eraseSource: boolean) => {
    const [a, b] = r.points;
    if (!a || !b) return;
    add([...keepCopy(!eraseSource), ...mirrorEdits(handles, a, b)]);
    finish();
  };

  const feedOption = (r: Run, key: string) => {
    if (r.step === 'select' && isTextCommand(r.cmd)) {
      const words = extraCtx();
      if (words) textSelectOption(words, r, key);
      return;
    }
    const ctx = extraFor(r);
    if (ctx) {
      extraOption(ctx, r, key);
      return;
    }
    if (r.step === 'pointAt' && key === 'M') {
      // «Multiple Points» of the ribbon: points one after another until Esc.
      flag(r, { repeat: true });
      return;
    }
    const f = r.flags;
    switch (r.step) {
      case 'base':
        if (key === 'D') go(r, 'displacement');
        else if (key === 'O') go(r, 'copyMode');
        return;
      case 'copyMode':
        setCopyMultiple(key === 'M');
        go(r, 'base');
        return;
      case 'second':
        if (key === 'E') finish();
        else if (key === 'U') undoMade(r);
        else if (key === 'A') flag(r, { arrayFit: false }, 'copyArrayCount');
        return;
      case 'copyArraySecond':
        flag(r, { arrayFit: key === 'F' });
        return;
      case 'angle':
        if (key === 'C') {
          say(msg('rotateCopy'));
          flag(r, { copy: true });
        } else if (key === 'R') go(r, 'refAngle');
        return;
      case 'newAngle':
        go(r, 'newAngleP1');
        return;
      case 'factor':
        if (key === 'C') {
          say(msg('scaleCopy'));
          flag(r, { copy: true });
        } else if (key === 'R') go(r, 'refLength');
        return;
      case 'newLength':
        go(r, 'newLengthP1');
        return;
      case 'mirrorErase':
        mirror(r, key === 'Y');
        return;
      case 'next':
        if (key === 'U') {
          undoPoint(r);
          return;
        }
        if (r.cmd === 'line' && key === 'C') {
          const first = r.points[0];
          const last = r.points[r.points.length - 1];
          if (first && last) add([curveEdit(drawLayer, [last, first], false)]);
          if (first) setLineEnd(first);
          finish();
          return;
        }
        if (key === 'C' || key === 'CL') {
          if (f.arcMode) {
            const first = r.points[0];
            const last = r.points[r.points.length - 1];
            if (first && last) {
              const arc = tangentArc(
                pt(last),
                f.direction ?? endDirection(r.points.map(pt)),
                pt(first),
              );
              add([curveEdit(drawLayer, [...r.points, ...arc.slice(0, -1).map(xy)], true)]);
            }
          } else add([curveEdit(drawLayer, r.points, true)]);
          finish();
          return;
        }
        if (key === 'A') flag(r, { arcMode: true });
        else if (key === 'L' && f.arcMode) flag(r, { arcMode: false });
        else if (key === 'L') go(r, 'plineLength');
        else if (key === 'S') go(r, 'plineArc2');
        return;
      case 'center':
        if (key === '3P') go(r, 'c3p1');
        else if (key === '2P') go(r, 'c2p1');
        else if (key === 'T') {
          if (needDrawLayer()) flag(r, { tangents: [] }, 'ttr1');
        }
        return;
      case 'radius':
        go(r, 'diameter');
        return;
      case 'arc1':
        if (needDrawLayer()) go(r, 'arcCenter');
        return;
      case 'arc2':
        go(r, key === 'C' ? 'arcCenter' : 'arcEEnd');
        return;
      case 'arcCEnd':
        go(r, 'arcCAngle');
        return;
      case 'arcEOpt':
        go(r, key === 'A' ? 'arcEAngle' : 'arcERadius');
        return;
      case 'corner1':
        go(r, key === 'C' ? 'chamfer1' : 'rectFillet');
        return;
      case 'corner2':
        go(r, key === 'A' ? 'rectArea' : key === 'D' ? 'rectLength' : 'rectRotation');
        return;
      case 'rectAreaBy':
        go(r, key === 'W' ? 'rectAreaWidth' : 'rectAreaLength');
        return;
      case 'trimPick':
        if (key === 'T') {
          say(msg('trimEdgesSettings'));
          flag(r, { edges: [] }, 'trimEdges');
        } else if (key === 'R') go(r, 'trimErase');
        else if (key === 'U') undoMade(r);
        return;
      case 'filletFirst':
        if (key === 'U') undoMade(r);
        else if (key === 'P') go(r, 'filletPoly');
        else if (key === 'R') go(r, 'filletRadius');
        else if (key === 'T') go(r, 'filletTrim');
        else if (key === 'M') flag(r, { multiple: true });
        return;
      case 'filletSecond':
        go(r, 'filletRadius');
        return;
      case 'filletTrim':
        setFilletTrim(key === 'T');
        go(r, 'filletFirst');
        return;
      case 'offsetDistance':
        if (key === 'T') {
          setOffsetThrough(true);
          go(r, 'offsetPick');
        } else go(r, key === 'E' ? 'offsetErase' : 'offsetLayer');
        return;
      case 'offsetErase':
        setOffsetErase(key === 'Y');
        go(r, 'offsetDistance');
        return;
      case 'offsetLayer':
        setOffsetOnCurrent(key === 'C');
        go(r, 'offsetDistance');
        return;
      case 'offsetPick':
        if (key === 'E') finish();
        else undoMade(r);
        return;
      case 'offsetSide':
        if (key === 'E') finish();
        else if (key === 'M') flag(r, { multiple: true, multipleCount: 0 });
        else undoMade(r);
        return;
      case 'editPick':
        undoMade(r);
        return;
      case 'dim3':
        if (key === 'T' || key === 'M') {
          go(r, 'dimTextValue');
          setFocusNonce((n) => n + 1);
        } else flag(r, { dimDirection: key === 'H' ? 'h' : 'v' });
        return;
      case 'leaderNext':
        if (key === 'A') feedEnter(r);
        else undoPoint(r);
        return;
      case 'laymchDest':
        go(r, 'laymchName');
        setFocusNonce((n) => n + 1);
        return;
      default:
        return;
    }
  };

  const undoMade = (r: Run) => {
    if (r.made.length > 0) {
      dropEdits(r.made[r.made.length - 1] ?? 0);
      go(r, r.step, { made: r.made.slice(0, -1) });
    } else say(msg('nothingToUndo'));
  };

  /** Undo of LINE, PLINE and LEADER: the last segment (a PLINE arc goes as one). */
  const undoPoint = (r: Run) => {
    if (r.points.length <= 1) {
      say(msg(r.cmd === 'line' || r.cmd === 'pline' ? 'allUndone' : 'nothingToUndo'));
      return;
    }
    if (r.cmd === 'line') {
      dropEdits(1);
      const kept = r.points.slice(0, -1);
      setLineEnd(kept.length > 1 ? (kept[kept.length - 1] ?? null) : lineEnd);
      go(r, r.step, { points: kept, made: r.made.slice(0, -1) });
      return;
    }
    if (r.cmd === 'pline') {
      const segments = r.flags.segments ?? [];
      const keep = segments[segments.length - 1] ?? r.points.length - 1;
      setRun({
        ...r,
        points: r.points.slice(0, keep),
        flags: { ...r.flags, segments: segments.slice(0, -1), direction: undefined },
      });
      return;
    }
    go(r, r.step, { points: r.points.slice(0, -1) });
  };

  /** Drops the last `count` edits (a command's Undo). */
  const dropEdits = (count: number) => {
    if (count > 0) setEdits((previous) => previous.slice(0, Math.max(0, previous.length - count)));
  };

  const feedNumber = (r: Run, value: number) => {
    const ctx = extraFor(r);
    if (ctx) {
      extraNumber(ctx, r, value);
      return;
    }
    const last = r.points[r.points.length - 1] ?? r.base;
    const f = r.flags;
    const positive = (then: () => void, allowZero = false) => {
      if (value > 0 || (allowZero && value === 0)) then();
      else say(msg('badValue'));
    };
    switch (r.step) {
      case 'copyArrayCount':
        // The number of items, the original being the first (AutoCAD COPY Array).
        if (Number.isInteger(value) && value >= 2 && value <= 32767) {
          flag(r, { arrayCount: value }, 'copyArraySecond');
        } else say(msg('copyArrayRange'));
        return;
      case 'angle':
        rotateBy(r, value);
        return;
      case 'refAngle':
        flag(r, { refAngle: value }, 'newAngle');
        return;
      case 'newAngle':
        rotateBy(r, value - (f.refAngle ?? 0));
        return;
      case 'factor':
        feedFactor(r, value);
        return;
      case 'refLength':
        positive(() => flag(r, { refLength: value }, 'newLength'));
        return;
      case 'newLength':
        positive(() => feedFactor(r, value / (f.refLength ?? 1)));
        return;
      case 'radius':
      case 'diameter':
        positive(() => r.base && circle(r.base, r.step === 'diameter' ? value / 2 : value));
        return;
      case 'ttrRadius': {
        const [ta, tb] = f.tangents ?? [];
        if (!ta || !tb) return;
        positive(() => {
          try {
            circle(xy(circleTangentTangent(ta.seg, ta.at, tb.seg, tb.at, value)), value);
          } catch (caught) {
            geometryMessage(caught);
          }
        });
        return;
      }
      case 'plineLength': {
        const end = r.points[r.points.length - 1];
        if (!end) return;
        positive(() => {
          const dir = f.direction ?? endDirection(r.points.map(pt));
          const p = { x: end.x + dir[0] * value, y: end.y + dir[1] * value };
          setRun({
            ...r,
            step: 'next',
            points: [...r.points, p],
            flags: { ...f, segments: [...(f.segments ?? []), r.points.length] },
          });
        });
        return;
      }
      case 'arcCAngle': {
        const [s] = r.points;
        if (s && r.base) drawArc(() => arcCenter(pt(r.base as Point), pt(s), null, value));
        return;
      }
      case 'arcEAngle': {
        const [s] = r.points;
        if (s && r.base) drawArc(() => arcStartEnd(pt(s), pt(r.base as Point), { angle: value }));
        return;
      }
      case 'arcERadius': {
        const [s] = r.points;
        if (s && r.base) drawArc(() => arcStartEnd(pt(s), pt(r.base as Point), { radius: value }));
        return;
      }
      case 'filletRadius':
        positive(() => {
          setFilletRadius(value);
          go(r, 'filletFirst');
        }, true);
        return;
      case 'offsetDistance':
        positive(() => {
          setOffsetDist(value);
          setOffsetThrough(false);
          go(r, 'offsetPick');
        });
        return;
      case 'textHeight':
        feedHeight(r, value);
        return;
      case 'chamfer1':
        positive(() => flag(r, { chamfer1: value }, 'chamfer2'), true);
        return;
      case 'chamfer2':
        positive(() => {
          const first = f.chamfer1 ?? 0;
          setRect((previous) => ({
            ...previous,
            chamfer: first > 0 || value > 0 ? [first, value] : null,
            fillet: null,
          }));
          say(msg('rectChamferMode', { first: acadNumber(first), second: acadNumber(value) }));
          go(r, 'corner1');
        }, true);
        return;
      case 'rectFillet':
        positive(() => {
          setRect((previous) => ({ ...previous, fillet: value > 0 ? value : null, chamfer: null }));
          say(msg('rectFilletMode', { radius: acadNumber(value) }));
          go(r, 'corner1');
        }, true);
        return;
      case 'rectLength':
        positive(() => {
          setRect((previous) => ({ ...previous, length: value }));
          go(r, 'rectWidth');
        });
        return;
      case 'rectWidth':
        positive(() => {
          setRect((previous) => ({ ...previous, width: value }));
          go(r, 'rectSide');
        });
        return;
      case 'rectRotation':
        setRect((previous) => ({ ...previous, rotation: value }));
        go(r, 'corner2');
        return;
      case 'rectArea':
        positive(() => {
          setRect((previous) => ({ ...previous, area: value }));
          go(r, 'rectAreaBy');
        });
        return;
      case 'rectAreaLength':
      case 'rectAreaWidth':
        positive(() => {
          if (!r.base) return;
          const lengthSide = r.step === 'rectAreaLength';
          const length = lengthSide ? value : rect.area / value;
          const width = lengthSide ? rect.area / value : value;
          setRect((previous) => ({ ...previous, length, width }));
          try {
            rectangle(rectangleFrom(pt(r.base), length, width, rect.rotation, null));
          } catch (caught) {
            geometryMessage(caught);
          }
        });
        return;
      default:
        // AutoCAD's direct distance entry: that far toward the pointer from the last point.
        if (last && isTracked(r.step)) feedPoint(r, towards(last, pointerStore.get(), value));
        else say(msg('badPoint'));
    }
  };

  /** Free text for the step. */
  const feedText = (r: Run, value: string) => {
    const trimmed = value.trim();
    if (r.step === 'textValue') {
      if (!trimmed || !r.textAt || !drawLayer) {
        finish();
        return;
      }
      add([
        {
          kind: 'add_text',
          layer: drawLayer,
          x: roundCoord(r.textAt.x),
          y: roundCoord(r.textAt.y),
          text: trimmed,
          height: r.height,
        },
      ]);
      // TEXT goes on with the next line under this one; an empty line ends it (AutoCAD).
      const below = textLineBelow(r.textAt, r.height ?? textHeight);
      go(r, 'textValue', { textAt: below });
      setFocusNonce((n) => n + 1);
      return;
    }
    if (r.step === 'editValue') {
      const handle = r.target !== null ? scene?.view.entities[r.target]?.handle : undefined;
      const made =
        trimmed && handle
          ? [...r.made, add([{ kind: 'set_text', handle, text: trimmed }]).length]
          : r.made;
      // Edit mode = Multiple: the next annotation object is asked for until Enter (AutoCAD).
      if (r.flags.repeat) {
        go(r, 'editPick', { target: null, made });
        setSelection(NONE);
      } else finish();
      return;
    }
    if (r.step === 'leaderText') {
      add([
        {
          kind: 'add_note',
          note: 'leader',
          layer: current || '0',
          points: r.points.map((q) => [roundCoord(q.x), roundCoord(q.y)] as [number, number]),
          text: trimmed || null,
        },
      ]);
      finish();
      return;
    }
    if (r.step === 'dimTextValue') {
      flag(r, { dimText: trimmed || null }, 'dim3');
      return;
    }
    if (r.step === 'laymchName') {
      if (trimmed) toLayer(trimmed);
      else finish();
    }
  };

  /** AutoCAD's selection words at «Select objects:»: ALL, Previous, Remove, Add. */
  const selectionWord = (r: Run, word: string): boolean => {
    if (!scene || !shown) return false;
    if (word === 'ALL') {
      const all = new Set<number>();
      scene.view.entities.forEach((_, index) => {
        if (pickable(index)) all.add(index);
      });
      setSelection(all);
      say(msg('found', { count: all.size }));
      return true;
    }
    if (word === 'P' || word === 'PREVIOUS') {
      setSelection(previous);
      say(msg('found', { count: previous.size }));
      return true;
    }
    if (word === 'R' || word === 'REMOVE') {
      flag(r, { removing: true });
      return true;
    }
    if (word === 'A' || word === 'ADD') {
      flag(r, { removing: false });
      return true;
    }
    return false;
  };

  const submit = () => {
    const typed = text;
    setText('');
    if (!editing) return;
    if (run && isTextStep(run.step)) {
      say(`${promptLine(run)} ${typed}`);
      const ctx = extraFor(run);
      if (ctx) extraText(ctx, run, typed);
      else feedText(run, typed);
      return;
    }
    const last = run ? (run.points[run.points.length - 1] ?? run.base) : null;
    const entry = parseEntry(typed, last);
    if (!run) {
      if (entry.kind === 'empty') {
        if (lastCmd) begin(lastCmd);
        return;
      }
      const id = entry.kind === 'word' ? lookupCommand(entry.word) : null;
      if (id) begin(id);
      else say(msg('unknownCommand', { name: typed.trim().toUpperCase() }));
      return;
    }
    say(`${promptLine(run)} ${typed}`);
    if (entry.kind === 'empty') feedEnter(run);
    else if (entry.kind === 'point') {
      if (isObjectStep(run.step) || run.step === 'select') say(msg('badSelection'));
      else feedPoint(run, entry.point);
    } else if (entry.kind === 'number') feedNumber(run, entry.value);
    else if (entry.kind === 'word') {
      const key = matchOption(promptOf(run).options, entry.word);
      if (key) feedOption(run, key);
      else if (!(run.step === 'select' && selectionWord(run, entry.word))) say(msg('badKeyword'));
    } else say(msg('badPoint'));
  };

  const cancelRun = () => {
    if (run) say(msg('cancel'));
    // Esc in a table's cells keeps the table (AutoCAD's cell editor).
    const kept = run ? textKeepOnCancel(run) : [];
    if (kept.length > 0) add(kept);
    finish();
  };

  const undo = () => {
    if (run && (run.step === 'next' || run.step === 'leaderNext') && run.points.length > 1) {
      undoPoint(run);
      return;
    }
    const label = undoHistory.undo(historyParts());
    if (label !== null) say(label);
    else say(msg('nothingToUndo'));
  };

  const redo = () => {
    const label = undoHistory.redo(historyParts());
    if (label !== null) say(label);
    setError(null);
  };

  /** What the history reads and puts back: the edits (and the current layer), the screen. */
  const historyParts = (): Record<string, HistoryPart> => {
    const parts: Record<string, HistoryPart> = {
      edits: {
        capture: () => ({ edits, currentLayer }),
        apply: (state) => {
          const s = state as { edits: readonly CanvasEdit[]; currentLayer: string };
          setEdits(s.edits);
          setCurrentLayer(s.currentLayer);
        },
      },
    };
    if (input.screen) parts.screen = input.screen;
    return parts;
  };

  // ---------- what is drawn while a command runs ----------

  /** What the running command draws for the pointer where it is: the ghost and the rubber band. */
  const liveDraw = (pointer: Point | null): LiveDraw => {
    let ghost: CanvasEditState['ghost'] = null;
    let sketch: CanvasEditState['sketch'] = null;
    if (run && pointer && isExtra(run.cmd)) {
      sketch = extraSketch(run, pointer, extraSettings);
    } else if (run && pointer) {
      const { base, step } = run;
      const at = pointer;
      let affine: Affine | null = null;
      if (base && step === 'second' && run.cmd !== 'stretch')
        affine = translation(at.x - base.x, at.y - base.y);
      else if (base && step === 'angle')
        affine = rotationAbout(base.x, base.y, directionOf(base, at));
      else if (base && step === 'factor') {
        const f = distance(pt(base), pt(at));
        if (f > 0) affine = scaleAbout(base.x, base.y, f);
      } else if (base && step === 'mirror2' && (at.x !== base.x || at.y !== base.y)) {
        affine = mirrorAcross(base.x, base.y, at.x, at.y);
        sketch = { points: [base, at], closed: false };
      }
      if (affine && selection.size > 0) ghost = { indexes: [...selection], step: affine };
      if (base && (step === 'second' || step === 'angle' || step === 'factor') && !sketch) {
        sketch = { points: [base, at], closed: false };
      }
      if (step === 'next' && run.cmd === 'pline' && run.flags.arcMode && run.points.length > 0) {
        // PLINE Arc: the tangent arc to the pointer.
        const lastPoint = run.points[run.points.length - 1] as Point;
        const dir = run.flags.direction ?? endDirection(run.points.map(pt));
        sketch = {
          points: [...run.points, ...tangentArc(pt(lastPoint), dir, pt(at)).map(xy)],
          closed: false,
        };
      } else if (step === 'next' || step === 'leaderNext' || step === 'dim2') {
        sketch = { points: [...run.points, at], closed: false };
      } else if (step === 'dim3' && run.points.length === 2) {
        sketch = { points: [...run.points, at], closed: false };
      } else if (base && (step === 'radius' || step === 'diameter')) {
        const radius = distance(pt(base), pt(at)) / (step === 'diameter' ? 2 : 1);
        if (radius > 0) sketch = { points: circlePoints(pt(base), radius).map(xy), closed: true };
      } else if (step === 'arc3' && run.points.length === 2) {
        try {
          const [a, b] = run.points as [Point, Point];
          sketch = { points: arcThrough(pt(a), pt(b), pt(at)).map(xy), closed: false };
        } catch {
          sketch = { points: [...run.points, at], closed: false };
        }
      } else if (step === 'arc2' || step === 'c3p3' || step === 'c2p2') {
        sketch = { points: [...run.points, at], closed: false };
      } else if (base && step === 'corner2' && at.x !== base.x && at.y !== base.y) {
        try {
          const corners = rect.rotation
            ? rotatedRectangle(pt(base), pt(at), rect.rotation)
            : rectanglePoints(pt(base), pt(at));
          sketch = { points: corners.map(xy), closed: true };
        } catch {
          sketch = null;
        }
      } else if (base && step === 'rectSide') {
        sketch = {
          points: rectangleFrom(pt(base), rect.length, rect.width, rect.rotation, pt(at)).map(xy),
          closed: true,
        };
      } else if (step === 'plineArc3' && run.base && run.points.length > 0) {
        try {
          const lastPoint = run.points[run.points.length - 1] as Point;
          sketch = {
            points: [
              ...run.points,
              ...arcThrough(pt(lastPoint), pt(run.base), pt(at)).slice(1).map(xy),
            ],
            closed: false,
          };
        } catch {
          sketch = null;
        }
      } else if (step === 'offsetSide' && run.target !== null) {
        const geom = curveGeom(run.target);
        if (geom) {
          try {
            sketch = {
              points: offsetCurve(geom.points, geom.closed, offsetDist, pt(at)).map(xy),
              closed: geom.closed,
            };
          } catch {
            sketch = null;
          }
        }
      }
    }

    if (gripRun && pointer && scene && shown && gripRun.step === 'stretch') {
      const g = gripRun.grip;
      const moving =
        g.kind === 'group' ||
        g.kind === 'insert' ||
        g.kind === 'center' ||
        (g.kind === 'mid' && scene.view.entities[g.index]?.kind === 'LINE');
      if (moving) {
        ghost = {
          indexes: g.handles.flatMap((h) => [...(scene.byHandle.get(h) ?? [])]),
          step: translation(pointer.x - gripRun.base.x, pointer.y - gripRun.base.y),
        };
      } else sketch = gripSketch(scene, shown, g, gripRun.base, pointer);
    }
    return { ghost, sketch };
  };
  const { ghost, sketch } = liveDraw(pointerStore.get());

  const selectStyle = (): PreviewStyle | null => {
    const [first] = [...selection];
    if (first === undefined) return null;
    return shown?.styleOf.get(first) ?? { color: null, linetype: null, lineweight: null };
  };

  const selecting = run === null || run.step === 'select';

  // ---------- grips (AutoCAD, owner 2026-11-26) ----------

  const gripsOn = run === null;
  const gripSet = useMemo(
    () =>
      scene && shown && editing && gripsOn
        ? gripsOf(scene, shown, selection, extraSettings.groupPick)
        : { grips: [], groupBoxes: [] },
    [scene, shown, editing, gripsOn, selection, extraSettings.groupPick],
  );
  const endGrip = (cancelled: boolean) => {
    if (cancelled) say(msg('cancel'));
    setGripRun(null);
    setPointer(null);
    setText('');
  };
  const gripPrompt = (g: GripRun): CommandPrompt =>
    g.step === 'base'
      ? { key: 'gripBase', options: [], fallback: null }
      : { key: 'gripStretch', options: GRIP_OPTIONS, fallback: null };
  const gripPoint = (g: GripRun, p: Point) => {
    if (!scene || !shown) return;
    if (g.step === 'base') {
      setGripRun({ ...g, base: p, step: 'stretch' });
      return;
    }
    const layer = g.grip.index >= 0 ? layerNameOf(g.grip.index) : '';
    const made = gripStretchEdits(scene, shown, g.grip, g.base, p, g.copy, layer);
    if (!made) {
      say(msg('gripNotHere'));
      endGrip(false);
      return;
    }
    add(made);
    if (!g.copy) {
      setGripRun(null);
      setPointer(null);
    }
  };
  const gripOption = (g: GripRun, key: string) => {
    if (key === 'B') setGripRun({ ...g, step: 'base' });
    else if (key === 'C') setGripRun({ ...g, copy: true });
    else if (key === 'U') undo();
    else if (key === 'X') endGrip(false);
  };
  const gripSubmit = (g: GripRun) => {
    const typed = text;
    setText('');
    say(`${formatPrompt(t, GRIP_NAME, gripPrompt(g))} ${typed}`.trim());
    const entry = parseEntry(typed, g.base);
    if (entry.kind === 'empty') endGrip(false);
    else if (entry.kind === 'point') gripPoint(g, entry.point);
    else if (entry.kind === 'word' && g.step === 'stretch') {
      const key = matchOption(GRIP_OPTIONS, entry.word);
      if (key) gripOption(g, key);
      else say(msg('badPoint'));
    } else say(msg('badPoint'));
  };
  const submitAll = () => (gripRun ? gripSubmit(gripRun) : submit());
  const state: CanvasEditState = {
    available,
    editing,
    start: () => {
      setEditing(true);
      setError(null);
      setFocusNonce((n) => n + 1);
    },
    command: run?.cmd ?? null,
    run: (id) => {
      if (!editing) return;
      if (run) {
        say(msg('cancel'));
        setRun(null);
      }
      begin(id);
    },
    groupPick: extraSettings.groupPick,
    setAttribute: (index, from, to) => {
      const handle = scene?.view.entities[index]?.handle;
      if (!handle || from === to || !to.trim()) return;
      add([{ kind: 'set_attribute', handle, from, to: to.trim() }]);
    },
    replaceText: (index, from, to) => {
      const handle = scene?.view.entities[index]?.handle;
      if (!scene || !handle || from === to || !to.trim()) return;
      if (isTextEntity(scene, index)) add([{ kind: 'set_text', handle, text: to.trim() }]);
      else if (scene.view.entities[index]?.kind === 'INSERT') {
        add([{ kind: 'set_attribute', handle, from, to: to.trim() }]);
      }
    },
    runWith: (id, key) => {
      if (!editing) return;
      if (run) setRun(null);
      const started = begin(id);
      if (!started) return;
      // Asked before the objects: kept until they are picked.
      if (started.step === 'select') {
        setRun({ ...started, flags: { ...started.flags, extra: { pending: key } } });
      } else feedOption(started, key);
    },
    placeTable: (spec) => {
      if (!editing) return;
      if (run) setRun(null);
      const ctx = extraCtx();
      if (!ctx) return;
      setLastCmd('table');
      setFocusNonce((n) => n + 1);
      tablePlace(ctx, spec, (step) => newRun('table', step as Step));
    },
    hatch:
      run && isHatchCommand(run.cmd)
        ? {
            settings: extraSettings.hatch,
            set: (patch) =>
              setExtraSettings((previous) => ({
                ...previous,
                hatch: { ...previous.hatch, ...patch },
              })),
            loops: hatchLoopCount(run),
            close: () => {
              const ctx = extraCtx();
              if (ctx) {
                say(`${promptLine(run)} `);
                extraEnter(ctx, run);
              }
            },
          }
        : null,
    prompt: gripRun ? gripPrompt(gripRun) : promptOf(run),
    history,
    input: text,
    setInput: setText,
    submit: submitAll,
    chooseOption: (key) => {
      if (gripRun) {
        say(`${formatPrompt(t, GRIP_NAME, gripPrompt(gripRun))} ${key}`);
        gripOption(gripRun, key);
        return;
      }
      if (!run) return;
      say(`${promptLine(run)} ${key}`);
      feedOption(run, key);
    },
    textEntry: run !== null && isTextStep(run.step),
    focusNonce,
    key: (k, ctrl) => {
      if (!editing) return false;
      if (ctrl && k.toLowerCase() === 'z') {
        undo();
        return true;
      }
      if (ctrl && k.toLowerCase() === 'y') {
        redo();
        return true;
      }
      if (k === 'Escape' && gripRun) {
        endGrip(true);
        return true;
      }
      if (k === 'Escape') {
        if (run) cancelRun();
        else {
          setSelection(NONE);
          setText('');
        }
        return true;
      }
      if (k === 'Enter' || (k === ' ' && !(run && isTextStep(run.step)))) {
        submitAll();
        return true;
      }
      if (k === 'Delete' && !run && handles.length > 0) {
        add(eraseEdits(handles));
        setSelection(NONE);
        return true;
      }
      if (k === 'Backspace') {
        setText((previous) => previous.slice(0, -1));
        return true;
      }
      if (k.length === 1 && !ctrl) {
        // AutoCAD: typing anywhere goes to the command line.
        setText((previous) => previous + k);
        setFocusNonce((n) => n + 1);
        return true;
      }
      return false;
    },
    scene,
    chosen: selection,
    chosenCount: handles.length,
    clearChosen: () => setSelection(NONE),
    selectAll: () => {
      if (!editing || !scene || run) return;
      const all = new Set<number>();
      scene.view.entities.forEach((_, index) => {
        if (pickable(index)) all.add(index);
      });
      setSelection(all);
      say(msg('found', { count: all.size }));
    },
    clipboardCount: clipboard?.handles.length ?? 0,
    selectSimilar: () => {
      if (!scene || !shown || selection.size === 0) return;
      const like = new Set<string>();
      for (const index of selection) {
        like.add(`${scene.view.entities[index]?.kind}|${effectiveLayer(scene, shown, index)}`);
      }
      const all = new Set<number>();
      scene.view.entities.forEach((entity, index) => {
        if (pickable(index) && like.has(`${entity.kind}|${effectiveLayer(scene, shown, index)}`))
          all.add(index);
      });
      setSelection(all);
      say(msg('found', { count: all.size }));
    },
    addSelectedCommand: addLike,
    addSelected: () => {
      if (!editing || addLike === null || run) return;
      const [index] = selection;
      if (index === undefined) return;
      const layer = layerNameOf(index);
      setSelection(NONE);
      if (layer) {
        setCurrentLayer(layer);
        say(msg('currentNow', { layer }));
      }
      begin(addLike);
    },
    pick: (entity, at, additive) => {
      if (!editing || !scene) return;
      setError(null);
      if (gripRun) {
        gripPoint(gripRun, at);
        return;
      }
      if (run && isObjectStep(run.step)) {
        feedObject(run, entity, at, additive);
        return;
      }
      if (run && run.step !== 'select') {
        feedPoint(run, at);
        return;
      }
      if (entity === null || !pickable(entity)) {
        if (entity !== null && isLocked(entity)) say(msg('locked', { count: 1 }));
        return;
      }
      // AutoCAD: a click adds to the selection; Shift + click (or Remove mode) takes it off.
      const removing = run?.flags.removing === true;
      // PICKSTYLE on: one member of a group picks the whole group (AutoCAD).
      const members = groupMembers(entity);
      setSelection((before) => {
        const next = new Set(before);
        if ((additive || removing) && before.has(entity)) members.forEach((i) => next.delete(i));
        else if (!removing) members.forEach((i) => next.add(i));
        return next;
      });
      if (run) say(msg('found', { count: 1 }));
    },
    grips: gripSet.grips,
    groupBoxes: gripSet.groupBoxes,
    hotGrip: gripRun?.grip ?? null,
    startGrip: (grip) => {
      if (!editing || run) return;
      if (!grip.editable) {
        say(msg('gripNotHere'));
        return;
      }
      setError(null);
      say(GRIP_NAME);
      setGripRun({ grip, base: { x: grip.x, y: grip.y }, copy: false, step: 'stretch' });
      setPointer({ x: grip.x, y: grip.y });
      setFocusNonce((n) => n + 1);
    },
    commandLabel: gripRun ? GRIP_NAME : null,
    apply: (made) => {
      if (!editing || made.length === 0) return;
      setError(null);
      add(made);
    },
    boxing: editing && selecting && gripRun === null,
    band,
    setBand,
    pickBand: (picked, additive) => {
      setBand(null);
      if (!scene || !shown || !selecting) return;
      // STRETCH takes a crossing window whichever way it is dragged.
      const box: Band =
        run?.cmd === 'stretch'
          ? {
              x0: Math.max(picked.x0, picked.x1),
              y0: picked.y0,
              x1: Math.min(picked.x0, picked.x1),
              y1: picked.y1,
            }
          : picked;
      const found = entitiesInBand(
        scene,
        box,
        (index) => isShown(index) && !isLocked(index),
        shown.transformOf,
        shown.erased,
        shown.curveOf,
      );
      if (run?.cmd === 'stretch') {
        setRun({
          ...run,
          window: {
            minX: Math.min(box.x0, box.x1),
            maxX: Math.max(box.x0, box.x1),
            minY: Math.min(box.y0, box.y1),
            maxY: Math.max(box.y0, box.y1),
          },
        });
      }
      // AutoCAD (PICKADD 2): a window adds to the selection; Shift + window takes off.
      setSelection((before) => {
        const next = new Set(before);
        for (const index of found) {
          if (run?.flags.removing || additive) next.delete(index);
          else next.add(index);
        }
        return next;
      });
      if (run) say(msg('found', { count: found.length }));
    },
    tracking: (run !== null && isTracked(run.step)) || gripRun !== null,
    hover: (at) => {
      if (gripRun || (run && isTracked(run.step))) setPointer(at);
    },
    // Every «Specify … point» prompt takes the object snaps, a grip's new place included.
    wantsPoint:
      gripRun !== null ||
      (run !== null && run.step !== 'select' && !isObjectStep(run.step) && !isTextStep(run.step)),
    anchor: run
      ? (run.points[run.points.length - 1] ?? run.base)
      : gripRun !== null
        ? gripRun.base
        : null,
    ghost,
    sketch,
    pointerStore,
    liveDraw,
    layers,
    allLayers,
    currentLayer: current,
    chooseLayer: (value) => {
      if (!value) {
        setCurrentLayer('');
        return;
      }
      if (!run && handles.length > 0) {
        if (!layers.includes(value)) {
          say(msg('layerNoRule', { layer: value }));
          return;
        }
        add(handles.map((h) => ({ kind: 'move_layer', handle: h, toLayer: value }) as CanvasEdit));
        say(msg('changedToLayer', { count: handles.length, layer: value }));
        setSelection(NONE);
        return;
      }
      if (value !== currentLayer) undoHistory.record('CLAYER', 'edits', { edits, currentLayer });
      setCurrentLayer(value);
      say(msg('currentNow', { layer: value }));
      if (!layers.includes(value)) say(msg('drawingOnly', { layer: value }));
    },
    addLayer: (name, like) => {
      const value = name.trim();
      if (!value) return 'design.cad.layerNameMissing';
      if (allLayers.includes(value)) return 'design.cad.layerExists';
      add([{ kind: 'add_layer', layer: value, like }]);
      setCurrentLayer(value);
      return null;
    },
    meaningOf: (layer) => {
      if (ruled.has(layer)) return { kind: 'rule' };
      const like = aliases.get(layer);
      return like !== undefined && like !== layer ? { kind: 'like', like } : { kind: 'none' };
    },
    setMeaning: (layer, like) => {
      if (!layer || !like || ruled.has(layer) || !mapped.includes(like)) return;
      add([{ kind: 'add_layer', layer, like }]);
      say(msg('meaningSet', { layer, like }));
    },
    renameLayer: (from, to) => {
      const value = to.trim();
      if (!from || !value) return 'design.cad.layerNameMissing';
      if (allLayers.includes(value)) return 'design.cad.layerExists';
      add([{ kind: 'rename_layer', from, to: value }]);
      if (currentLayer === from) setCurrentLayer(value);
      return null;
    },
    deleteLayer: (name) => {
      if (!name) return;
      add([{ kind: 'delete_layer', layer: name }]);
      if (currentLayer === name) setCurrentLayer('');
    },
    selectionStyle: selectStyle(),
    setStyle: (patch) => {
      if (!scene || handles.length === 0) return;
      const out: CanvasEdit[] = [];
      const seen = new Set<string>();
      for (const index of selection) {
        const handle = scene.view.entities[index]?.handle;
        if (!handle || seen.has(handle)) continue;
        seen.add(handle);
        const before = shown?.styleOf.get(index) ?? {
          color: null,
          linetype: null,
          lineweight: null,
        };
        out.push({ kind: 'set_style', handle, ...before, ...patch });
      }
      add(out);
    },
    edits,
    preview: shown,
    undo,
    canUndo: undoHistory.canUndo || (run !== null && run.points.length > 1),
    redo,
    canRedo: undoHistory.canRedo,
    save: () => {
      if (edits.length === 0) {
        setEditing(false);
        finish();
        return;
      }
      setError(null);
      saveMutation.mutate(
        { items: editRequests(edits) },
        {
          onSuccess: () => {
            setEdits([]);
            undoHistory.clear();
            setEditing(false);
            finish();
            setHistory([]);
          },
          onError: (caught) =>
            setError(correctionError(errorCodeOf(caught), errorReasonOf(caught))),
        },
      );
    },
    saving: saveMutation.isPending,
    cancel: () => {
      setEdits([]);
      undoHistory.clear();
      setEditing(false);
      setError(null);
      setHistory([]);
      finish();
    },
    error,
  };
  return state;
}

/** AutoCAD's prompt line: `NAME Text or [Opt/Opt] <default>:`. */
export function formatPrompt(
  t: (key: MessageKey, params?: Record<string, string | number>) => string,
  name: string | null,
  prompt: CommandPrompt,
): string {
  const text = t(`design.cad.cmd.${prompt.key}` as MessageKey);
  if (prompt.key === 'command') return text;
  const or = PROMPTS_WITHOUT_OR.has(prompt.key) ? '' : ` ${t('design.cad.or')}`;
  const options =
    prompt.options.length > 0 ? `${or} [${prompt.options.map((o) => o.word).join('/')}]` : '';
  const fallback = prompt.fallback !== null ? ` <${prompt.fallback}>` : '';
  return `${name ?? ''} ${text}${options}${fallback}:`.trim();
}
