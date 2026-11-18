'use client';

import { useEffect, useMemo, useState } from 'react';
import { errorCodeOf, errorReasonOf } from '@/shared/api/bff-client';
import { useSaveCorrections } from '../api/queries';
import { mirrorAcross, rotationAbout, scaleAbout, translation, type Affine } from '../model/affine';
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
  MULTI_PICK_TOOLS,
  PICK_TOOLS,
  rotateEdits,
  scaleEdits,
  type Band,
  type CanvasEdit,
  type EditTool,
  type Point,
} from '../model/canvas-edit';
import { correctionError } from '../model/corrections';
import type { DrawingPreview } from '../model/drawing-preview';
import type { DrawingScene } from '../model/drawing-scene';
import type { ErrorMessage } from '../model/revision-errors';

export type { Point } from '../model/canvas-edit';

/**
 * Where a command is (ADR-047, ADR-050), AutoCAD-like: `pick` items, then `base` point, then the
 * `second` point (or a typed angle / factor); draw tools collect `points`.
 */
export type EditStep = 'pick' | 'base' | 'second' | 'points' | 'value';

/** The command line under the canvas: what the command waits for now. */
export type PromptKey =
  | 'pickTool'
  | 'pick'
  | 'pickText'
  | 'notText'
  | 'pickLayer'
  | 'erase'
  | 'base'
  | 'moveTo'
  | 'copyTo'
  | 'rotateTo'
  | 'mirrorTo'
  | 'scaleBy'
  | 'needLayer'
  | 'lineFirst'
  | 'lineNext'
  | 'polyNext'
  | 'textAt'
  | 'textValue'
  | 'pointAt';

/** The drawing's edit mode, a CAD ribbon (ADR-047, ADR-050). */
export interface CanvasEditState {
  /** The project manager may edit (draft revision and design:write). */
  available: boolean;
  editing: boolean;
  start: () => void;
  tool: EditTool | null;
  setTool: (tool: EditTool | null) => void;
  step: EditStep;
  prompt: PromptKey;
  /** Entities picked with the current tool. */
  chosen: ReadonlySet<number>;
  /** Handles of the picked entities (an INSERT counts once). */
  chosenCount: number;
  clearChosen: () => void;
  /** A click on the canvas while a tool is on (`at`: the drawing point clicked). */
  pick: (entity: number | null, at: Point, additive: boolean) => void;
  /** A drag on the canvas draws a selection box (picking with a tool that takes several). */
  boxing: boolean;
  band: Band | null;
  setBand: (band: Band | null) => void;
  pickBand: (band: Band, additive: boolean) => void;
  /** «تم» after picking: go on to the points (move, copy, rotate, mirror, scale) or erase. */
  confirmPick: () => void;
  /** Kept for the old panel: same as confirmPick. */
  startPoints: () => void;
  // Layers
  /** Layers items may be moved or drawn to (they have a usable rule; added ones too). */
  layers: string[];
  /** Every layer: the drawing's and those added on the page. */
  allLayers: string[];
  layer: string;
  setLayer: (value: string) => void;
  applyLayer: () => void;
  /** The layer new lines, texts and points go on (CAD's current layer). */
  currentLayer: string;
  setCurrentLayer: (value: string) => void;
  addLayer: (name: string, like: string) => string | null;
  renameLayer: (from: string, to: string) => string | null;
  deleteLayer: (name: string) => void;
  // Text
  text: string;
  setText: (value: string) => void;
  applyText: () => void;
  notText: boolean;
  // Points and values
  base: Point | null;
  /** The pointer follows the next point: report it. */
  tracking: boolean;
  hover: (at: Point) => void;
  /** The move / turn / mirror / scale the pointer would make now, dashed over the picked items. */
  ghost: { indexes: readonly number[]; step: Affine } | null;
  /** The line being drawn, with the pointer as last point. */
  sketch: { points: readonly Point[]; closed: boolean } | null;
  angle: string;
  setAngle: (value: string) => void;
  canApplyAngle: boolean;
  applyAngle: () => void;
  factor: string;
  setFactor: (value: string) => void;
  canApplyFactor: boolean;
  applyFactor: () => void;
  /** Polyline: Enter / «إنهاء»; `closed` joins the last point to the first. */
  finishPolyline: (closed: boolean) => void;
  pointsCount: number;
  // Keyboard (CAD shortcuts); true when the key was used
  key: (key: string, ctrl: boolean) => boolean;
  // Unsaved edits
  edits: readonly CanvasEdit[];
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
  isShown: (index: number) => boolean;
}

const NONE: ReadonlySet<number> = new Set();
/** A typed number: digits, comma or point decimals, optional sign. */
const NUMBER = /^[+-]?\d+([.,]\d+)?$/;
const parseNumber = (value: string) => Number(value.trim().replace(',', '.'));

