'use client';

import { useCallback, useMemo, useState } from 'react';
import type { LonLat } from '@ftth/geo';
import { ltr } from '@ftth/i18n';
import { errorCodeOf, type ClientErrorCode } from '@/shared/api/bff-client';
import { useI18n } from '@/shared/i18n/locale-provider';
import {
  useAllBoxes,
  useBoxTypeState,
  useBoxTypesReport,
  useWorkOrderLines,
} from '@/features/box-types/api/queries';
import { boxLabelInputs } from '@/features/box-types/model/box-types-model';
import { useProject } from '@/features/projects/hooks/project-access-context';
import { useTrenchTool, type TrenchTool } from '@/features/installation/hooks/use-trench-tool';
import {
  useCorrections,
  useDesignRevision,
  useDrawingProblems,
  useDrawingView,
  useDrawingViewState,
  useRequestDrawingView,
} from '../api/queries';
import { pendingPlaces, routePieces } from '../model/corrections';
import { PathCache, type BoxLabel, type DrawModel } from '../model/drawing-draw';
import { buildMarkers, hitEntity, hitMarker, type ProblemMarker } from '../model/drawing-hit';
import { applyCorrections, defaultTextHeight, effectiveLayer } from '../model/drawing-preview';
import { boxOf, buildScene, type DrawingScene } from '../model/drawing-scene';
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
import { useMapping } from '@/features/cad-mapping/api/queries';
import { drawingToLonLat } from '../model/osm-backdrop';
import { useCanvasEdit, type CanvasEditState } from './use-canvas-edit';
import { useLayerScreen, type LayerScreen } from './use-layer-screen';
import { useFixTools, type FixTools } from './use-fix-tools';

export type WorkspaceDialog =
  | { kind: 'find' }
  | { kind: 'laywalk' }
  | { kind: 'attributes'; index: number }
  | { kind: 'table' };

/** A problem place the user asked to see on the drawing («اعرض الموضع على الرسمة»). */
export interface ShowPlace {
  code: ProblemMarker['code'] | null;
  handle: string;
  /** null: the viewer centres on the drawing entity of the handle (trench marks, checklist). */
  x: number | null;
  y: number | null;
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
  /** The colour on screen (the user's choice, else the drawing's). */
  color: string;
  shown: boolean;
  /** Screen only (ADR-051): a frozen layer is not drawn; a locked one cannot be picked. */
  frozen: boolean;
  locked: boolean;
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
  /** The edit mode of the canvas (ADR-047). */
  edit: CanvasEditState;
  /** «حفر جديد» and the trench marks of a General (ADR-042). */
  trench: TrenchTool;
  /** The type text next to each box of a Secondary (ADR-043). */
  boxTypes: {
    available: boolean;
    shown: boolean;
    setShown: (shown: boolean) => void;
    count: number;
  };
  // Layers
  layerRows: LayerRow[];
  layerQuery: string;
  setLayerQuery: (value: string) => void;
  toggleLayer: (index: number) => void;
  setShownForListed: (shown: boolean) => void;
  toggleFrozen: (index: number) => void;
  toggleLocked: (index: number) => void;
  setLayerColor: (index: number, color: string | null) => void;
  /** LAYER: the Layer Properties palette is asked for (changes on each request). */
  layersNonce: number;
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
  click: (sx: number, sy: number, additive?: boolean) => void;
  popover: ViewerPopover | null;
  closePopover: () => void;
  markerCount: number;
  /** The Layers panel on the screen: off, isolate, freeze, lock, states, fading. */
  layerScreen: LayerScreen;
  /** Dialogs of the workspace: FIND, Layer Walk, Edit Attributes (owner 2026-11-24). */
  dialog: WorkspaceDialog | null;
  setDialog: (dialog: WorkspaceDialog | null) => void;
  /** Centres an entity on the screen and marks it (FIND). */
  zoomToEntity: (index: number) => void;
  /** AutoCAD's object isolation, for the screen only (nothing is saved). */
  isolation: {
    active: boolean;
    /** Only these objects stay on the screen. */
    isolate: (indexes: ReadonlySet<number>) => void;
    /** These objects leave the screen. */
    hide: (indexes: ReadonlySet<number>) => void;
    end: () => void;
  };
  /** A right click in the edit mode: with nothing picked it picks the object under the pointer. */
  pickForMenu: (sx: number, sy: number) => void;
  /** The details panel of an object (the right-click «Properties»). */
  showProperties: (index: number) => void;
  /** OpenStreetMap under the drawing (owner 2026-11-24): loaded only once turned on. */
  osm: {
    /** Drawing point → Lon/Lat; null when the file has no CRS / unit mapping yet. */
    toLonLat: ((x: number, y: number) => LonLat) | null;
    shown: boolean;
    setShown: (shown: boolean) => void;
  };
  /** The error markers are drawn (the tab-strip toggle). */
  markersShown: boolean;
  setMarkersShown: (shown: boolean) => void;
}

