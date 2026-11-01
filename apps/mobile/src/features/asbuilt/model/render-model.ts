import type { Grip, Point } from '@ftth/geo';
import type { AsBuiltGeometry, FeatureType } from '@ftth/shared';
import { editorFeatures, gripsFor, type EditorContext } from './editor';
import { liveRoute, type EditorUi } from './editor-ui';

/**
 * What the As-Built canvas draws, in project-CRS metres (the component only projects to pixels).
 * Meaning is never colour alone: styles map to dash pattern, marker glyph and a text label.
 */
export type DrawStyle =
  /** Unchanged: As-Built equals the design, drawn once in the feature colour. */
  | 'design'
  /** Approved As-Built geometry (or an approved added feature), in the As-Built colour. */
  | 'approved'
  /** My own edit waiting for approval (marked with a glyph). */
  | 'pending'
  /** Changed in the open session, not saved yet. */
  | 'session';

export interface DrawnFeature {
  id: string;
  type: FeatureType;
  kind: 'route' | 'symbol';
  coords: readonly (readonly [number, number])[];
  style: DrawStyle;
  text: string | null;
  /** The text itself is As-Built (changed), drawn in the As-Built colour. */
  textIsAsBuilt: boolean;
  selected: boolean;
}

export interface DrawnDesign {
  id: string;
  kind: 'route' | 'symbol';
  coords: readonly (readonly [number, number])[];
}

export interface DrawnGrip {
  kind: Grip['kind'];
  index: number;
  at: Point;
  selected: boolean;
}

export interface RenderModel {
  /** Design geometry of features whose As-Built differs, drawn dashed underneath. */
  design: DrawnDesign[];
  features: DrawnFeature[];
  grips: DrawnGrip[];
  draft: readonly Point[];
  snapAt: Point | null;
}

const coordsOf = (g: AsBuiltGeometry): readonly (readonly [number, number])[] =>
  g.type === 'Point' ? [g.coordinates] : g.coordinates;
const asCoords = (points: readonly Point[]) => points.map((p) => [p.x, p.y] as const);

export function buildRenderModel(ctx: EditorContext, ui: EditorUi): RenderModel {
  const { state } = ctx;
  const preview = ui.drag?.kind === 'grip' ? liveRoute(ctx, ui) : null;
  const features: DrawnFeature[] = [];
  const design: DrawnDesign[] = [];
  for (const f of editorFeatures(ctx, ui.session)) {
    const approved = state.byId.get(f.id);
    const pending = state.pendingByFeature.get(f.id);
    const dragged = ui.drag?.kind === 'symbol' && ui.drag.id === f.id;
    const reshaped = ui.drag?.kind === 'grip' && ui.drag.routeId === f.id;
    const coords =
      reshaped && preview
        ? asCoords(preview)
        : dragged && ui.drag
          ? [[ui.drag.at.x, ui.drag.at.y] as const]
          : f.route
            ? asCoords(f.route)
            : f.at
              ? [[f.at.x, f.at.y] as const]
              : [];
    const inSession = f.touched || dragged || reshaped;
    const geometryChanged = approved ? approved.geometryVersion > 0 : false;
    const pendingShape = pending?.geometry != null && !inSession;
    const style: DrawStyle = inSession
      ? 'session'
      : pendingShape
        ? 'pending'
        : f.added || geometryChanged
          ? 'approved'
          : 'design';
    const shown = pendingShape && pending?.geometry ? coordsOf(pending.geometry) : coords;
    if (
      approved?.designGeometry &&
      (geometryChanged || (inSession && f.kind === 'route') || pendingShape || dragged)
    ) {
      design.push({ id: f.id, kind: f.kind, coords: coordsOf(approved.designGeometry) });
    }
    const labelChanged = f.label !== null && (approved ? f.label !== approved.code : true);
    features.push({
      id: f.id,
      type: f.type,
      kind: f.kind,
      coords: shown,
      style,
      text: f.label,
      textIsAsBuilt: labelChanged || (approved ? approved.labelVersion > 0 : false),
      selected: f.id === ui.selectedId,
    });
    if (pending?.label != null && !inSession && approved) {
      // A label proposal of mine: shown instead of the approved text, marked as pending.
      const last = features[features.length - 1];
      if (last) {
        last.text = pending.label;
        last.style = last.style === 'design' || last.style === 'approved' ? 'pending' : last.style;
      }
    }
  }

  const grips: DrawnGrip[] = [];
  if (ui.tool === 'reshape' && ui.selectedId) {
    try {
      const base = gripsFor(ctx, ui.session, ui.selectedId);
      for (const grip of base) {
        const index = grip.kind === 'vertex' ? grip.vertexIndex : grip.segmentIndex;
        const dragging =
          ui.drag?.kind === 'grip' &&
          ui.drag.grip.kind === grip.kind &&
          (ui.drag.grip.kind === 'vertex'
            ? ui.drag.grip.vertexIndex
            : ui.drag.grip.segmentIndex) === index;
        grips.push({
          kind: grip.kind,
          index,
          at: dragging && ui.drag ? ui.drag.at : grip.at,
          selected: grip.kind === 'vertex' && ui.selectedVertex === index,
        });
      }
    } catch {
      // Selected feature is not a route.
    }
  }
  return {
    design,
    features,
    grips,
    draft: ui.session.draft,
    snapAt: ui.drag?.snapped?.point ?? null,
  };
}
