'use client';

import { useEffect, useState } from 'react';
import { errorCodeOf, errorReasonOf } from '@/shared/api/bff-client';
import { useSaveCorrections } from '../api/queries';
import {
  addEdits,
  editRequests,
  entitiesInBand,
  handlesOf,
  isTextEntity,
  type Band,
  type CanvasEdit,
  type EditTool,
} from '../model/canvas-edit';
import { correctionError } from '../model/corrections';
import type { DrawingPreview } from '../model/drawing-preview';
import type { DrawingScene } from '../model/drawing-scene';
import type { ErrorMessage } from '../model/revision-errors';

/** The drawing's edit mode (ADR-047): pen → tools → pick items → change → «حفظ» or «إلغاء». */
export interface CanvasEditState {
  /** The project manager may edit (draft revision and design:write). */
  available: boolean;
  editing: boolean;
  start: () => void;
  tool: EditTool | null;
  setTool: (tool: EditTool | null) => void;
  /** Entities picked with the current tool. */
  chosen: ReadonlySet<number>;
  /** Handles of the picked entities (an INSERT counts once). */
  chosenCount: number;
  clearChosen: () => void;
  /** A click on the canvas while a tool is on: returns false when no tool takes clicks. */
  pick: (entity: number | null, additive: boolean) => boolean;
  /** Box selection while the layer tool is on. */
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

export function useCanvasEdit(input: Input): CanvasEditState {
  const { projectId, cadFileId, available, scene, preview, layers, isShown } = input;
  const saveMutation = useSaveCorrections(projectId, cadFileId);
  const [editing, setEditing] = useState(false);
  const [tool, setToolState] = useState<EditTool | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<number>>(NONE);
  const [band, setBand] = useState<Band | null>(null);
  const [notText, setNotText] = useState(false);
  const [layer, setLayer] = useState('');
  const [text, setText] = useState('');
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
  };

  const currentText = (index: number) =>
    preview?.textOf.get(index) ?? scene?.view.entities[index]?.texts[0]?.text ?? '';

  const handles = scene ? handlesOf(scene, chosen) : [];

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
    chosen,
    chosenCount: handles.length,
    clearChosen: resetPick,
    pick: (entity, additive) => {
      if (!editing || tool === null || !scene) return false;
      setError(null);
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
        return true;
      }
      if (entity === null) {
        if (!additive) setChosen(NONE);
        return true;
      }
      setChosen((previous) => {
        const next = new Set(additive ? previous : NONE);
        if (additive && previous.has(entity)) next.delete(entity);
        else next.add(entity);
        return next;
      });
      return true;
    },
    band,
    setBand,
    pickBand: (picked, additive) => {
      setBand(null);
      if (!scene || tool !== 'layer') return;
      const found = entitiesInBand(scene, picked, isShown);
      setChosen((previous) => new Set([...(additive ? previous : NONE), ...found]));
    },
    notText,
    layers,
    layer,
    setLayer,
    applyLayer: () => {
      if (!layer || handles.length === 0) return;
      setEdits((previous) =>
        addEdits(
          previous,
          handles.map((handle) => ({ kind: 'move_layer', handle, toLayer: layer })),
        ),
      );
      resetPick();
    },
    text,
    setText,
    applyText: () => {
      const value = text.trim();
      const [handle] = handles;
      if (value.length === 0 || handle === undefined) return;
      setEdits((previous) => addEdits(previous, [{ kind: 'set_text', handle, text: value }]));
      resetPick();
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
