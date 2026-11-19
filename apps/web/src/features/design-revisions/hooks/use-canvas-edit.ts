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
  acadNumber,
  COMMANDS,
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
} from '../model/geometry';
import type { ErrorMessage } from '../model/revision-errors';

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
  | 'laymchDest';

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
  | 'laymchDest';

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
});

/** Steps where the command line takes free text (spaces are part of it, not Enter). */
const TEXT_STEPS: readonly Step[] = ['textValue', 'editValue', 'leaderText'];
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
];

const CURVE_KINDS = new Set(['LINE', 'LWPOLYLINE', 'POLYLINE']);
const NONE: ReadonlySet<number> = new Set();
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
  // Selection
  chosen: ReadonlySet<number>;
  chosenCount: number;
  clearChosen: () => void;
  /** A click on the canvas in the edit mode (`at`: the drawing point clicked). */
  pick: (entity: number | null, at: Point, additive: boolean) => void;
  /** A drag on the canvas draws a selection box. */
  boxing: boolean;
  band: Band | null;
  setBand: (band: Band | null) => void;
  pickBand: (band: Band, additive: boolean) => void;
  // Pointer
  tracking: boolean;
  hover: (at: Point) => void;
  ghost: { indexes: readonly number[]; step: Affine } | null;
  sketch: { points: readonly Point[]; closed: boolean } | null;
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
}

/** Degrees counter-clockwise from the base point to the point (0 = to the right, as CAD). */
const directionOf = (base: Point, at: Point) =>
  (Math.atan2(at.y - base.y, at.x - base.x) * 180) / Math.PI;
const pt = (p: Point): Pt => [p.x, p.y];
const xy = (p: Pt): Point => ({ x: p[0], y: p[1] });

