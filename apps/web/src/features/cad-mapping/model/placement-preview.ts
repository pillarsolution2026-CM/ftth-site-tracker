import type { PlacementSolution, Point } from '@ftth/geo';
import type { ControlPoint, PlacementDrawing } from '@ftth/shared';
import { projectToLonLat } from './placement-form';

type LonLat = [number, number];

interface Feature<G, P> {
  type: 'Feature';
  geometry: G;
  properties: P;
}
type LineFeature = Feature<{ type: 'LineString'; coordinates: LonLat[] }, { kind: string }>;
type PointFeature = Feature<
  { type: 'Point'; coordinates: LonLat },
  { kind: string; label: string; outlier?: boolean }
>;

export interface PlacementPreview {
  /** Route lines and error lines (control point placed ↔ its Lat/Lon). */
  lines: { type: 'FeatureCollection'; features: LineFeature[] };
  /** Items at their placed position, control points placed and at their Lat/Lon. */
  points: { type: 'FeatureCollection'; features: PointFeature[] };
  /** [west, south, east, north] of everything, null when there is nothing to show. */
  bounds: [number, number, number, number] | null;
  /** Centre of the placed drawing in the project CRS: the pivot of the Rotate / Scale tools. */
  centre: Point | null;
}

/**
 * The drawing at its new place, in Lon/Lat for the map (ADR-035 preview). Everything goes through
 * the same solution the build uses, so what is seen is what will be built.
 */
export function placementPreview(
  drawing: PlacementDrawing | null,
  points: readonly ControlPoint[],
  solution: PlacementSolution,
  projectEpsg: number,
): PlacementPreview {
  const toLonLat = projectToLonLat(projectEpsg);
  const box = new Bounds();
  const placedBox = new Bounds();
  const place = (p: Point): LonLat => {
    const projected = solution.toProject(p);
    placedBox.add(projected.x, projected.y);
    const lonLat = toLonLat(projected);
    box.add(lonLat[0], lonLat[1]);
    return lonLat;
  };

  const lines: LineFeature[] = [];
  const pointFeatures: PointFeature[] = [];
  for (const line of drawing?.lines ?? []) {
    lines.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: line.map(([x, y]) => place({ x, y })) },
      properties: { kind: 'route' },
    });
  }
  for (const item of drawing?.items ?? []) {
    pointFeatures.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: place({ x: item.x, y: item.y }) },
      properties: { kind: item.featureType, label: item.code ?? item.names[0] ?? '' },
    });
  }
  const residuals = new Map(solution.residuals.map((residual) => [residual.id, residual]));
  for (const point of points) {
    const placed = place(point.drawing);
    const target: LonLat = [point.lon, point.lat];
    box.add(target[0], target[1]);
    const outlier = residuals.get(point.id)?.outlier ?? false;
    lines.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [placed, target] },
      properties: { kind: 'error' },
    });
    pointFeatures.push(
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: placed },
        properties: { kind: 'placed', label: point.id, outlier },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: target },
        properties: {
          kind: point.excluded ? 'target-excluded' : 'target',
          label: point.id,
          outlier,
        },
      },
    );
  }
  return {
    lines: { type: 'FeatureCollection', features: lines },
    points: { type: 'FeatureCollection', features: pointFeatures },
    bounds: box.value(),
    centre: placedBox.centre(),
  };
}

class Bounds {
  private minX = Infinity;
  private minY = Infinity;
  private maxX = -Infinity;
  private maxY = -Infinity;

  add(x: number, y: number) {
    this.minX = Math.min(this.minX, x);
    this.minY = Math.min(this.minY, y);
    this.maxX = Math.max(this.maxX, x);
    this.maxY = Math.max(this.maxY, y);
  }

  value(): [number, number, number, number] | null {
    return Number.isFinite(this.minX) ? [this.minX, this.minY, this.maxX, this.maxY] : null;
  }

  centre(): Point | null {
    return Number.isFinite(this.minX)
      ? { x: (this.minX + this.maxX) / 2, y: (this.minY + this.maxY) / 2 }
      : null;
  }
}
