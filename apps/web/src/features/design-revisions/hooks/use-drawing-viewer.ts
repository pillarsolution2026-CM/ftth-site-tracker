'use client';

import { useCallback, useMemo, useState } from 'react';
import { errorCodeOf, type ClientErrorCode } from '@/shared/api/bff-client';
import {
  useCorrections,
  useDrawingProblems,
  useDrawingView,
  useDrawingViewState,
  useRequestDrawingView,
} from '../api/queries';
import { pendingPlaces, routePieces } from '../model/corrections';
import { PathCache, type DrawModel } from '../model/drawing-draw';
import { buildMarkers, hitEntity, hitMarker, type ProblemMarker } from '../model/drawing-hit';
import { applyCorrections, defaultTextHeight, effectiveLayer } from '../model/drawing-preview';
import { buildScene, type DrawingScene } from '../model/drawing-scene';
import {
  fitTransform,
  panBy,
  scaleLimits,
  toWorld,
  windowTransform,
  zoomAt,
  ZOOM_STEP,
  type Size,
  type ViewTransform,
} from '../model/view-transform';
import { useFixTools, type FixTools } from './use-fix-tools';

/** A problem place the user asked to see on the drawing («اعرض الموضع على الرسمة»). */
export interface ShowPlace {
  code: ProblemMarker['code'];
  handle: string;
  x: number;
  y: number;
  /** Changes on every request, so asking for the same place again zooms again. */
  nonce: number;
}

/** Window shown around a place, in metres (each side of the place: half of it). */
export const FOCUS_WINDOW_M = 60;
/** The same window in drawing units when the file's metres per unit is not known. */
export const FOCUS_WINDOW_UNITS = 60;
const MARKER_HIT_PX = 14;
const ENTITY_HIT_PX = 6;

export type ViewerStatus =
  'loading' | 'error' | 'none' | 'failed' | 'queued' | 'loadingView' | 'viewError' | 'ready';

export interface ViewerPopover {
  /** Where it hangs: a drawing point, so it follows pan and zoom. */
  x: number;
  y: number;
  entity: number | null;
  marker: ProblemMarker | null;
}

export interface LayerRow {
  index: number;
  name: string;
  color: string;
  shown: boolean;
}

