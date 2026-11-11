import { describe, expect, it } from 'vitest';
import {
  CabinetsComparisonSchema,
  compareCabinets,
  DesignRevisionCountsSchema,
  PUBLISH_CHECK_KEYS,
  PublishBlockedDetailsSchema,
  PublishReadinessSchema,
} from './design-revision.schemas.js';
import {
  blocksPublishing,
  DRAWING_PROBLEM_CODES,
  DRAWING_PROBLEM_SEVERITY,
  DrawingProblemListSchema,
  DrawingProblemSchema,
  drawingProblemsOf,
  problemTotals,
  problemTotalsOf,
} from './drawing-problems.js';
import { readingOf, ReadingTotalsSchema } from './feature-reading.schemas.js';

const place = {
  x: 1,
  y: 2,
  drawingX: 3,
  drawingY: 4,
  layer: 'EXCH',
  handle: 'A1',
  suggestedLayer: null,
  text: '450M/12Core F.O',
  near: null,
};

describe('drawing problems of ADR-041', () => {
  it('has a severity and a blocking flag for every code', () => {
    for (const code of DRAWING_PROBLEM_CODES) {
      expect(DRAWING_PROBLEM_SEVERITY[code]).toBeDefined();
      expect(typeof blocksPublishing(code)).toBe('boolean');
    }
  });

  it('blocks on every code except a cable longer than its bundle by more than 30 m', () => {
    const free = DRAWING_PROBLEM_CODES.filter((code) => !blocksPublishing(code));
    expect(free).toEqual(['CABLE_SLACK_TOO_LONG']);
    // Phase-1 codes keep their stored severity and still block (ADR-038).
    expect(DRAWING_PROBLEM_SEVERITY.ROUTE_SPLIT).toBe('warning');
    expect(blocksPublishing('ROUTE_SPLIT')).toBe(true);
  });

  it('carries params on a place and still reads places stored before (no params)', () => {
    const params = {
      cableLengthM: '670.000',
      bundleLengthM: '450.000',
      slackM: '220.000',
      featureHandle: 'R9',
    };
    const problem = DrawingProblemSchema.parse({
      code: 'CABLE_SLACK_TOO_LONG',
      severity: 'warning',
      count: 1,
      items: [{ ...place, params }],
    });
    expect(problem.items[0]?.params?.slackM).toBe('220.000');
    const old = { code: 'ROUTE_SPLIT', severity: 'warning', count: 1, items: [place] };
    expect(drawingProblemsOf([old])).toHaveLength(1);
  });

  it('refuses param values of the wrong type', () => {
    const parsed = DrawingProblemSchema.safeParse({
      code: 'CABLE_SLACK_TOO_SHORT',
      severity: 'error',
      count: 1,
      items: [{ ...place, params: { slackM: 220 } }],
    });
    expect(parsed.success).toBe(false);
  });

  it('splits totals into blocking places and warnings', () => {
    const problems = drawingProblemsOf([
      { code: 'LABEL_TYPE_MISMATCH', severity: 'error', count: 13, items: [place] },
      { code: 'CABLE_SLACK_TOO_LONG', severity: 'warning', count: 1, items: [place] },
    ]);
    expect(problemTotals(problems)).toEqual({ blocking: 13, warnings: 1 });
    expect(DrawingProblemListSchema.parse({ items: [], total: 0 }).warningTotal).toBe(0);
  });
});

