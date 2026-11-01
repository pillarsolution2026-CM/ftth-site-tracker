import { useCallback, useMemo, useRef, useState } from 'react';
import type { GpsFix, PointFeatureType } from '@ftth/shared';
import { useField } from '../../sync/hooks/FieldProvider';
import { buildAsBuiltState, type AsBuiltState } from '../model/asbuilt-state';
import {
  buildOps,
  canRedo,
  canUndo,
  hasChanges,
  staleFeatures,
  type AsBuiltTool,
  type EditorContext,
} from '../model/editor';
import {
  applyLabelText,
  canFinish,
  chooseSymbolType,
  deleteSelectedVertex,
  errorCodeOf,
  finishDrawing,
  liveLengthM,
  pointerDown,
  pointerMove,
  pointerUp,
  redoUi,
  setTool,
  startEditorUi,
  tap,
  undoUi,
  type EditorUi,
  type Pointer,
} from '../model/editor-ui';

/** Device services of the As-Built tools; the app wires the native ones. */
export interface AsBuiltDeps {
  newId(): string;
  now(): Date;
  /** One GPS fix as evidence, or null; never blocks saving for long. */
  locate(): Promise<GpsFix | null>;
}

/** GPS is evidence only: wait a few seconds at most so a normal update stays fast. */
const GPS_WAIT_MS = 3000;

export function useAsBuiltEditor(deps: AsBuiltDeps) {
  const { bundle, entries, asBuiltEdits, userId, recordAsBuilt } = useField();
  const [ui, setUiState] = useState<EditorUi>(startEditorUi);
  const uiRef = useRef(ui);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedCount, setSavedCount] = useState(0);
  const [note, setNote] = useState('');

  const state: AsBuiltState | null = useMemo(
    () =>
      bundle ? buildAsBuiltState({ bundle, remoteEdits: asBuiltEdits, entries, userId }) : null,
    [asBuiltEdits, bundle, entries, userId],
  );
  const ctx: EditorContext | null = useMemo(
    () => (state ? { state, revisionId: bundle?.revision?.id ?? null } : null),
    [bundle, state],
  );
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const commit = useCallback((next: EditorUi) => {
    uiRef.current = next;
    setUiState(next);
  }, []);

  /** Runs a model change on the latest state. */
  const run = useCallback(
    (change: (context: EditorContext, current: EditorUi) => EditorUi) => {
      const context = ctxRef.current;
      if (context) commit(change(context, uiRef.current));
    },
    [commit],
  );

  const handlers = useMemo(
    () => ({
      setTool: (tool: AsBuiltTool) => commit(setTool(uiRef.current, tool)),
      chooseSymbol: (type: PointFeatureType) => commit(chooseSymbolType(uiRef.current, type)),
      /** Returns true when the touch took hold of a symbol or grip (else the screen pans). */
      down: (pointer: Pointer): boolean => {
        const context = ctxRef.current;
        if (!context) return false;
        const result = pointerDown(context, uiRef.current, pointer);
        commit(result.ui);
        return result.grabbed;
      },
      move: (pointer: Pointer) => run((context, current) => pointerMove(context, current, pointer)),
      up: () => run((context, current) => pointerUp(context, current)),
      tap: (pointer: Pointer) =>
        run((context, current) => tap(context, current, pointer, () => deps.newId())),
      deleteVertex: () => run((context, current) => deleteSelectedVertex(context, current)),
      finish: () => run((_context, current) => finishDrawing(current, deps.newId())),
      applyLabel: (text: string) =>
        run((context, current) => applyLabelText(context, current, text)),
      undo: () => commit(undoUi(uiRef.current)),
      redo: () => commit(redoUi(uiRef.current)),
      reset: () => {
        commit(startEditorUi());
        setNote('');
        setSaveError(null);
      },
    }),
    [commit, deps, run],
  );

  const save = useCallback(async (): Promise<boolean> => {
    const context = ctxRef.current;
    if (!context || saving) return false;
    setSaving(true);
    setSaveError(null);
    try {
      let gps: GpsFix | null = null;
      try {
        gps = await Promise.race([
          deps.locate(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), GPS_WAIT_MS)),
        ]);
      } catch {
        gps = null;
      }
      const ops = buildOps(context, uiRef.current.session, {
        newClientOpId: () => deps.newId(),
        now: deps.now(),
        note,
        gps,
      });
      try {
        await recordAsBuilt(ops);
      } catch {
        setSaveError('SAVE_FAILED');
        return false;
      }
      setSavedCount(ops.length);
      handlers.reset();
      return true;
    } catch (error) {
      setSaveError(errorCodeOf(error));
      return false;
    } finally {
      setSaving(false);
    }
  }, [deps, handlers, note, recordAsBuilt, saving]);

  const session = ui.session;
  const stale = ctx ? staleFeatures(ctx, session) : [];
  return {
    ui,
    ctx,
    state,
    handlers,
    save,
    saving,
    saveError,
    savedCount,
    note,
    setNote,
    stale,
    canUndo: canUndo(session),
    canRedo: canRedo(session),
    canSave: ctx !== null && hasChanges(ctx, session) && stale.length === 0 && !saving,
    canFinish: canFinish(ui),
    lengthM: ctx ? liveLengthM(ctx, ui) : null,
  };
}

export type AsBuiltEditor = ReturnType<typeof useAsBuiltEditor>;
