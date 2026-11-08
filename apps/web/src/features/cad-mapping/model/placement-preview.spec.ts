import type { PlacementDrawing } from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import { mappingView } from './mapping-fixtures';
import { initialPlacementState, solveState } from './placement-form';
import { placementPreview } from './placement-preview';

const EPSG = 32636;
const drawing: PlacementDrawing = {
  mappingVersion: 1,
  items: [
    {
      handle: 'C1',
      featureType: 'cabinet',
      code: null,
      names: ['22U', '1-7'],
      layer: 'CAB',
      x: 100,
      y: 200,
    },
  ],
  lines: [
    [
      [100, 200],
      [150, 200],
    ],
  ],
  truncated: false,
};

describe('placementPreview', () => {
  it('shows the drawing where the placement puts it, with each point and its error line', () => {
    const point = {
      id: 'P1',
      drawing: { x: 100, y: 200 },
      handle: 'C1',
      label: '1-7',
      lat: 30.984506906326853,
      lon: 32.78324905782938,
      source: 'typed' as const,
      excluded: false,
    };
    const state = { ...initialPlacementState(mappingView()), points: [point] };
    const solved = solveState(state, EPSG, 1);
    if (!solved.ok) throw new Error('expected a solution');
    const preview = placementPreview(drawing, state.points, solved.solution, EPSG);

    const cabinet = preview.points.features.find((f) => f.properties.kind === 'cabinet');
    const [lon, lat] = cabinet?.geometry.coordinates ?? [0, 0];
    // One point is a pure shift: the cabinet sits on the point's Lat/Lon.
    expect(lon).toBeCloseTo(point.lon, 8);
    expect(lat).toBeCloseTo(point.lat, 8);
    expect(preview.lines.features.map((f) => f.properties.kind)).toEqual(['route', 'error']);
    expect(preview.points.features.map((f) => f.properties.kind)).toEqual([
      'cabinet',
      'placed',
      'target',
    ]);
    expect(preview.bounds).not.toBeNull();
    // Centre of the placed drawing in UTM metres: the route is 50 m long, eastwards.
    const placedCabinet = solved.solution.toProject({ x: 100, y: 200 });
    expect(preview.centre?.x).toBeCloseTo(placedCabinet.x + 25, 6);
    expect(preview.centre?.y).toBeCloseTo(placedCabinet.y, 6);
  });

  it('is empty without a drawing or points', () => {
    const state = initialPlacementState(mappingView());
    const solved = solveState(state, EPSG, 1);
    if (!solved.ok) throw new Error('expected a solution');
    const preview = placementPreview(null, [], solved.solution, EPSG);
    expect(preview.bounds).toBeNull();
    expect(preview.centre).toBeNull();
  });
});