describe('feature readings', () => {
  it('reads a Secondary box and ignores attrs without a reading', () => {
    const box = {
      of: 'box',
      cabinet: '1-3',
      number: '9',
      cableCores: 4,
      cableLengthM: '398.000',
      texts: { box_number: ['T1'], box_cabinet: ['T2'] },
    };
    expect(readingOf({ kind: 'box c', reading: box })).toMatchObject({ cabinet: '1-3' });
    expect(readingOf({ kind: 'box c' })).toBeNull();
  });

  it('reads routes, handholes and cabinets; refuses a type outside the list', () => {
    const route = {
      of: 'route',
      ways: 12,
      labelWays: 7,
      ductSize: '7/3.5',
      writtenLengthM: '455.000',
      cableCores: null,
      cableLengthM: null,
      spareCores: null,
      spares: [{ count: 3, ductSize: '7/3.5' }],
      connectors: 0,
      texts: {},
    };
    const hhi = { of: 'hhi', number: '04A', type: 'HH-I', typeText: 'HH1', texts: {} };
    const cabinet = {
      of: 'cabinet',
      name: '1-7',
      type: '22U',
      boxCount: 22,
      ports: 2,
      boxesDrawn: 22,
      zoneHandle: 'Z1',
      texts: { cabinet_info: ['C1', 'C2', 'C3', 'C4'] },
    };
    expect(readingOf({ reading: route })).toMatchObject({ labelWays: 7 });
    expect(readingOf({ reading: hhi })).toMatchObject({ type: 'HH-I' });
    expect(readingOf({ reading: cabinet })).toMatchObject({ boxCount: 22 });
    expect(readingOf({ reading: { ...hhi, type: 'XX' } })).toBeNull();
  });

  it('adds the reading totals to the revision counts, optional for older revisions', () => {
    const features = { route: 1, box: 0, hhi: 0, joint: 0, mh: 0 };
    const before = DesignRevisionCountsSchema.parse({ features, routeLengthM: '1' });
    expect(before.reading).toBeUndefined();
    const reading = ReadingTotalsSchema.parse({
      drawingKind: 'secondary',
      bundles: [
        { ways: 1, ductSize: '7/3.5', count: 187, writtenLengthM: '1870.000', withoutLength: 0 },
      ],
      connectors: [{ ductSize: '7/3.5', count: 187 }],
      spares: [{ ductSize: '7/3.5', singles: 187, endCaps: 374 }],
      cables: [],
      handholes: [],
    });
    const after = DesignRevisionCountsSchema.parse({ features, routeLengthM: '1', reading });
    expect(after.reading).toEqual(reading);
  });
});

describe('shared cabinets across the pair (ADR-040)', () => {
  it('matches by name and count', () => {
    const result = compareCabinets(['1-1', '1-2', '1-3'], ['1 - 3', '1-2', '1-1']);
    expect(result.ok).toBe(true);
    expect(CabinetsComparisonSchema.parse(result)).toEqual(result);
  });

  it('flags unnamed General cabinets (Al-Fath layer Sap) and names missing in the other', () => {
    const result = compareCabinets([null, null, '1-9'], ['1-1', '1-2', '1-3']);
    expect(result.ok).toBe(false);
    expect(result.general).toEqual({ count: 3, unnamed: 2, missingInOther: ['1-9'] });
    expect(result.secondary).toEqual({
      count: 3,
      unnamed: 0,
      missingInOther: ['1-1', '1-2', '1-3'],
    });
  });

  it('flags a count difference even when every name matches', () => {
    expect(compareCabinets(['1-1', '1-1'], ['1-1']).ok).toBe(false);
  });

  it('compares counts per name: [A, A, B] against [A, B, B] is a mismatch', () => {
    const result = compareCabinets(['1-1', '1-1', '1-2'], ['1-1', '1-2', '1-2']);
    expect(result.ok).toBe(false);
    expect(result.general.missingInOther).toEqual(['1-1']);
    expect(result.secondary.missingInOther).toEqual(['1-2']);
    expect(compareCabinets(['1-1', '1-1', '1-2'], ['1-2', '1 - 1', '1-1']).ok).toBe(true);
  });

  it('compares counts per name: [A, A, B] against [A, B, B] is a mismatch', () => {
    const result = compareCabinets(['1-1', '1-1', '1-2'], ['1-1', '1-2', '1-2']);
    expect(result.ok).toBe(false);
    expect(result.general.missingInOther).toEqual(['1-1']);
    expect(result.secondary.missingInOther).toEqual(['1-2']);
    expect(compareCabinets(['1-1', '1-1', '1-2'], ['1-2', '1 - 1', '1-1']).ok).toBe(true);
  });

  it('adds the cabinets check, blocker and readiness fields', () => {
    expect(PUBLISH_CHECK_KEYS).toContain('cabinets_match');
    const cabinets = compareCabinets([null], ['1-1']);
    const blocked = PublishBlockedDetailsSchema.parse({ reason: 'CABINETS_MISMATCH', cabinets });
    expect(blocked.reason).toBe('CABINETS_MISMATCH');
    const readiness = PublishReadinessSchema.parse({
      checks: PUBLISH_CHECK_KEYS.map((key) => ({ key, ok: true, count: null })),
      canPublish: true,
      drawingKind: 'general',
      otherRevisionId: null,
      needsAcknowledgement: false,
    });
    expect(readiness).toMatchObject({ cabinets: null, warningCount: 0 });
  });
});