interface Input {
  projectId: string;
  revisionId: string;
  cadFileId: string;
  enabled: boolean;
  /** design:write: may request the view, and the fix tools are offered. */
  canWrite: boolean;
  canFix: boolean;
  /** The drawing is a General: its trench marks are read and drawn. */
  isGeneral?: boolean;
  /** The drawing is a Secondary: the type text of its boxes is drawn (ADR-043). */
  isSecondary?: boolean;
  focus: ShowPlace | null;
}

const NO_ENTITIES: ReadonlySet<number> = new Set();
const NO_MARKERS: readonly ProblemMarker[] = [];

/** Where to look for a place: its own point, else the middle of the entities of its handle. */
function focusCentre(scene: DrawingScene, focus: ShowPlace): { x: number; y: number } | null {
  if (focus.x !== null && focus.y !== null) return { x: focus.x, y: focus.y };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const index of scene.byHandle.get(focus.handle) ?? []) {
    const box = boxOf(scene, index);
    minX = Math.min(minX, box.minX);
    minY = Math.min(minY, box.minY);
    maxX = Math.max(maxX, box.maxX);
    maxY = Math.max(maxY, box.maxY);
  }
  return minX === Infinity ? null : { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

/** State of the drawing viewer: status and data, layers, view transform, selection, preview. */
export function useDrawingViewer(input: Input): DrawingViewer {
  const { projectId, revisionId, cadFileId, enabled, canWrite, canFix, focus } = input;
  const { t } = useI18n();
  const stateQuery = useDrawingViewState(projectId, cadFileId, enabled);
  const status = stateQuery.data?.status;
  const viewQuery = useDrawingView(projectId, cadFileId, enabled && status === 'ready');
  const request = useRequestDrawingView(projectId, cadFileId);
  const problems = useDrawingProblems(projectId, revisionId, enabled);
  const corrections = useCorrections(projectId, cadFileId, enabled);
  const revisionQuery = useDesignRevision(projectId, revisionId, enabled);
  const revisionCreatedAt = revisionQuery.data?.createdAt ?? null;
  const tools = useFixTools(projectId, cadFileId, enabled && canFix, revisionCreatedAt);
  const trench = useTrenchTool({
    projectId,
    cadFileId,
    enabled: enabled && input.isGeneral === true,
    canEdit: canFix,
  });

  const { can } = useProject();
  const boxReport = useBoxTypesReport(projectId, revisionId, enabled && input.isSecondary === true);
  const boxesApply = boxReport.data?.applies === true;
  const boxes = useAllBoxes(projectId, revisionId, enabled && boxesApply);
  const liveBoxTypes = useBoxTypeState(
    projectId,
    cadFileId,
    enabled && boxesApply && can('cad_files:read'),
  );
  const orderLines = useWorkOrderLines(projectId, enabled && boxesApply && can('work_orders:read'));
  const [showBoxTypes, setShowBoxTypes] = useState(true);
  const boxLabels = useMemo<BoxLabel[]>(() => {
    if (!boxesApply || !boxes.data) return [];
    const live = liveBoxTypes.data
      ? new Map(
          liveBoxTypes.data.active.flatMap((choice) =>
            choice.workOrderLineId === null
              ? []
              : [[choice.shape, choice.workOrderLineId] as const],
          ),
        )
      : undefined;
    const lines = new Map(orderLines.lines.map((line) => [line.id, line] as const));
    return boxLabelInputs(boxes.data, live, lines).map((label) => ({
      x: label.x,
      y: label.y,
      kind: label.kind,
      lines:
        label.kind === 'none'
          ? [t('design.boxTypes.label.none')]
          : [
              ltr(label.code ?? '—'),
              ...(label.label ? [label.label] : []),
              ...(label.kind === 'pending' ? [t('design.boxTypes.label.pending')] : []),
            ],
    }));
  }, [boxesApply, boxes.data, liveBoxTypes.data, orderLines.lines, t]);

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
  // The error markers can be hidden from the drawing (owner 2026-11-24); nothing else changes.
  const [markersShown, setMarkersShown] = useState(true);
  const allMarkers = useMemo(
    () =>
      buildMarkers(
        problems.data?.items ?? [],
        pendingPlaces(corrections.data?.items ?? [], revisionCreatedAt),
      ),
    [problems.data, corrections.data, revisionCreatedAt],
  );
  const markers = markersShown ? allMarkers : NO_MARKERS;
  const [isolatedTo, setIsolatedTo] = useState<ReadonlySet<number> | null>(null);
  const [hiddenObjects, setHiddenObjects] = useState<ReadonlySet<number>>(NO_ENTITIES);
  const objectShown = useMemo(
    () =>
      isolatedTo === null && hiddenObjects.size === 0
        ? undefined
        : (index: number) =>
            (isolatedTo === null || isolatedTo.has(index)) && !hiddenObjects.has(index),
    [isolatedTo, hiddenObjects],
  );
  const mapping = useMapping(projectId, cadFileId, enabled);
  const toLonLat = useMemo(() => drawingToLonLat(mapping.data?.mapping), [mapping.data]);
  const [osmShown, setOsmShown] = useState(false);
  const mapBehind = osmShown && toLonLat !== null;

  // Layers: the view's `visible` is the start; the user's choices override it.
  const [overrides, setOverrides] = useState<ReadonlyMap<number, boolean>>(new Map());
  // Screen only (ADR-051): frozen and locked layers, and colours chosen for the screen.
  const [frozen, setFrozen] = useState<ReadonlySet<number>>(new Set());
  const [locked, setLocked] = useState<ReadonlySet<number>>(new Set());
  const [layerColor, setLayerColorMap] = useState<ReadonlyMap<number, string>>(new Map());
  const [layersNonce, setLayersNonce] = useState(0);
  const [layerQuery, setLayerQuery] = useState('');
  const layers = scene?.view.layers;
  const isShown = useCallback(
    (index: number) => {
      if (index < 0) return true;
      return (overrides.get(index) ?? layers?.[index]?.visible ?? true) && !frozen.has(index);
    },
    [overrides, layers, frozen],
  );
  const layerRows = useMemo<LayerRow[]>(
    () =>
      (layers ?? []).map((layer, index) => ({
        index,
        name: layer.name,
        color: layerColor.get(index) ?? layer.color,
        shown: overrides.get(index) ?? layer.visible,
        frozen: frozen.has(index),
        locked: locked.has(index),
      })),
    [layers, overrides, frozen, locked, layerColor],
  );
  const toggleIn =
    (set: (update: (previous: ReadonlySet<number>) => ReadonlySet<number>) => void) =>
    (index: number) =>
      set((previous) => {
        const next = new Set(previous);
        if (next.has(index)) next.delete(index);
        else next.add(index);
        return next;
      });
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

  const layerScreen = useLayerScreen({
    cadFileId,
    layerCount: layers?.length ?? 0,
    snapshot: { overrides, frozen, locked },
    apply: (s) => {
      setOverrides(s.overrides);
      setFrozen(s.frozen);
      setLocked(s.locked);
    },
  });
  const [dialog, setDialog] = useState<WorkspaceDialog | null>(null);

  const textHeight = defaultTextHeight(tools.metresPerUnit);
  const edit = useCanvasEdit({
    layerScreen,
    openDialog: setDialog,
    projectId,
    cadFileId,
    available: canFix && enabled,
    scene,
    preview,
    layers: tools.layers,
    // Picking asks per entity: its layer (after saved moves) must be drawn, and not locked.
    isShown: (index) =>
      scene !== null &&
      preview !== null &&
      (objectShown === undefined || objectShown(index)) &&
      isShown(effectiveLayer(scene, preview, index)),
    isLocked: (index) =>
      scene !== null && preview !== null && locked.has(effectiveLayer(scene, preview, index)),
    textHeight,
    onOpenLayers: () => setLayersNonce((n) => n + 1),
    ruledLayers: tools.ruledLayers,
  });
  const shownPreview = edit.preview;

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
    const at = focusCentre(scene, focus);
    if (at) setCustom(windowTransform(at.x, at.y, half, size));
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

  // Routes marked for trench: entity → «Trench: 25.000 m» (the sum of the marks in force).
  const trenchLabels = useMemo(() => {
    const labels = new Map<number, string>();
    if (!scene) return labels;
    for (const [handle, metres] of trench.byRoute) {
      for (const index of scene.byHandle.get(handle) ?? []) {
        labels.set(index, t('design.installation.tool.marked', { length: ltr(metres) }));
      }
    }
    return labels;
  }, [scene, trench.byRoute, t]);

  const model = useMemo<DrawModel | null>(
    () =>
      scene && shownPreview
        ? {
            scene,
            preview: shownPreview,
            layerShown: isShown,
            markers,
            highlighted,
            selected,
            trench: trenchLabels,
            boxLabels: showBoxTypes ? boxLabels : [],
            chosen: edit.chosen,
            band: edit.band,
            ghost: edit.ghost,
            sketch: edit.sketch,
            layerColor,
            noteHeight: textHeight,
            mapBehind,
            objectShown,
            lockedFade:
              layerScreen.fade.on && locked.size > 0
                ? { layers: locked, alpha: 1 - layerScreen.fade.percent / 100 }
                : undefined,
          }
        : null,
    [
      layerScreen.fade.on,
      layerScreen.fade.percent,
      locked,
      objectShown,
      mapBehind,
      layerColor,
      textHeight,
      edit.chosen,
      edit.band,
      edit.ghost,
      edit.sketch,
      scene,
      shownPreview,
      isShown,
      markers,
      highlighted,
      selected,
      trenchLabels,
      boxLabels,
      showBoxTypes,
    ],
  );

  const click = (sx: number, sy: number, additive = false) => {
    if (!scene || !shownPreview) return;
    // Between commands an error mark still opens its fix tools.
    const onMarker =
      edit.editing && edit.command === null
        ? hitMarker(markers, transform, size, sx, sy, MARKER_HIT_PX)
        : null;
    if (edit.editing && !onMarker) {
      const world = toWorld(transform, size, sx, sy);
      const hit = hitEntity(
        scene,
        world.x,
        world.y,
        ENTITY_HIT_PX / transform.scale,
        (index) =>
          !shownPreview.erased.has(index) && isShown(effectiveLayer(scene, shownPreview, index)),
        shownPreview.transformOf,
        shownPreview.curveOf,
      );
      edit.pick(hit, world, additive);
      // Between commands a click also shows the item and its error as in the normal view
      // (owner 2026-11-19); while a command runs the click only answers the command.
      if (edit.command === null && hit !== null) {
        const handle = scene.view.entities[hit]?.handle ?? '';
        const related =
          markers.find((m) => routePieces(m.handle).includes(handle) || m.handle === handle) ??
          null;
        setSelected(hit);
        setPopover({ x: world.x, y: world.y, entity: hit, marker: related });
      } else {
        setPopover(null);
        setSelected(null);
      }
      return;
    }
    const marker = hitMarker(markers, transform, size, sx, sy, MARKER_HIT_PX);
    if (marker) {
      setSelected(null);
      setPopover({ x: marker.x, y: marker.y, entity: null, marker });
      return;
    }
    const world = toWorld(transform, size, sx, sy);
    const entity = hitEntity(
      scene,
      world.x,
      world.y,
      ENTITY_HIT_PX / transform.scale,
      (index) =>
        !shownPreview.erased.has(index) && isShown(effectiveLayer(scene, shownPreview, index)),
      shownPreview.transformOf,
      shownPreview.curveOf,
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
    edit,
    trench,
    boxTypes: {
      available: boxLabels.length > 0,
      shown: showBoxTypes,
      setShown: setShowBoxTypes,
      count: boxLabels.length,
    },
    layerRows,
    layerQuery,
    setLayerQuery,
    toggleLayer,
    setShownForListed,
    toggleFrozen: toggleIn(setFrozen),
    toggleLocked: toggleIn(setLocked),
    setLayerColor: (index, color) =>
      setLayerColorMap((previous) => {
        const next = new Map(previous);
        if (color === null) next.delete(index);
        else next.set(index, color);
        return next;
      }),
    layersNonce,
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
    markerCount: allMarkers.length,
    markersShown,
    setMarkersShown,
    osm: { toLonLat, shown: mapBehind, setShown: setOsmShown },
    layerScreen,
    dialog,
    setDialog,
    zoomToEntity: (index) => {
      if (!scene) return;
      const box = boxOf(scene, index);
      const half = Math.max((box.maxX - box.minX) / 2, (box.maxY - box.minY) / 2, 1) * 3;
      setCustom(windowTransform((box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2, half, size));
      setSelected(index);
    },
    isolation: {
      active: objectShown !== undefined,
      isolate: (indexes) => {
        setIsolatedTo(new Set(indexes));
        setHiddenObjects(NO_ENTITIES);
      },
      hide: (indexes) => setHiddenObjects((previous) => new Set([...previous, ...indexes])),
      end: () => {
        setIsolatedTo(null);
        setHiddenObjects(NO_ENTITIES);
      },
    },
    pickForMenu: (sx, sy) => {
      if (!scene || !shownPreview || !edit.editing || edit.command !== null) return;
      if (edit.chosenCount > 0) return;
      const world = toWorld(transform, size, sx, sy);
      const hit = hitEntity(
        scene,
        world.x,
        world.y,
        ENTITY_HIT_PX / transform.scale,
        (index) =>
          !shownPreview.erased.has(index) &&
          (objectShown === undefined || objectShown(index)) &&
          isShown(effectiveLayer(scene, shownPreview, index)),
        shownPreview.transformOf,
        shownPreview.curveOf,
      );
      if (hit !== null) edit.pick(hit, world, false);
    },
    showProperties: (index) => {
      if (!scene) return;
      const box = boxOf(scene, index);
      setSelected(index);
      setPopover({
        x: (box.minX + box.maxX) / 2,
        y: (box.minY + box.maxY) / 2,
        entity: index,
        marker: null,
      });
    },
  };
}