export interface DrawingViewer {
  status: ViewerStatus;
  errorCode: ClientErrorCode | null;
  canRequest: boolean;
  requesting: boolean;
  requestView: () => void;
  truncated: boolean;
  model: DrawModel | null;
  cache: PathCache | null;
  scene: DrawingScene | null;
  tools: FixTools;
  // Layers
  layerRows: LayerRow[];
  layerQuery: string;
  setLayerQuery: (value: string) => void;
  toggleLayer: (index: number) => void;
  setShownForListed: (shown: boolean) => void;
  // View
  size: Size;
  setSize: (size: Size) => void;
  transform: ViewTransform;
  /** The content follows the pointer by (dx, dy) screen pixels. */
  pan: (dx: number, dy: number) => void;
  /** Two-finger gesture: zoom about a point and move it by (dx, dy). */
  gesture: (sx: number, sy: number, factor: number, dx: number, dy: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomBy: (sx: number, sy: number, factor: number) => void;
  fit: () => void;
  // Selection
  click: (sx: number, sy: number) => void;
  popover: ViewerPopover | null;
  closePopover: () => void;
  markerCount: number;
}

interface Input {
  projectId: string;
  revisionId: string;
  cadFileId: string;
  enabled: boolean;
  /** design:write: may request the view, and the fix tools are offered. */
  canWrite: boolean;
  canFix: boolean;
  focus: ShowPlace | null;
}

const NO_ENTITIES: ReadonlySet<number> = new Set();

/** State of the drawing viewer: status and data, layers, view transform, selection, preview. */
export function useDrawingViewer(input: Input): DrawingViewer {
  const { projectId, revisionId, cadFileId, enabled, canWrite, canFix, focus } = input;
  const stateQuery = useDrawingViewState(projectId, cadFileId, enabled);
  const status = stateQuery.data?.status;
  const viewQuery = useDrawingView(projectId, cadFileId, enabled && status === 'ready');
  const request = useRequestDrawingView(projectId, cadFileId);
  const problems = useDrawingProblems(projectId, revisionId, enabled);
  const corrections = useCorrections(projectId, cadFileId, enabled);
  const tools = useFixTools(projectId, cadFileId, enabled && canFix);

  const scene = useMemo(
    () => (viewQuery.data ? buildScene(viewQuery.data) : null),
    [viewQuery.data],
  );
  const cache = useMemo(() => (scene ? new PathCache(scene) : null), [scene]);
  const preview = useMemo(
    () =>
      scene
        ? applyCorrections(
            scene,
            corrections.data?.items ?? [],
            defaultTextHeight(tools.metresPerUnit),
          )
        : null,
    [scene, corrections.data, tools.metresPerUnit],
  );
  const markers = useMemo(
    () => buildMarkers(problems.data?.items ?? [], pendingPlaces(corrections.data?.items ?? [])),
    [problems.data, corrections.data],
  );

  // Layers: the view's `visible` is the start; the user's choices override it.
  const [overrides, setOverrides] = useState<ReadonlyMap<number, boolean>>(new Map());
  const [layerQuery, setLayerQuery] = useState('');
  const layers = scene?.view.layers;
  const isShown = useCallback(
    (index: number) => {
      if (index < 0) return true;
      return overrides.get(index) ?? layers?.[index]?.visible ?? true;
    },
    [overrides, layers],
  );
  const layerRows = useMemo<LayerRow[]>(
    () =>
      (layers ?? []).map((layer, index) => ({
        index,
        name: layer.name,
        color: layer.color,
        shown: overrides.get(index) ?? layer.visible,
      })),
    [layers, overrides],
  );
  const toggleLayer = useCallback(
    (index: number) =>
      setOverrides((previous) => {
        const now = previous.get(index) ?? layers?.[index]?.visible ?? true;
        return new Map(previous).set(index, !now);
      }),
    [layers],
  );
  const setShownForListed = useCallback(
    (shown: boolean) => {
      const needle = layerQuery.trim().toLowerCase();
      setOverrides((previous) => {
        const next = new Map(previous);
        (layers ?? []).forEach((layer, index) => {
          if (needle === '' || layer.name.toLowerCase().includes(needle)) next.set(index, shown);
        });
        return next;
      });
    },
    [layers, layerQuery],
  );

  // View transform: null = "fit all", so a resize refits until the user zooms or pans.
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const [custom, setCustom] = useState<ViewTransform | null>(null);
  const fitted = useMemo(
    () =>
      scene
        ? fitTransform(scene.view.extents, size)
        : ({ cx: 0, cy: 0, scale: 1 } satisfies ViewTransform),
    [scene, size],
  );
  const limits = useMemo(() => scaleLimits(fitted), [fitted]);
  const transform = custom ?? fitted;

  // Selection, highlight and the floating panel.
  const [selected, setSelected] = useState<number | null>(null);
  const [popover, setPopover] = useState<ViewerPopover | null>(null);
  const [highlightNonce, setHighlightNonce] = useState<number | null>(null);
  const [appliedNonce, setAppliedNonce] = useState<number | null>(null);

  // A new «show on drawing» request (adjusting state during render, not in an effect).
  if (focus !== null && scene !== null && size.width > 0 && appliedNonce !== focus.nonce) {
    const half =
      tools.metresPerUnit !== null
        ? FOCUS_WINDOW_M / 2 / tools.metresPerUnit
        : FOCUS_WINDOW_UNITS / 2;
    setAppliedNonce(focus.nonce);
    setHighlightNonce(focus.nonce);
    setCustom(windowTransform(focus.x, focus.y, half, size));
    setSelected(null);
    setPopover(null);
  }

  const highlighted = useMemo<ReadonlySet<number>>(() => {
    if (!scene || focus === null || highlightNonce !== focus.nonce) return NO_ENTITIES;
    const found = new Set<number>();
    for (const handle of routePieces(focus.handle)) {
      for (const index of scene.byHandle.get(handle) ?? []) found.add(index);
    }
    if (found.size === 0) {
      for (const index of scene.byHandle.get(focus.handle) ?? []) found.add(index);
    }
    return found;
  }, [scene, focus, highlightNonce]);

  const model = useMemo<DrawModel | null>(
    () =>
      scene && preview
        ? {
            scene,
            preview,
            layerShown: isShown,
            markers,
            highlighted,
            selected,
          }
        : null,
    [scene, preview, isShown, markers, highlighted, selected],
  );

  const click = (sx: number, sy: number) => {
    if (!scene || !preview) return;
    const marker = hitMarker(markers, transform, size, sx, sy, MARKER_HIT_PX);
    if (marker) {
      setSelected(null);
      setPopover({ x: marker.x, y: marker.y, entity: null, marker });
      return;
    }
    const world = toWorld(transform, size, sx, sy);
    const entity = hitEntity(scene, world.x, world.y, ENTITY_HIT_PX / transform.scale, (index) =>
      isShown(effectiveLayer(scene, preview, index)),
    );
    if (entity === null) {
      setSelected(null);
      setPopover(null);
      setHighlightNonce(null);
      return;
    }
    const handle = scene.view.entities[entity]?.handle ?? '';
    const related =
      markers.find((m) => routePieces(m.handle).includes(handle) || m.handle === handle) ?? null;
    setSelected(entity);
    setPopover({ x: world.x, y: world.y, entity, marker: related });
  };

  const zoomBy = (sx: number, sy: number, factor: number) =>
    setCustom((previous) => zoomAt(previous ?? fitted, size, sx, sy, factor, limits));
  const pan = (dx: number, dy: number) =>
    setCustom((previous) => panBy(previous ?? fitted, dx, dy));
  const gesture = (sx: number, sy: number, factor: number, dx: number, dy: number) =>
    setCustom((previous) =>
      panBy(zoomAt(previous ?? fitted, size, sx, sy, factor, limits), dx, dy),
    );
  const stateError = stateQuery.error ?? null;
  let resolved: ViewerStatus;
  if (stateError) resolved = 'error';
  else if (!status) resolved = 'loading';
  else if (status === 'ready') {
    resolved = viewQuery.isError ? 'viewError' : viewQuery.data ? 'ready' : 'loadingView';
  } else resolved = status;

  return {
    status: resolved,
    errorCode: stateError
      ? errorCodeOf(stateError)
      : viewQuery.error
        ? errorCodeOf(viewQuery.error)
        : request.error
          ? errorCodeOf(request.error)
          : null,
    canRequest: canWrite,
    requesting: request.isPending,
    requestView: () => request.mutate(),
    truncated: scene?.view.truncated ?? false,
    model,
    cache,
    scene,
    tools,
    layerRows,
    layerQuery,
    setLayerQuery,
    toggleLayer,
    setShownForListed,
    size,
    setSize,
    transform,
    pan,
    gesture,
    zoomIn: () => zoomBy(size.width / 2, size.height / 2, ZOOM_STEP),
    zoomOut: () => zoomBy(size.width / 2, size.height / 2, 1 / ZOOM_STEP),
    zoomBy,
    fit: () => setCustom(null),
    click,
    popover,
    closePopover: () => {
      setPopover(null);
      setSelected(null);
    },
    markerCount: markers.length,
  };
}