describe('problems fail closed (ADR-041 review)', () => {
  const spare = (mainCores: number) => ({
    code: 'SPARE_CORES_MISMATCH',
    severity: 'error',
    count: 2,
    items: [{ ...place, params: { mainCores } }],
  });

  it('keeps the count of a known code whose place does not parse', () => {
    for (const mainCores of [Infinity, 1e30, -5, 1.5]) {
      const warnings = [spare(mainCores)];
      expect(problemTotals(drawingProblemsOf(warnings)).blocking).toBe(2);
      expect(problemTotalsOf(warnings).blocking).toBe(2);
    }
    // The unreadable place is dropped from the display; its count stays.
    const [problem] = drawingProblemsOf([spare(1e30)]);
    expect(problem).toMatchObject({ code: 'SPARE_CORES_MISMATCH', count: 2, items: [] });
  });

  it('salvages a malformed entry of a known code as blocking, at least 1', () => {
    const totals = problemTotalsOf([
      { code: 'BOX_NOT_REACHED', count: 'many', items: 'x' },
      { code: 'WRONG_LAYER', severity: 'bogus', count: 3, items: [{ nope: true }] },
    ]);
    expect(totals).toEqual({ blocking: 4, warnings: 0, unreadable: 0 });
    expect(drawingProblemsOf([{ code: 'WRONG_LAYER', count: 3, items: [{}] }])[0]?.severity).toBe(
      'error',
    );
  });

  it('counts an entry that cannot be read at all as one blocking place, and skips old ones', () => {
    const totals = problemTotalsOf([
      null,
      'x',
      { count: 3 },
      { code: 'ROUTE_ZERO_LENGTH_SKIPPED', count: 1 },
    ]);
    expect(totals).toEqual({ blocking: 3, warnings: 0, unreadable: 3 });
  });

  it('keeps non-blocking codes as warnings even when malformed', () => {
    expect(problemTotalsOf([{ code: 'CABLE_SLACK_TOO_LONG', count: 2 }])).toEqual({
      blocking: 0,
      warnings: 2,
      unreadable: 0,
    });
  });

  it('shows a reading with an out-of-range field instead of failing the revision', () => {
    const totals = ReadingTotalsSchema.parse({
      drawingKind: 'general',
      bundles: [
        { ways: 9999, ductSize: null, count: -1, writtenLengthM: '1.000', withoutLength: 0 },
      ],
      connectors: [],
      spares: [],
      cables: [],
      handholes: [],
    });
    expect(totals.bundles[0]).toMatchObject({ ways: null, count: 0 });
  });
});

describe('problems fail closed (ADR-041 review)', () => {
  const spare = (mainCores: number) => ({
    code: 'SPARE_CORES_MISMATCH',
    severity: 'error',
    count: 2,
    items: [{ ...place, params: { mainCores } }],
  });

  it('keeps the count of a known code whose place does not parse', () => {
    for (const mainCores of [Infinity, 1e30, -5, 1.5]) {
      const warnings = [spare(mainCores)];
      expect(problemTotals(drawingProblemsOf(warnings)).blocking).toBe(2);
      expect(problemTotalsOf(warnings).blocking).toBe(2);
    }
    // The unreadable place is dropped from the display; its count stays.
    const [problem] = drawingProblemsOf([spare(1e30)]);
    expect(problem).toMatchObject({ code: 'SPARE_CORES_MISMATCH', count: 2, items: [] });
  });

  it('salvages a malformed entry of a known code as blocking, at least 1', () => {
    const totals = problemTotalsOf([
      { code: 'BOX_NOT_REACHED', count: 'many', items: 'x' },
      { code: 'WRONG_LAYER', severity: 'bogus', count: 3, items: [{ nope: true }] },
    ]);
    expect(totals).toEqual({ blocking: 4, warnings: 0, unreadable: 0 });
    expect(drawingProblemsOf([{ code: 'WRONG_LAYER', count: 3, items: [{}] }])[0]?.severity).toBe(
      'error',
    );
  });

  it('counts an entry that cannot be read at all as one blocking place, and skips old ones', () => {
    const totals = problemTotalsOf([
      null,
      'x',
      { count: 3 },
      { code: 'ROUTE_ZERO_LENGTH_SKIPPED', count: 1 },
    ]);
    expect(totals).toEqual({ blocking: 3, warnings: 0, unreadable: 3 });
  });

  it('keeps non-blocking codes as warnings even when malformed', () => {
    expect(problemTotalsOf([{ code: 'CABLE_SLACK_TOO_LONG', count: 2 }])).toEqual({
      blocking: 0,
      warnings: 2,
      unreadable: 0,
    });
  });

  it('shows a reading with an out-of-range field instead of failing the revision', () => {
    const totals = ReadingTotalsSchema.parse({
      drawingKind: 'general',
      bundles: [
        { ways: 9999, ductSize: null, count: -1, writtenLengthM: '1.000', withoutLength: 0 },
      ],
      connectors: [],
      spares: [],
      cables: [],
      handholes: [],
    });
    expect(totals.bundles[0]).toMatchObject({ ways: null, count: 0 });
  });
});