export function useCanvasEdit(input: Input): CanvasEditState {
  const { projectId, cadFileId, available, scene, preview: saved, layers: mapped, isShown } = input;
  const isLocked = input.isLocked ?? (() => false);
  const textHeight = input.textHeight ?? 2.5;
  const { t } = useI18n();
  const saveMutation = useSaveCorrections(projectId, cadFileId);
  const [editing, setEditing] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [lastCmd, setLastCmd] = useState<CommandId | null>(null);
  const [selection, setSelection] = useState<ReadonlySet<number>>(NONE);
  const [band, setBand] = useState<Band | null>(null);
  const [pointer, setPointer] = useState<Point | null>(null);
  const [text, setText] = useState('');
  const [history, setHistory] = useState<readonly string[]>([]);
  const [focusNonce, setFocusNonce] = useState(0);
  const [currentLayer, setCurrentLayer] = useState('');
  const [filletRadius, setFilletRadius] = useState(0);
  const [offsetDist, setOffsetDist] = useState(1);
  const [edits, setEdits] = useState<readonly CanvasEdit[]>([]);
  const [error, setError] = useState<ErrorMessage | null>(null);

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

  const shown = useMemo(
    () => (scene && saved ? previewWithEdits(scene, saved, edits, textHeight) : null),
    [scene, saved, edits, textHeight],
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
    for (const curve of shown.extraCurves) {
      const points: Pt[] = [];
      for (let i = 0; i + 1 < curve.path.length; i += 2) {
        points.push([curve.path[i] as number, curve.path[i + 1] as number]);
      }
      out.push({ points, closed: curve.closed });
    }
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
    switch (r.step) {
      case 'select':
        return r.cmd === 'stretch'
          ? p('stretchSelect')
          : r.cmd === 'join'
            ? p('joinSelect')
            : r.cmd === 'laymch'
              ? p('laymchSelect')
              : p('selectObjects');
      case 'base':
        return p('basePoint');
      case 'second':
        return r.cmd === 'copy'
          ? p('secondPoint', [opt('Exit', 'E'), opt('Undo', 'U')], 'Exit')
          : p('secondPoint');
      case 'angle':
        return p('rotationAngle');
      case 'factor':
        return p('scaleFactor');
      case 'mirror1':
        return p('mirrorFirst');
      case 'mirror2':
        return p('mirrorSecond');
      case 'first':
        return r.cmd === 'pline' ? p('plineStart') : p('lineFirst');
      case 'next':
        return r.points.length >= (r.cmd === 'pline' ? 2 : 3) || r.made.length >= 2
          ? p('nextPoint', [opt('Close', 'C'), opt('Undo', 'U')])
          : p('nextPoint', [opt('Undo', 'U')]);
      case 'center':
        return p('circleCenter', [opt('3P', '3P'), opt('2P', '2P')]);
      case 'radius':
        return p('circleRadius', [opt('Diameter', 'D')]);
      case 'diameter':
        return p('circleDiameter');
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
      case 'arc1':
        return p('arcStart');
      case 'arc2':
        return p('arcSecond');
      case 'arc3':
        return p('arcEnd');
      case 'corner1':
        return p('rectFirst');
      case 'corner2':
        return p('rectOther');
      case 'pointAt':
        return p('pointAt');
      case 'trimPick':
        return p('trimPick', [opt('Undo', 'U')]);
      case 'filletFirst':
        return p('filletFirst', [opt('Undo', 'U'), opt('Radius', 'R')]);
      case 'filletSecond':
        return p('filletSecond', [opt('Radius', 'R')]);
      case 'filletRadius':
        return p('filletRadius', [], acadNumber(filletRadius));
      case 'offsetDistance':
        return p('offsetDistance', [], acadNumber(offsetDist));
      case 'offsetPick':
        return p('offsetPick', [opt('Exit', 'E'), opt('Undo', 'U')], 'Exit');
      case 'offsetSide':
        return p('offsetSide', [opt('Exit', 'E')], 'Exit');
      case 'textStart':
        return p('textStart');
      case 'textHeight':
        return p('textHeight', [], acadNumber(textHeight));
      case 'textValue':
        return p('textValue');
      case 'editPick':
        return p('editPick');
      case 'editValue':
        return p('editValue');
      case 'dim1':
        return p('dimFirst');
      case 'dim2':
        return p('dimSecond');
      case 'dim3':
        return p('dimLocation');
      case 'leaderStart':
        return p('leaderStart');
      case 'leaderNext':
        return p('nextPoint', [opt('Undo', 'U')], r.points.length >= 2 ? 'Annotation' : null);
      case 'leaderText':
        return p('leaderText');
      case 'source':
        return p('matchSource');
      case 'dest':
        return p('matchDest');
      case 'laymcurPick':
        return p('laymcurPick');
      case 'laymchDest':
        return p('laymchDest');
    }
  };

  const promptLine = (r: Run | null) =>
    formatPrompt(t, r ? COMMANDS[r.cmd].name : null, promptOf(r));

  // ---------- running ----------

  const finish = (keepSelection = false) => {
    setRun(null);
    setPointer(null);
    setBand(null);
    setText('');
    if (!keepSelection) setSelection(NONE);
  };

  const begin = (cmd: CommandId) => {
    if (!scene) return;
    setError(null);
    setLastCmd(cmd);
    setText('');
    setBand(null);
    setFocusNonce((n) => n + 1);
    say(msg('commandEcho', { name: COMMANDS[cmd].name }));
    const picked = handles.length > 0;
    const next = (step: Step) => setRun(newRun(cmd, step));
    switch (cmd) {
      case 'move':
      case 'copy':
      case 'rotate':
      case 'scale':
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
      case 'pline':
        return next('first');
      case 'circle':
        return next('center');
      case 'arc':
        return next('arc1');
      case 'rectang':
        return next('corner1');
      case 'point':
        return next('pointAt');
      case 'trim':
        setSelection(NONE);
        return next('trimPick');
      case 'fillet':
        setSelection(NONE);
        say(msg('filletSettings', { radius: acadNumber(filletRadius) }));
        return next('filletFirst');
      case 'offset':
        setSelection(NONE);
        say(msg('offsetSettings'));
        return next('offsetDistance');
      case 'text':
        return next('textStart');
      case 'textedit': {
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
          return;
        }
        setSelection(NONE);
        return next('source');
      }
      case 'laymcur':
        return next('laymcurPick');
    }
  };

  const editText = (index: number) => {
    const r = newRun('textedit', 'editValue');
    r.target = index;
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
    switch (r.cmd) {
      case 'erase':
        add(eraseEdits(handles));
        finish();
        return;
      case 'join':
        join(handles);
        return;
      case 'mirror':
        setRun({ ...r, step: 'mirror1' });
        return;
      case 'laymch':
        setRun({ ...r, step: 'laymchDest' });
        return;
      case 'stretch':
        if (!r.window) {
          say(msg('stretchWindow'));
          finish();
          return;
        }
        setRun({ ...r, step: 'base' });
        return;
      default:
        setRun({ ...r, step: 'base' });
    }
  };

  /** A point given for the step (clicked, typed, or by direct distance). */
  const feedPoint = (r: Run, p: Point) => {
    const last = r.points[r.points.length - 1] ?? null;
    switch (r.step) {
      case 'base':
        setRun({
          ...r,
          step: r.cmd === 'rotate' ? 'angle' : r.cmd === 'scale' ? 'factor' : 'second',
          base: p,
        });
        setPointer(p);
        return;
      case 'second': {
        if (!r.base) return;
        const dx = p.x - r.base.x;
        const dy = p.y - r.base.y;
        if (r.cmd === 'move') {
          add(moveEdits(handles, dx, dy));
          finish();
        } else if (r.cmd === 'copy') {
          const made = add(copyEdits(handles, dx, dy));
          setRun({ ...r, made: [...r.made, made.length] });
        } else if (r.cmd === 'stretch') {
          stretch(r, dx, dy);
        }
        return;
      }
      case 'angle':
        if (!r.base) return;
        add(rotateEdits(handles, r.base.x, r.base.y, directionOf(r.base, p)));
        finish();
        return;
      case 'factor':
        if (!r.base) return;
        feedFactor(r, distance(pt(r.base), pt(p)));
        return;
      case 'mirror1':
        setRun({ ...r, step: 'mirror2', base: p });
        setPointer(p);
        return;
      case 'mirror2':
        if (!r.base || (p.x === r.base.x && p.y === r.base.y)) return;
        add(mirrorEdits(handles, r.base, p));
        finish();
        return;
      case 'first':
        if (!needDrawLayer()) return;
        setRun({ ...r, step: 'next', points: [p] });
        setPointer(p);
        return;
      case 'next':
        if (!last) return;
        if (r.cmd === 'line') {
          const made = add([curveEdit(drawLayer, [last, p], false)]);
          setRun({ ...r, points: [...r.points, p], made: [...r.made, made.length] });
        } else {
          setRun({ ...r, points: [...r.points, p] });
        }
        return;
      case 'center':
        if (!needDrawLayer()) return;
        setRun({ ...r, step: 'radius', base: p });
        setPointer(p);
        return;
      case 'radius':
      case 'diameter':
        if (r.base) circle(r.base, distance(pt(r.base), pt(p)) / (r.step === 'diameter' ? 2 : 1));
        return;
      case 'c3p1':
      case 'c3p2':
        setRun({ ...r, step: r.step === 'c3p1' ? 'c3p2' : 'c3p3', points: [...r.points, p] });
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
        setRun({ ...r, step: 'c2p2', points: [p] });
        setPointer(p);
        return;
      case 'c2p2': {
        const [a] = r.points;
        if (!a) return;
        circle({ x: (a.x + p.x) / 2, y: (a.y + p.y) / 2 }, distance(pt(a), pt(p)) / 2);
        return;
      }
      case 'arc1':
        if (!needDrawLayer()) return;
        setRun({ ...r, step: 'arc2', points: [p] });
        setPointer(p);
        return;
      case 'arc2':
        setRun({ ...r, step: 'arc3', points: [...r.points, p] });
        return;
      case 'arc3': {
        const [a, b] = r.points;
        if (!a || !b) return;
        try {
          add([pointsCurveEdit(drawLayer, arcThrough(pt(a), pt(b), pt(p)), false)]);
          finish();
        } catch (caught) {
          geometryMessage(caught);
        }
        return;
      }
      case 'corner1':
        if (!needDrawLayer()) return;
        setRun({ ...r, step: 'corner2', base: p });
        setPointer(p);
        return;
      case 'corner2':
        if (!r.base) return;
        try {
          add([pointsCurveEdit(drawLayer, rectanglePoints(pt(r.base), pt(p)), true)]);
          finish();
        } catch (caught) {
          geometryMessage(caught);
        }
        return;
      case 'pointAt':
        if (!needDrawLayer()) return;
        add([{ kind: 'add_item', layer: drawLayer, x: roundCoord(p.x), y: roundCoord(p.y) }]);
        finish();
        return;
      case 'offsetSide':
        offsetTo(r, p);
        return;
      case 'textStart':
        if (!needDrawLayer()) return;
        setRun({ ...r, step: 'textHeight', textAt: p });
        return;
      case 'textHeight':
        if (r.textAt) feedHeight(r, distance(pt(r.textAt), pt(p)));
        return;
      case 'dim1':
        setRun({ ...r, step: 'dim2', points: [p] });
        setPointer(p);
        return;
      case 'dim2':
        setRun({ ...r, step: 'dim3', points: [...r.points, p] });
        return;
      case 'dim3': {
        const [a, b] = r.points;
        if (!a || !b) return;
        const dim = linearDimension(pt(a), pt(b), pt(p));
        add([
          {
            kind: 'add_note',
            note: 'dimension',
            layer: current || '0',
            points: [a, b, p].map((q) => [roundCoord(q.x), roundCoord(q.y)] as [number, number]),
            text: null,
          },
        ]);
        say(msg('dimText', { value: acadNumber(dim.value) }));
        finish();
        return;
      }
      case 'leaderStart':
        setRun({ ...r, step: 'leaderNext', points: [p] });
        setPointer(p);
        return;
      case 'leaderNext':
        setRun({ ...r, points: [...r.points, p] });
        return;
      default:
        return;
    }
  };

  const circle = (center: Point, radius: number) => {
    try {
      add([pointsCurveEdit(drawLayer, circlePoints(pt(center), radius), true)]);
      finish();
    } catch (caught) {
      geometryMessage(caught);
    }
  };

  const feedFactor = (r: Run, factor: number) => {
    if (!r.base) return;
    if (!(factor >= 0.001 && factor <= 1000)) {
      say(msg('badFactor'));
      return;
    }
    add(scaleEdits(handles, r.base.x, r.base.y, factor));
    finish();
  };

  const feedHeight = (r: Run, height: number | null) => {
    if (height !== null && !(height > 0)) {
      say(msg('badValue'));
      return;
    }
    setRun({ ...r, step: 'textValue', height });
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
    if (r.target === null) return;
    const geom = curveGeom(r.target);
    if (!geom) return;
    const layer = layerNameOf(r.target);
    try {
      const points = offsetCurve(geom.points, geom.closed, offsetDist, pt(side));
      const made = add([pointsCurveEdit(layer, points, geom.closed)]);
      setRun({ ...r, step: 'offsetPick', target: null, made: [...r.made, made.length] });
      setSelection(NONE);
    } catch (caught) {
      geometryMessage(caught);
    }
  };

  /** An object clicked for the step. */
  const feedObject = (r: Run, index: number | null, at: Point) => {
    if (!scene) return;
    if (index === null || !pickable(index)) {
      if (r.step === 'trimPick' || r.step === 'dest') return;
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
        try {
          const box = boxAround(geom.points);
          const pieces = trimCurve(geom.points, geom.closed, edgesNear(box, index), pt(at));
          const out: CanvasEdit[] = [];
          const [first, second] = pieces;
          if (!first) out.push({ kind: 'erase_item', handle });
          else out.push(setCurveEdit(handle, first, false));
          if (second) {
            out.push(pointsCurveEdit(layerNameOf(index), second, false));
          }
          const made = add(out);
          setRun({ ...r, made: [...r.made, made.length] });
        } catch (caught) {
          geometryMessage(caught);
        }
        return;
      }
      case 'filletFirst':
        if (!curveGeom(index)) {
          say(msg('notCurve'));
          return;
        }
        setRun({ ...r, step: 'filletSecond', target: index, targetAt: at });
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
          const [p, q] = fillet(
            { points: a.points, closed: a.closed, pick: pt(r.targetAt) },
            { points: b.points, closed: b.closed, pick: pt(at) },
            filletRadius,
          );
          add([setCurveEdit(first, p, false), setCurveEdit(handle, q, false)]);
          finish();
        } catch (caught) {
          geometryMessage(caught);
        }
        return;
      }
      case 'offsetPick':
        if (!curveGeom(index)) {
          say(msg('notCurve'));
          return;
        }
        setRun({ ...r, step: 'offsetSide', target: index });
        setSelection(new Set([index]));
        return;
      case 'editPick':
        if (!isTextEntity(scene, index)) {
          say(msg('notText'));
          return;
        }
        editText(index);
        return;
      case 'source':
        setRun({ ...r, step: 'dest', target: index });
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
      case 'laymchDest': {
        const layer = layerNameOf(index);
        if (!layers.includes(layer)) {
          say(msg('layerNoRule', { layer }));
          return;
        }
        add(handles.map((h) => ({ kind: 'move_layer', handle: h, toLayer: layer }) as CanvasEdit));
        say(msg('changedToLayer', { count: handles.length, layer }));
        finish();
        return;
      }
      default:
        return;
    }
  };

  /** Enter (or Space, or an empty right answer) for the step. */
  const feedEnter = (r: Run) => {
    switch (r.step) {
      case 'select':
        afterSelect(r);
        return;
      case 'second':
        if (r.cmd === 'copy') finish();
        return;
      case 'next':
        if (r.cmd === 'pline' && r.points.length >= 2) {
          add([curveEdit(drawLayer, r.points, false)]);
        }
        finish();
        return;
      case 'filletRadius':
        setRun({ ...r, step: 'filletFirst' });
        return;
      case 'offsetDistance':
        setRun({ ...r, step: 'offsetPick' });
        return;
      case 'textHeight':
        feedHeight(r, null);
        return;
      case 'leaderNext':
        if (r.points.length >= 2) {
          setRun({ ...r, step: 'leaderText' });
          setFocusNonce((n) => n + 1);
        } else finish();
        return;
      default:
        finish();
    }
  };

  const feedOption = (r: Run, key: string) => {
    switch (key) {
      case 'U': {
        if (r.step === 'next' && r.points.length > 1) {
          if (r.cmd === 'line') dropEdits(1);
          setRun({ ...r, points: r.points.slice(0, -1), made: r.made.slice(0, -1) });
        } else if (r.step === 'leaderNext' && r.points.length > 1) {
          setRun({ ...r, points: r.points.slice(0, -1) });
        } else if (r.made.length > 0) {
          dropEdits(r.made[r.made.length - 1] ?? 0);
          setRun({ ...r, made: r.made.slice(0, -1) });
        } else say(msg('nothingToUndo'));
        return;
      }
      case 'C': {
        const first = r.points[0];
        const last = r.points[r.points.length - 1];
        if (!first || !last) return;
        if (r.cmd === 'line' && r.points.length >= 3) {
          add([curveEdit(drawLayer, [last, first], false)]);
          finish();
        } else if (r.cmd === 'pline' && r.points.length >= 3) {
          add([curveEdit(drawLayer, r.points, true)]);
          finish();
        }
        return;
      }
      case 'E':
        finish();
        return;
      case 'R':
        setRun({ ...r, step: 'filletRadius' });
        return;
      case 'D':
        setRun({ ...r, step: 'diameter' });
        return;
      case '3P':
        setRun({ ...r, step: 'c3p1' });
        return;
      case '2P':
        setRun({ ...r, step: 'c2p1' });
        return;
      default:
        return;
    }
  };

  /** Drops the last `count` edits (a command's Undo). */
  const dropEdits = (count: number) => {
    if (count > 0) setEdits((previous) => previous.slice(0, Math.max(0, previous.length - count)));
  };

  const feedNumber = (r: Run, value: number) => {
    const last = r.points[r.points.length - 1] ?? r.base;
    switch (r.step) {
      case 'angle':
        if (r.base && Math.abs(value) <= 360) {
          add(rotateEdits(handles, r.base.x, r.base.y, value));
          finish();
        } else say(msg('badValue'));
        return;
      case 'factor':
        feedFactor(r, value);
        return;
      case 'radius':
      case 'diameter':
        if (r.base && value > 0) circle(r.base, r.step === 'diameter' ? value / 2 : value);
        else say(msg('badValue'));
        return;
      case 'filletRadius':
        if (value >= 0) {
          setFilletRadius(value);
          setRun({ ...r, step: 'filletFirst' });
        } else say(msg('badValue'));
        return;
      case 'offsetDistance':
        if (value > 0) {
          setOffsetDist(value);
          setRun({ ...r, step: 'offsetPick' });
        } else say(msg('badValue'));
        return;
      case 'textHeight':
        feedHeight(r, value);
        return;
      default:
        // AutoCAD's direct distance entry: that far toward the pointer from the last point.
        if (last && TRACKED.includes(r.step)) feedPoint(r, towards(last, pointer, value));
        else say(msg('badPoint'));
    }
  };

  /** Free text for the step. */
  const feedText = (r: Run, value: string) => {
    const trimmed = value.trim();
    if (r.step === 'textValue') {
      if (trimmed && r.textAt && drawLayer) {
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
      }
      finish();
      return;
    }
    if (r.step === 'editValue') {
      const handle = r.target !== null ? scene?.view.entities[r.target]?.handle : undefined;
      if (trimmed && handle) add([{ kind: 'set_text', handle, text: trimmed }]);
      finish();
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
    }
  };

  const submit = () => {
    const typed = text;
    setText('');
    if (!editing) return;
    if (run && TEXT_STEPS.includes(run.step)) {
      say(`${promptLine(run)} ${typed}`);
      feedText(run, typed);
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
      if (OBJECT_STEPS.includes(run.step) || run.step === 'select') say(msg('badSelection'));
      else feedPoint(run, entry.point);
    } else if (entry.kind === 'number') feedNumber(run, entry.value);
    else if (entry.kind === 'word') {
      const key = matchOption(promptOf(run).options, entry.word);
      if (key) feedOption(run, key);
      else say(msg('badKeyword'));
    } else say(msg('badPoint'));
  };

  const cancelRun = () => {
    if (run) say(msg('cancel'));
    finish();
  };

  const undo = () => {
    if (run && (run.step === 'next' || run.step === 'leaderNext') && run.points.length > 1) {
      feedOption(run, 'U');
      return;
    }
    setEdits((previous) => previous.slice(0, -1));
  };

  // ---------- what is drawn while a command runs ----------

  let ghost: CanvasEditState['ghost'] = null;
  let sketch: CanvasEditState['sketch'] = null;
  if (run && pointer) {
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
    if (step === 'next' || step === 'leaderNext' || step === 'dim2') {
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
      sketch = { points: rectanglePoints(pt(base), pt(at)).map(xy), closed: true };
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

  const selectStyle = (): PreviewStyle | null => {
    const [first] = [...selection];
    if (first === undefined) return null;
    return shown?.styleOf.get(first) ?? { color: null, linetype: null, lineweight: null };
  };

  const selecting = run === null || run.step === 'select';

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
    prompt: promptOf(run),
    history,
    input: text,
    setInput: setText,
    submit,
    chooseOption: (key) => {
      if (!run) return;
      say(`${promptLine(run)} ${key}`);
      feedOption(run, key);
    },
    textEntry: run !== null && TEXT_STEPS.includes(run.step),
    focusNonce,
    key: (k, ctrl) => {
      if (!editing) return false;
      if (ctrl && k.toLowerCase() === 'z') {
        undo();
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
      if (k === 'Enter' || (k === ' ' && !(run && TEXT_STEPS.includes(run.step)))) {
        submit();
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
    chosen: selection,
    chosenCount: handles.length,
    clearChosen: () => setSelection(NONE),
    pick: (entity, at, additive) => {
      if (!editing || !scene) return;
      setError(null);
      if (run && OBJECT_STEPS.includes(run.step)) {
        feedObject(run, entity, at);
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
      // AutoCAD: a click adds to the selection; Shift + click takes it off.
      setSelection((previous) => {
        const next = new Set(previous);
        if (additive && previous.has(entity)) next.delete(entity);
        else next.add(entity);
        return next;
      });
      if (run) say(msg('found', { count: 1 }));
    },
    boxing: editing && selecting,
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
      setSelection((previous) => {
        const next = new Set(additive ? previous : run ? previous : NONE);
        for (const index of found) next.add(index);
        return next;
      });
      if (run) say(msg('found', { count: found.length }));
    },
    tracking: run !== null && TRACKED.includes(run.step),
    hover: (at) => {
      if (run && TRACKED.includes(run.step)) setPointer(at);
    },
    ghost,
    sketch,
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
    canUndo: edits.length > 0 || (run !== null && run.points.length > 1),
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
  const options =
    prompt.options.length > 0
      ? ` ${t('design.cad.or')} [${prompt.options.map((o) => o.word).join('/')}]`
      : '';
  const fallback = prompt.fallback !== null ? ` <${prompt.fallback}>` : '';
  return `${name ?? ''} ${text}${options}${fallback}:`.trim();
}