/** Degrees counter-clockwise from the base point to the point (0 = to the right, as CAD). */
const directionOf = (base: Point, at: Point) =>
  (Math.atan2(at.y - base.y, at.x - base.x) * 180) / Math.PI;

/** CAD-like one-key shortcuts (AutoCAD: M, CO, RO, MI, SC, E, L, PL, T). */
const SHORTCUTS: Readonly<Record<string, EditTool>> = {
  m: 'move',
  c: 'copy',
  r: 'rotate',
  i: 'mirror',
  s: 'scale',
  e: 'erase',
  l: 'line',
  p: 'polyline',
  t: 'addText',
};

export function useCanvasEdit(input: Input): CanvasEditState {
  const { projectId, cadFileId, available, scene, preview, layers: mapped, isShown } = input;
  const saveMutation = useSaveCorrections(projectId, cadFileId);
  const [editing, setEditing] = useState(false);
  const [tool, setToolState] = useState<EditTool | null>(null);
  const [step, setStep] = useState<EditStep>('pick');
  const [chosen, setChosen] = useState<ReadonlySet<number>>(NONE);
  const [band, setBand] = useState<Band | null>(null);
  const [notText, setNotText] = useState(false);
  const [layer, setLayer] = useState('');
  const [currentLayer, setCurrentLayer] = useState('');
  const [text, setText] = useState('');
  const [base, setBase] = useState<Point | null>(null);
  const [points, setPoints] = useState<readonly Point[]>([]);
  const [pointer, setPointer] = useState<Point | null>(null);
  const [angle, setAngle] = useState('');
  const [factor, setFactor] = useState('');
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

  // Layers added or renamed (saved and unsaved) take the meaning of their source.
  const aliases = useMemo(() => {
    const out = new Map(preview?.aliases ?? []);
    for (const edit of edits) {
      if (edit.kind === 'add_layer') out.set(edit.layer, out.get(edit.like) ?? edit.like);
      else if (edit.kind === 'rename_layer') out.set(edit.to, out.get(edit.from) ?? edit.from);
    }
    return out;
  }, [preview, edits]);
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
    for (const [name, like] of aliases) if (mapped.includes(like)) out.add(name);
    return [...out].filter((name) => !removed.has(name)).sort((a, b) => a.localeCompare(b));
  }, [mapped, aliases, removed]);
  const allLayers = useMemo(() => {
    const out = new Set((scene?.view.layers ?? []).map((l) => l.name));
    for (const name of aliases.keys()) out.add(name);
    return [...out].filter((name) => !removed.has(name)).sort((a, b) => a.localeCompare(b));
  }, [scene, aliases, removed]);

  const resetPick = () => {
    setChosen(NONE);
    setBand(null);
    setNotText(false);
    setLayer('');
    setText('');
    setStep('pick');
    setBase(null);
    setPoints([]);
    setPointer(null);
    setAngle('');
    setFactor('');
  };

  const currentText = (index: number) =>
    preview?.textOf.get(index) ?? scene?.view.entities[index]?.texts[0]?.text ?? '';

  const handles = scene ? handlesOf(scene, chosen) : [];
  const picking = tool !== null && PICK_TOOLS.includes(tool);
  const several = tool !== null && MULTI_PICK_TOOLS.includes(tool);
  const drawLayer = layers.includes(currentLayer) ? currentLayer : '';

  const add = (added: CanvasEdit[], keepPicking = false) => {
    setEdits((previous) => addEdits(previous, added));
    setError(null);
    if (!keepPicking) resetPick();
  };

  const startTool = (next: EditTool | null) => {
    setToolState(next);
    resetPick();
    if (next !== null && !PICK_TOOLS.includes(next)) setStep('points');
  };

  /** The second point of move / copy / rotate / mirror. */
  const finishAt = (at: Point) => {
    if (!base || handles.length === 0) return;
    if (tool === 'move') add(moveEdits(handles, at.x - base.x, at.y - base.y));
    else if (tool === 'copy') {
      // CAD's COPY goes on placing copies from the same base until Enter.
      add(copyEdits(handles, at.x - base.x, at.y - base.y), true);
    } else if (tool === 'rotate') add(rotateEdits(handles, base.x, base.y, directionOf(base, at)));
    else if (tool === 'mirror' && (at.x !== base.x || at.y !== base.y)) {
      add(mirrorEdits(handles, base, at));
    }
  };

  /** A click while drawing. */
  const drawAt = (at: Point) => {
    if (!drawLayer) return;
    if (tool === 'point') {
      add([{ kind: 'add_item', layer: drawLayer, x: at.x, y: at.y }], true);
      return;
    }
    if (tool === 'addText') {
      setBase(at);
      setStep('value');
      return;
    }
    if (tool === 'line') {
      const last = points[points.length - 1];
      if (last) {
        // Each LINE segment is its own line; the next one starts where this one ends.
        setEdits((previous) => addEdits(previous, [curveEdit(drawLayer, [last, at], false)]));
      }
      setPoints([at]);
      return;
    }
    if (tool === 'polyline') setPoints((previous) => [...previous, at]);
  };

  const finishPolyline = (closed: boolean) => {
    if (tool !== 'polyline' || !drawLayer) return;
    if (points.length >= (closed ? 3 : 2)) add([curveEdit(drawLayer, points, closed)]);
    setPoints([]);
    setStep('points');
  };

  const confirmPick = () => {
    if (handles.length === 0) return;
    if (tool === 'erase') {
      add(eraseEdits(handles));
      return;
    }
    if (
      tool === 'move' ||
      tool === 'copy' ||
      tool === 'rotate' ||
      tool === 'mirror' ||
      tool === 'scale'
    ) {
      setStep('base');
      setBase(null);
      setPointer(null);
    }
  };

  // What the pointer would do now.
  let ghost: CanvasEditState['ghost'] = null;
  let sketch: CanvasEditState['sketch'] = null;
  if (step === 'second' && base && chosen.size > 0) {
    const at = pointer ?? base;
    let stepAffine: Affine | null = null;
    if (tool === 'move' || tool === 'copy') stepAffine = translation(at.x - base.x, at.y - base.y);
    else if (tool === 'rotate') {
      stepAffine = rotationAbout(
        base.x,
        base.y,
        NUMBER.test(angle.trim()) ? parseNumber(angle) : directionOf(base, at),
      );
    } else if (tool === 'mirror' && (at.x !== base.x || at.y !== base.y)) {
      stepAffine = mirrorAcross(base.x, base.y, at.x, at.y);
      sketch = { points: [base, at], closed: false };
    } else if (tool === 'scale' && NUMBER.test(factor.trim()) && parseNumber(factor) > 0) {
      stepAffine = scaleAbout(base.x, base.y, parseNumber(factor));
    }
    if (stepAffine) ghost = { indexes: [...chosen], step: stepAffine };
  }
  if ((tool === 'line' || tool === 'polyline') && points.length > 0) {
    sketch = { points: pointer ? [...points, pointer] : points, closed: false };
  }

  const angleOk =
    NUMBER.test(angle.trim()) && Math.abs(parseNumber(angle)) <= 360 && tool === 'rotate';
  const factorOk =
    NUMBER.test(factor.trim()) &&
    parseNumber(factor) >= 0.001 &&
    parseNumber(factor) <= 1000 &&
    tool === 'scale';

  let prompt: PromptKey = 'pickTool';
  if (tool !== null) {
    if (picking && step === 'pick') {
      if (tool === 'text') prompt = notText ? 'notText' : 'pickText';
      else if (tool === 'layer') prompt = handles.length > 0 ? 'pickLayer' : 'pick';
      else if (tool === 'erase') prompt = handles.length > 0 ? 'erase' : 'pick';
      else prompt = 'pick';
    } else if (step === 'base') prompt = 'base';
    else if (step === 'second') {
      prompt =
        tool === 'move'
          ? 'moveTo'
          : tool === 'copy'
            ? 'copyTo'
            : tool === 'rotate'
              ? 'rotateTo'
              : tool === 'mirror'
                ? 'mirrorTo'
                : 'scaleBy';
    } else if (!drawLayer) prompt = 'needLayer';
    else if (tool === 'line') prompt = points.length === 0 ? 'lineFirst' : 'lineNext';
    else if (tool === 'polyline') prompt = points.length === 0 ? 'lineFirst' : 'polyNext';
    else if (tool === 'addText') prompt = step === 'value' ? 'textValue' : 'textAt';
    else if (tool === 'point') prompt = 'pointAt';
  }

  const undo = () => {
    if (points.length > 0) {
      setPoints((previous) => previous.slice(0, -1));
      return;
    }
    setEdits((previous) => previous.slice(0, -1));
  };

  const state: CanvasEditState = {
    available,
    editing,
    start: () => {
      setEditing(true);
      setError(null);
    },
    tool,
    setTool: startTool,
    step,
    prompt,
    chosen,
    chosenCount: handles.length,
    clearChosen: resetPick,
    pick: (entity, at, additive) => {
      if (!editing || tool === null || !scene) return;
      setError(null);
      if (step === 'base') {
        setBase(at);
        setPointer(at);
        setStep('second');
        return;
      }
      if (step === 'second') {
        if (tool === 'rotate' || tool === 'move' || tool === 'copy' || tool === 'mirror')
          finishAt(at);
        return;
      }
      if (step === 'points') {
        drawAt(at);
        return;
      }
      if (step === 'value') return;
      if (tool === 'text') {
        if (entity === null) {
          resetPick();
        } else if (isTextEntity(scene, entity)) {
          setChosen(new Set([entity]));
          setText(currentText(entity));
          setNotText(false);
        } else {
          setChosen(NONE);
          setNotText(true);
        }
        return;
      }
      if (entity === null) {
        if (!additive) setChosen(NONE);
        return;
      }
      setChosen((previous) => {
        const next = new Set(additive ? previous : NONE);
        if (additive && previous.has(entity)) next.delete(entity);
        else next.add(entity);
        return next;
      });
    },
    boxing: editing && several && step === 'pick',
    band,
    setBand,
    pickBand: (picked, additive) => {
      setBand(null);
      if (!scene || !several || step !== 'pick') return;
      const found = entitiesInBand(scene, picked, isShown, preview?.transformOf, preview?.erased);
      setChosen((previous) => new Set([...(additive ? previous : NONE), ...found]));
    },
    confirmPick,
    startPoints: confirmPick,
    layers,
    allLayers,
    layer,
    setLayer,
    applyLayer: () => {
      if (!layer || handles.length === 0) return;
      add(handles.map((handle) => ({ kind: 'move_layer', handle, toLayer: layer })));
    },
    currentLayer: drawLayer,
    setCurrentLayer,
    addLayer: (name, like) => {
      const value = name.trim();
      if (!value || !like) return 'design.cad.layerNameMissing';
      if (allLayers.includes(value)) return 'design.cad.layerExists';
      add([{ kind: 'add_layer', layer: value, like }], true);
      setCurrentLayer(value);
      return null;
    },
    renameLayer: (from, to) => {
      const value = to.trim();
      if (!from || !value) return 'design.cad.layerNameMissing';
      if (allLayers.includes(value)) return 'design.cad.layerExists';
      add([{ kind: 'rename_layer', from, to: value }], true);
      if (currentLayer === from) setCurrentLayer(value);
      return null;
    },
    deleteLayer: (name) => {
      if (!name) return;
      add([{ kind: 'delete_layer', layer: name }], true);
      if (currentLayer === name) setCurrentLayer('');
    },
    text,
    setText,
    applyText: () => {
      const value = text.trim();
      if (value.length === 0) return;
      if (tool === 'addText' && base && drawLayer) {
        add(
          [{ kind: 'add_text', layer: drawLayer, x: base.x, y: base.y, text: value, height: null }],
          true,
        );
        setBase(null);
        setText('');
        setStep('points');
        return;
      }
      const [handle] = handles;
      if (handle === undefined) return;
      add([{ kind: 'set_text', handle, text: value }]);
    },
    notText,
    base,
    tracking: step === 'second' || ((tool === 'line' || tool === 'polyline') && points.length > 0),
    hover: (at) => {
      if (step === 'second' || points.length > 0) setPointer(at);
    },
    ghost,
    sketch,
    angle,
    setAngle,
    canApplyAngle: angleOk && base !== null,
    applyAngle: () => {
      if (!angleOk || !base) return;
      add(rotateEdits(handles, base.x, base.y, parseNumber(angle)));
    },
    factor,
    setFactor,
    canApplyFactor: factorOk && base !== null,
    applyFactor: () => {
      if (!factorOk || !base) return;
      add(scaleEdits(handles, base.x, base.y, parseNumber(factor)));
    },
    finishPolyline,
    pointsCount: points.length,
    key: (k, ctrl) => {
      if (!editing) return false;
      if (ctrl && k.toLowerCase() === 'z') {
        undo();
        return true;
      }
      if (k === 'Escape') {
        if (tool === 'copy' && step === 'second') resetPick();
        else if (step !== 'pick' && step !== 'points') resetPick();
        else if (points.length > 0) setPoints([]);
        else startTool(null);
        return true;
      }
      if (k === 'Enter') {
        if (tool === 'polyline') finishPolyline(false);
        else if (tool === 'line') setPoints([]);
        else if (tool === 'copy' && step === 'second') resetPick();
        else if (picking && step === 'pick') confirmPick();
        return true;
      }
      if (k === 'Delete') {
        startTool('erase');
        return true;
      }
      const next = SHORTCUTS[k.toLowerCase()];
      if (next && !ctrl) {
        startTool(next);
        return true;
      }
      return false;
    },
    edits,
    undo,
    canUndo: edits.length > 0 || points.length > 0,
    save: () => {
      if (edits.length === 0) {
        setEditing(false);
        startTool(null);
        return;
      }
      setError(null);
      saveMutation.mutate(
        { items: editRequests(edits) },
        {
          onSuccess: () => {
            setEdits([]);
            setEditing(false);
            startTool(null);
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
      startTool(null);
    },
    error,
  };
  return state;
}
