import { describe, expect, it } from 'vitest';
import { ControlPointSchema, MAX_CONTROL_POINTS, PlacementSchema } from './placement.schemas.js';
import {
  SecondaryPlacementRefusedDetailsSchema,
  SecondaryPlacementSuggestionSchema,
  drawingAtOf,
  generalCabinetPointId,
  matchSharedCabinets,
  placementKindProblems,
  withGeneralCabinetPoints,
  type GeneralCabinetPosition,
  type SecondaryCabinetDrawn,
} from './secondary-placement.schemas.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

const general: GeneralCabinetPosition[] = [
  { name: '1-1', lat: 30.98, lon: 32.78 },
  { name: '1-2', lat: 30.981, lon: 32.781 },
  { name: '1-3', lat: 30.982, lon: 32.782 },
  { name: '1-3', lat: 30.983, lon: 32.783 },
  { name: '1-9', lat: 30.984, lon: 32.784 },
  { name: null, lat: 30.985, lon: 32.785 },
];
const secondary: SecondaryCabinetDrawn[] = [
  { name: '1-1', handle: 'H1', drawingAt: { x: 10, y: 20 } },
  { name: ' 1 - 2 ', handle: 'H2', drawingAt: null },
  { name: '1-3', handle: 'H3', drawingAt: { x: 30, y: 40 } },
  { name: '1-4', handle: 'H4', drawingAt: { x: 50, y: 60 } },
  { name: null, handle: 'H5', drawingAt: { x: 70, y: 80 } },
];

describe('general_cabinet control points (ADR-042 part G)', () => {
  it('is a control point source', () => {
    const point = ControlPointSchema.parse({
      id: 'gc-1-1',
      drawing: { x: 1, y: 2 },
      lat: 30,
      lon: 32,
      source: 'general_cabinet',
    });
    expect(point.source).toBe('general_cabinet');
  });

  it('reads the drawn centre stored on a point feature', () => {
    expect(drawingAtOf({ drawingAt: { x: 1.5, y: -2 } })).toEqual({ x: 1.5, y: -2 });
    expect(drawingAtOf({})).toBeNull();
    expect(drawingAtOf({ drawingAt: { x: 'a', y: 0 } })).toBeNull();
  });

  it('point ids are stable per cabinet name and bounded', () => {
    expect(generalCabinetPointId(' 1 - 7 ')).toBe('gc-1-7');
    expect(generalCabinetPointId('x'.repeat(100))).toHaveLength(64);
  });

  it('long names that share a prefix still get distinct ids (L2)', () => {
    const a = generalCabinetPointId('x'.repeat(80) + 'a');
    const b = generalCabinetPointId('x'.repeat(80) + 'b');
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(64);
    expect(generalCabinetPointId('x'.repeat(80) + 'a')).toBe(a);
  });
});

describe('matchSharedCabinets', () => {
  it('pairs each name found once in both drawings; says why the others gave no point', () => {
    const result = matchSharedCabinets(general, secondary);
    expect(result.points).toEqual([
      {
        id: 'gc-1-1',
        drawing: { x: 10, y: 20 },
        handle: 'H1',
        label: '1-1',
        lat: 30.98,
        lon: 32.78,
        source: 'general_cabinet',
        excluded: false,
      },
    ]);
    expect(result.matchedCount).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.unmatched).toEqual({
      onlyInSecondary: ['1-4'],
      onlyInGeneral: ['1-9'],
      duplicateInSecondary: [],
      duplicateInGeneral: ['1-3'],
      unnamedSecondary: 1,
      unnamedGeneral: 1,
      withoutDrawingPosition: [' 1 - 2 '],
      unusable: [],
      listCapped: false,
    });
  });

  it('lists a cabinet whose point cannot be built instead of throwing (L2)', () => {
    const long = 'n'.repeat(300);
    const result = matchSharedCabinets(
      [
        { name: long, lat: 1, lon: 1 },
        { name: 'ok', lat: Number.NaN, lon: Number.NaN },
        { name: 'fine', lat: 30, lon: 31 },
      ],
      [
        { name: long, handle: 'H1', drawingAt: { x: 0, y: 0 } },
        { name: 'ok', handle: 'H2', drawingAt: { x: 0, y: 0 } },
        { name: 'fine', handle: 'H3', drawingAt: { x: 1, y: 1 } },
      ],
    );
    expect(result.points.map((p) => p.label)).toEqual(['fine']);
    expect(result.unmatched.unusable).toEqual([long.slice(0, 200), 'ok']);
  });

  it('groups many cabinets of one name in linear time (L1)', () => {
    const many = Array.from({ length: 50_000 }, () => ({ name: 'same', lat: 1, lon: 1 }));
    const started = Date.now();
    const result = matchSharedCabinets(many, []);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.unmatched.duplicateInGeneral).toEqual(['same']);
  });

  it('gives nothing without names (no guess)', () => {
    const result = matchSharedCabinets(
      [{ name: null, lat: 1, lon: 1 }],
      [{ name: null, handle: 'H', drawingAt: { x: 0, y: 0 } }],
    );
    expect(result.points).toEqual([]);
    expect(result.unmatched.unnamedGeneral).toBe(1);
    expect(result.unmatched.unnamedSecondary).toBe(1);
  });

  it('caps the points at MAX_CONTROL_POINTS, sorted by name', () => {
    const n = MAX_CONTROL_POINTS + 5;
    const names = Array.from({ length: n }, (_, i) => `1-${i + 1}`);
    const result = matchSharedCabinets(
      names.map((name) => ({ name, lat: 30, lon: 32 })),
      names.map((name, i) => ({ name, handle: `H${i}`, drawingAt: { x: i, y: i } })),
    );
    expect(result.points).toHaveLength(MAX_CONTROL_POINTS);
    expect(result.matchedCount).toBe(n);
    expect(result.truncated).toBe(true);
    expect(result.points[0]?.label).toBe('1-1');
  });
});

