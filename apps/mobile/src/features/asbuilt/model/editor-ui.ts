import {
  distance,
  polylineLength,
  type Grip,
  type Point,
  type Polyline,
  type SnapResult,
} from '@ftth/geo';
import { GeometryError } from '@ftth/geo';
import type { PointFeatureType } from '@ftth/shared';
import {
  addDraftVertex,
  ALLOWED_SYMBOL_TYPES,
  canFinishRoute,
  deleteVertex,
  EditorError,
  editorFeatures,
  finishRoute,
  gripsFor,
  hitGrip,
  insertSymbol,
  insertVertexAt,
  moveGrip,
  moveSymbol,
  pickFeature,
  previewGrip,
  redo,
  setLabel,
  snapCursor,
  startEditor,
  undo,
  type AsBuiltTool,
  type EditorContext,
  type EditorErrorCode,
  type EditorSession,
} from './editor';

/**
 * Pointer-level behaviour of the tools: what a finger down / move / up / tap does per tool. Pure
 * and framework-free, so the screen only forwards touches (no business logic in components).
 */

/** Pixels a finger may travel and still count as a tap. */
export const TAP_SLOP_PX = 8;

export type Drag =
  | {
      kind: 'symbol';
      id: string;
      start: Point;
      at: Point;
      snapped: SnapResult | null;
      moved: boolean;
    }
  | {
      kind: 'grip';
      routeId: string;
      grip: Grip;
      start: Point;
      at: Point;
      snapped: SnapResult | null;
      moved: boolean;
    };

export interface EditorUi {
  tool: AsBuiltTool;
  session: EditorSession;
  selectedId: string | null;
  /** Vertex selected by a tap on its grip (deleted by the «delete vertex» button). */
  selectedVertex: number | null;
  symbolType: PointFeatureType;
  drag: Drag | null;
  error: EditorErrorCode | null;
}

export function startEditorUi(): EditorUi {
  return {
    tool: 'reshape',
    session: startEditor(),
    selectedId: null,
    selectedVertex: null,
    symbolType: ALLOWED_SYMBOL_TYPES[0] ?? 'box',
    drag: null,
    error: null,
  };
}

export function errorCodeOf(error: unknown): EditorErrorCode | 'TOO_FEW_VERTICES' | 'INVALID_OP' {
  if (error instanceof EditorError) return error.code;
  if (error instanceof GeometryError && error.code === 'TOO_FEW_VERTICES')
    return 'TOO_FEW_VERTICES';
  return 'INVALID_OP';
}

/** Runs one change; a refused change leaves the session as it was and records why. */
function attempt(ui: EditorUi, change: () => EditorUi): EditorUi {
  try {
    return { ...change(), error: null };
  } catch (error) {
    const code = errorCodeOf(error);
    return { ...ui, drag: null, error: code === 'TOO_FEW_VERTICES' ? 'NEED_TWO_VERTICES' : code };
  }
}

export function setTool(ui: EditorUi, tool: AsBuiltTool): EditorUi {
  if (tool === ui.tool) return ui;
  return { ...ui, tool, selectedId: null, selectedVertex: null, drag: null, error: null };
}

export function chooseSymbolType(ui: EditorUi, symbolType: PointFeatureType): EditorUi {
  return { ...ui, symbolType, error: null };
}

export interface Pointer {
  /** Position in project-CRS metres. */
  world: Point;
  metresPerPixel: number;
}

/**
 * Finger down. Returns `grabbed = true` when it took hold of a symbol (move tool) or a grip
 * (reshape tool); otherwise the screen pans and a short touch becomes a tap.
 */
export function pointerDown(
  ctx: EditorContext,
  ui: EditorUi,
  { world, metresPerPixel }: Pointer,
): { ui: EditorUi; grabbed: boolean } {
  if (ui.tool === 'move') {
    const hit = pickFeature(ctx, ui.session, world, metresPerPixel, 'symbol');
    if (hit?.at) {
      return {
        grabbed: true,
        ui: {
          ...ui,
          selectedId: hit.id,
          error: null,
          drag: {
            kind: 'symbol',
            id: hit.id,
            start: hit.at,
            at: hit.at,
            snapped: null,
            moved: false,
          },
        },
      };
    }
  }
  if (ui.tool === 'reshape' && ui.selectedId) {
    try {
      const grip = hitGrip(gripsFor(ctx, ui.session, ui.selectedId), world, metresPerPixel);
      if (grip) {
        return {
          grabbed: true,
          ui: {
            ...ui,
            error: null,
            drag: {
              kind: 'grip',
              routeId: ui.selectedId,
              grip,
              start: grip.at,
              at: grip.at,
              snapped: null,
              moved: false,
            },
          },
        };
      }
    } catch {
      // The selected feature is not a route (anymore): nothing to grab.
    }
  }
  return { ui, grabbed: false };
}

