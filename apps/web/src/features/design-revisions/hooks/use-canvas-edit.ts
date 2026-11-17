'use client';

import { useEffect, useState } from 'react';
import { errorCodeOf, errorReasonOf } from '@/shared/api/bff-client';
import { useSaveCorrections } from '../api/queries';
import { rotationAbout, translation, type Affine } from '../model/affine';
import {
  addEdits,
  editRequests,
  entitiesInBand,
  handlesOf,
  isTextEntity,
  moveEdits,
  rotateEdits,
  type Band,
  type CanvasEdit,
  type EditTool,
} from '../model/canvas-edit';
import { correctionError } from '../model/corrections';
import type { DrawingPreview } from '../model/drawing-preview';
import type { DrawingScene } from '../model/drawing-scene';
import type { ErrorMessage } from '../model/revision-errors';

/**
 * Where a move or turn is (ADR-047): picking the items, then (AutoCAD-like) the base point, then
 * the second point — the destination of a move, or the direction of a turn (or its angle typed).
 */
export type EditStep = 'pick' | 'base' | 'second';

export interface Point {
  x: number;
  y: number;
}

/** The drawing's edit mode (ADR-047): pen → tools → pick items → change → «حفظ» or «إلغاء». */
export interface CanvasEditState {
  /** The project manager may edit (draft revision and design:write). */
  available: boolean;
  editing: boolean;
  start: () => void;
  tool: EditTool | null;
  setTool: (tool: EditTool | null) => void;
  step: EditStep;
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
  /** A click on something that is not a text while the text tool is on. */
  notText: boolean;
  // Layer tool
  layers: string[];
  layer: string;
  setLayer: (value: string) => void;
  applyLayer: () => void;
  // Text tool
  text: string;
  setText: (value: string) => void;
  applyText: () => void;
  // Move / rotate tools
  /** Asks for the base point (after picking). */
  startPoints: () => void;
  base: Point | null;
  /** The pointer follows the second point: report it. */
  tracking: boolean;
  hover: (at: Point) => void;
  /** The move / turn the pointer would make now, drawn dashed over the picked items. */
  ghost: { indexes: readonly number[]; step: Affine } | null;
  angle: string;
  setAngle: (value: string) => void;
  canApplyAngle: boolean;
  applyAngle: () => void;
  // Unsaved edits
  edits: readonly CanvasEdit[];
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
/** Angles typed in the turn step: a number, comma or point decimals, optional sign. */
const ANGLE = /^[+-]?\d+([.,]\d+)?$/;

/** Degrees counter-clockwise from the base point to the point (0 = to the right, as CAD). */
const directionOf = (base: Point, at: Point) =>
  (Math.atan2(at.y - base.y, at.x - base.x) * 180) / Math.PI;

export function useCanvasEdit(input: Input): CanvasEditState {
  const { projectId, cadFileId, available, scene, preview, layers, isShown } = input;
  const saveMutation = useSaveCorrections(projectId, cadFileId);
  const [editing, setEditing] = useState(false);
  const [tool, setToolState] = useState<EditTool | null>(null);
  const [step, setStep] = useState<EditStep>('pick');
  const [chosen, setChosen] = useState<ReadonlySet<number>>(NONE);
  const [band, setBand] = useState<Band | null>(null);
  const [notText, setNotText] = useState(false);
  const [layer, setLayer] = useState('');
  const [text, setText] = useState('');
  const [base, setBase] = useState<Point | null>(null);
  const [pointer, setPointer] = useState<Point | null>(null);
  const [angle, setAngle] = useState('');
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

  const resetPick = () => {
    setChosen(NONE);
    setBand(null);
    setNotText(false);
    setLayer('');
    setText('');
    setStep('pick');
    setBase(null);
    setPointer(null);
    setAngle('');
  };

  const currentText = (index: number) =>
    preview?.textOf.get(index) ?? scene?.view.entities[index]?.texts[0]?.text ?? '';

  const handles = scene ? handlesOf(scene, chosen) : [];
  const several = tool === 'layer' || tool === 'move' || tool === 'rotate';
  const add = (added: CanvasEdit[]) => {
    setEdits((previous) => addEdits(previous, added));
    resetPick();
  };

  /** The second point fixes the move or the turn. */
  const finish = (at: Point) => {
    if (!base || handles.length === 0) return;
    if (tool === 'move') add(moveEdits(handles, at.x - base.x, at.y - base.y));
    else if (tool === 'rotate') add(rotateEdits(handles, base.x, base.y, directionOf(base, at)));
  };

  let ghost: CanvasEditState['ghost'] = null;
  if (step === 'second' && base && pointer && chosen.size > 0) {
    const stepAffine =
      tool === 'move'
        ? translation(pointer.x - base.x, pointer.y - base.y)
        : rotationAbout(base.x, base.y, directionOf(base, pointer));
    ghost = { indexes: [...chosen], step: stepAffine };
  }
  const typedAngle = angle.trim().replace(',', '.');
  const canApplyAngle =
    tool === 'rotate' &&
    base !== null &&
    ANGLE.test(angle.trim()) &&
    Math.abs(Number(typedAngle)) <= 360;

  return {
    available,
    editing,
    start: () => {
      setEditing(true);
      setError(null);
    },
    tool,
    setTool: (next) => {
      setToolState(next);
      resetPick();
    },
    step,
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
        finish(at);
        return;
      }
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
      const found = entitiesInBand(scene, picked, isShown, preview?.transformOf);
      setChosen((previous) => new Set([...(additive ? previous : NONE), ...found]));
    },
    notText,
    layers,
    layer,
    setLayer,
    applyLayer: () => {
      if (!layer || handles.length === 0) return;
      add(handles.map((handle) => ({ kind: 'move_layer', handle, toLayer: layer })));
    },
    text,
    setText,
    applyText: () => {
      const value = text.trim();
      const [handle] = handles;
      if (value.length === 0 || handle === undefined) return;
      add([{ kind: 'set_text', handle, text: value }]);
    },
    startPoints: () => {
      if (handles.length === 0) return;
      setStep('base');
      setBase(null);
      setPointer(null);
    },
    base,
    tracking: step === 'second',
    hover: (at) => {
      if (step === 'second') setPointer(at);
    },
    ghost,
    angle,
    setAngle,
    canApplyAngle,
    applyAngle: () => {
      if (!canApplyAngle || !base) return;
      add(rotateEdits(handles, base.x, base.y, Number(typedAngle)));
    },
    edits,
    save: () => {
      if (edits.length === 0) {
        setEditing(false);
        setToolState(null);
        resetPick();
        return;
      }
      setError(null);
      saveMutation.mutate(
        { items: editRequests(edits) },
        {
          onSuccess: () => {
            setEdits([]);
            setEditing(false);
            setToolState(null);
            resetPick();
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
      setToolState(null);
      setError(null);
      resetPick();
    },
    error,
  };
}