describe('withGeneralCabinetPoints', () => {
  const typed = {
    id: 't1',
    drawing: { x: 0, y: 0 },
    handle: null,
    label: null,
    lat: 30,
    lon: 32,
    source: 'typed' as const,
    excluded: false,
  };
  const suggested = matchSharedCabinets(general, secondary).points;

  it('replaces earlier suggestions, keeps the PM points first and earlier exclusions', () => {
    const current = PlacementSchema.parse({
      sourceCrs: 'egypt_red_belt',
      points: [
        typed,
        { ...typed, id: 'gc-1-1', source: 'general_cabinet', excluded: true },
        { ...typed, id: 'gc-1-5', source: 'general_cabinet' },
      ],
    });
    const { placement, dropped } = withGeneralCabinetPoints(current, suggested, 'project');
    expect(dropped).toBe(0);
    expect(placement.sourceCrs).toBe('egypt_red_belt');
    expect(placement.points.map((p) => [p.id, p.excluded])).toEqual([
      ['t1', false],
      ['gc-1-1', true],
    ]);
    expect(PlacementSchema.safeParse(placement).success).toBe(true);
  });

  it('starts a placement with the given source CRS when there is none', () => {
    const { placement } = withGeneralCabinetPoints(null, suggested, 'project');
    expect(placement.sourceCrs).toBe('project');
    expect(placement.points).toHaveLength(1);
  });

  it('drops what does not fit', () => {
    const full = PlacementSchema.parse({
      points: Array.from({ length: MAX_CONTROL_POINTS }, (_, i) => ({ ...typed, id: `t${i}` })),
    });
    const { placement, dropped } = withGeneralCabinetPoints(full, suggested, 'project');
    expect(dropped).toBe(1);
    expect(placement.points).toHaveLength(MAX_CONTROL_POINTS);
  });
});

describe('placementKindProblems', () => {
  const placement = PlacementSchema.parse({
    points: [
      { id: 'a', drawing: { x: 0, y: 0 }, lat: 1, lon: 1, source: 'typed' },
      { id: 'b', drawing: { x: 0, y: 0 }, lat: 1, lon: 1, source: 'general_cabinet' },
    ],
  });
  it('refuses general_cabinet points on a General only', () => {
    expect(placementKindProblems(placement, 'general')).toEqual([1]);
    expect(placementKindProblems(placement, 'secondary')).toEqual([]);
    expect(placementKindProblems(null, 'general')).toEqual([]);
  });
});

describe('API shapes', () => {
  it('parses a suggestion and a refusal', () => {
    const { points, matchedCount, truncated, unmatched } = matchSharedCabinets(general, secondary);
    expect(
      SecondaryPlacementSuggestionSchema.safeParse({
        cadFileId: id(1),
        secondaryRevisionId: id(2),
        general: { cadFileId: id(3), revisionId: id(4), status: 'draft', revNo: null },
        points,
        matchedCount,
        truncated,
        unmatched,
      }).success,
    ).toBe(true);
    expect(
      SecondaryPlacementRefusedDetailsSchema.safeParse({
        reason: 'GENERAL_NOT_PLACED',
        revisionId: id(4),
      }).success,
    ).toBe(true);
    expect(
      SecondaryPlacementRefusedDetailsSchema.safeParse({ reason: 'GUESS', revisionId: null })
        .success,
    ).toBe(false);
  });
});