/** Finger moved while holding a symbol or grip: follows the finger and snaps within 14 px. */
export function pointerMove(
  ctx: EditorContext,
  ui: EditorUi,
  { world, metresPerPixel }: Pointer,
): EditorUi {
  const drag = ui.drag;
  if (!drag) return ui;
  const exclude =
    drag.kind === 'symbol'
      ? { featureId: drag.id }
      : drag.grip.kind === 'vertex'
        ? { featureId: drag.routeId, vertexIndex: drag.grip.vertexIndex }
        : { featureId: drag.routeId };
  const { point, snapped } = snapCursor(ctx, ui.session, world, metresPerPixel, exclude);
  const moved = drag.moved || distance(world, drag.start) > TAP_SLOP_PX * metresPerPixel;
  return { ...ui, drag: { ...drag, at: point, snapped, moved } };
}

/** Finger up: a drag ends as one history step; a touch without travel on a vertex selects it. */
export function pointerUp(ctx: EditorContext, ui: EditorUi): EditorUi {
  const drag = ui.drag;
  if (!drag) return ui;
  const cleared = { ...ui, drag: null };
  if (!drag.moved) {
    return drag.kind === 'grip' && drag.grip.kind === 'vertex'
      ? { ...cleared, selectedVertex: drag.grip.vertexIndex }
      : cleared;
  }
  return attempt(ui, () => {
    if (drag.kind === 'symbol') {
      return { ...cleared, session: moveSymbol(ctx, ui.session, drag.id, drag.at) };
    }
    const { grip, routeId, at } = drag;
    const session =
      grip.kind === 'vertex'
        ? moveGrip(ctx, ui.session, routeId, grip.vertexIndex, at)
        : insertVertexAt(ctx, ui.session, routeId, grip.segmentIndex, at);
    return { ...cleared, session, selectedVertex: null };
  });
}

/** A short touch that did not grab anything. */
export function tap(
  ctx: EditorContext,
  ui: EditorUi,
  { world, metresPerPixel }: Pointer,
  newId: () => string,
): EditorUi {
  switch (ui.tool) {
    case 'move':
      return ui;
    case 'reshape': {
      const route = pickFeature(ctx, ui.session, world, metresPerPixel, 'route');
      return { ...ui, selectedId: route?.id ?? null, selectedVertex: null, error: null };
    }
    case 'label': {
      const hit =
        pickFeature(ctx, ui.session, world, metresPerPixel, 'symbol') ??
        pickFeature(ctx, ui.session, world, metresPerPixel, 'route');
      return { ...ui, selectedId: hit?.id ?? null, error: null };
    }
    case 'draw':
      return attempt(ui, () => ({
        ...ui,
        session: addDraftVertex(
          ui.session,
          snapCursor(ctx, ui.session, world, metresPerPixel).point,
        ),
      }));
    case 'symbol':
      return attempt(ui, () => {
        const at = snapCursor(ctx, ui.session, world, metresPerPixel).point;
        const id = newId();
        return { ...ui, session: insertSymbol(ui.session, ui.symbolType, at, id), selectedId: id };
      });
  }
}

export function deleteSelectedVertex(ctx: EditorContext, ui: EditorUi): EditorUi {
  const { selectedId, selectedVertex } = ui;
  if (selectedId === null || selectedVertex === null) return ui;
  return attempt(ui, () => ({
    ...ui,
    session: deleteVertex(ctx, ui.session, selectedId, selectedVertex),
    selectedVertex: null,
  }));
}

export function finishDrawing(ui: EditorUi, newId: string): EditorUi {
  return attempt(ui, () => ({
    ...ui,
    session: finishRoute(ui.session, newId),
    selectedId: newId,
  }));
}

export function applyLabelText(ctx: EditorContext, ui: EditorUi, text: string): EditorUi {
  const { selectedId } = ui;
  if (selectedId === null) return ui;
  return attempt(ui, () => ({ ...ui, session: setLabel(ctx, ui.session, selectedId, text) }));
}

export function undoUi(ui: EditorUi): EditorUi {
  return { ...ui, session: undo(ui.session), drag: null, selectedVertex: null, error: null };
}

export function redoUi(ui: EditorUi): EditorUi {
  return { ...ui, session: redo(ui.session), drag: null, selectedVertex: null, error: null };
}

export function canFinish(ui: EditorUi): boolean {
  return ui.tool === 'draw' && canFinishRoute(ui.session);
}

/** The route whose length is shown live: the dragged preview, the draft, or the selected route. */
export function liveRoute(ctx: EditorContext, ui: EditorUi): Polyline | null {
  if (ui.drag?.kind === 'grip') {
    return previewGrip(ctx, ui.session, ui.drag.routeId, ui.drag.grip, ui.drag.at);
  }
  if (ui.tool === 'draw') return ui.session.draft.length >= 2 ? ui.session.draft : null;
  if (!ui.selectedId) return null;
  const f = editorFeatures(ctx, ui.session).find((candidate) => candidate.id === ui.selectedId);
  return f?.route ?? null;
}

/** Length shown next to the drawing, in metres: exactly `polylineLength` of the live route. */
export function liveLengthM(ctx: EditorContext, ui: EditorUi): number | null {
  const route = liveRoute(ctx, ui);
  return route ? polylineLength(route) : null;
}
