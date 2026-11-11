import { describe, expect, it } from 'vitest';
import {
  CreateTrenchMarkRequestSchema,
  DEFAULT_INSTALLATION_METHOD,
  FrozenInstallationSchema,
  InstallationReportSchema,
  TrenchLengthSchema,
  evaluateInstallation,
  installationChangedSince,
  installationQuestionApplies,
  installationRouteOf,
  metresToMm,
  mmToMetres,
  routeKeyResolver,
  type FrozenInstallation,
  type InstallationRoute,
} from './installation.schemas.js';
import {
  PublishBlockedDetailsSchema,
  PUBLISH_CHECK_KEYS,
} from '../design/design-revision.schemas.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const F1 = id(101);
const F2 = id(102);
const F3 = id(103);

const routes: InstallationRoute[] = [
  { featureId: F1, sourceHandle: 'A1', writtenLengthM: '500.000' },
  { featureId: F2, sourceHandle: 'B7', writtenLengthM: '120.500' },
  { featureId: F3, sourceHandle: 'C9', writtenLengthM: null },
];

const frozen = (
  answer: FrozenInstallation['answer'],
  marks: [string, string][] = [],
): FrozenInstallation => ({
  answer,
  answerId: answer === null ? null : id(1),
  marks: marks.map(([routeHandle, lengthM], i) => ({ id: id(10 + i), routeHandle, lengthM })),
});

const general = (f: FrozenInstallation | null, merges: string[][] = []) =>
  evaluateInstallation({ drawingKind: 'general', frozen: f, routes, merges });

describe('installation basics (ADR-040 G14–G17)', () => {
  it('asks the General only; General = pull, Secondary = trench by default', () => {
    expect(installationQuestionApplies('general')).toBe(true);
    expect(installationQuestionApplies('secondary')).toBe(false);
    expect(DEFAULT_INSTALLATION_METHOD).toEqual({ general: 'pull', secondary: 'trench' });
  });

  it('adds the installation check to the publish checklist', () => {
    expect(PUBLISH_CHECK_KEYS).toContain('installation');
  });
});

describe('TrenchLengthSchema', () => {
  it('normalises to metres with 3 decimals', () => {
    expect(TrenchLengthSchema.parse('12.5')).toBe('12.500');
    expect(TrenchLengthSchema.parse(' 40 ')).toBe('40.000');
    expect(TrenchLengthSchema.parse('100000')).toBe('100000.000');
  });

  it('refuses zero, negatives, too many decimals, exponents and lengths over the bound', () => {
    for (const bad of ['0', '0.000', '-1', '1.2345', '1e3', '100000.001', '', 'abc', '01']) {
      expect(TrenchLengthSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('never takes a number', () => {
    expect(
      CreateTrenchMarkRequestSchema.safeParse({ routeHandle: 'A1', lengthM: 12 }).success,
    ).toBe(false);
  });

  it('refuses unknown keys and control characters in the handle', () => {
    expect(
      CreateTrenchMarkRequestSchema.safeParse({ routeHandle: 'A1', lengthM: '5', extra: 1 })
        .success,
    ).toBe(false);
    expect(
      CreateTrenchMarkRequestSchema.safeParse({
        routeHandle: `A${String.fromCharCode(0)}`,
        lengthM: '5',
      }).success,
    ).toBe(false);
  });
});

describe('metres as millimetres', () => {
  it('round-trips without floats', () => {
    expect(metresToMm('120.5')).toBe(120500n);
    expect(mmToMetres(120500n)).toBe('120.500');
    expect(mmToMetres(0n)).toBe('0.000');
    expect(mmToMetres(7n)).toBe('0.007');
    expect(mmToMetres(-1500n)).toBe('-1.500');
    expect(mmToMetres(metresToMm('0.1') + metresToMm('0.2'))).toBe('0.300');
  });
});

describe('routeKeyResolver', () => {
  it('keys merged pieces by the smallest handle, also through chained merges', () => {
    const keyOf = routeKeyResolver([
      ['B2', 'C3'],
      ['C3', 'A1'],
    ]);
    expect(['A1', 'B2', 'C3'].map(keyOf)).toEqual(['A1', 'A1', 'A1']);
    expect(keyOf('Z9')).toBe('Z9');
  });
});

describe('installationRouteOf', () => {
  it('takes the written bundle length of a route reading; null otherwise', () => {
    const reading = {
      of: 'route',
      ways: 4,
      labelWays: 4,
      ductSize: '16/12',
      writtenLengthM: '500.000',
      cableCores: 144,
      cableLengthM: '520.000',
      spareCores: null,
      spares: [],
      connectors: 0,
      texts: {},
    };
    expect(
      installationRouteOf({ id: F1, featureType: 'route', sourceHandle: 'A1', attrs: { reading } }),
    ).toEqual({ featureId: F1, sourceHandle: 'A1', writtenLengthM: '500.000' });
    expect(
      installationRouteOf({ id: F1, featureType: 'route', sourceHandle: 'A1', attrs: {} }),
    ).toEqual({ featureId: F1, sourceHandle: 'A1', writtenLengthM: null });
    expect(
      installationRouteOf({ id: F1, featureType: 'hhi', sourceHandle: 'A1', attrs: {} }),
    ).toBeNull();
  });
});

describe('evaluateInstallation', () => {
  it('a Secondary is not asked and always passes', () => {
    const report = evaluateInstallation({
      drawingKind: 'secondary',
      frozen: null,
      routes,
      merges: [],
    });
    expect(report).toMatchObject({ applies: false, ok: true, issueCount: 0, totals: null });
    expect(InstallationReportSchema.parse(report)).toEqual(report);
  });

  it('unanswered (also a revision built before 0022) is an error', () => {
    for (const f of [null, frozen(null)]) {
      const report = general(f);
      expect(report.ok).toBe(false);
      expect(report.issues.map((i) => i.code)).toEqual(['QUESTION_UNANSWERED']);
      expect(report.totals).toBeNull();
    }
  });

  it('«has trench» with no mark is an error', () => {
    expect(general(frozen('has_trench')).issues.map((i) => i.code)).toEqual(['TRENCH_NOT_MARKED']);
  });

  it('pull only: every written length is pull', () => {
    const report = general(frozen('pull_only'));
    expect(report.ok).toBe(true);
    expect(report.totals).toEqual({
      trenchM: '0.000',
      pullM: '620.500',
      routesWithoutLength: 1,
      marked: [],
    });
  });

  it('pull only with marks is an error', () => {
    const report = general(frozen('pull_only', [['A1', '10']]));
    expect(report.issues.map((i) => i.code)).toEqual(['MARKS_WITH_PULL_ONLY']);
  });

  it('marks: several on one route, a merged piece, the rest stays pull', () => {
    const report = general(
      frozen('has_trench', [
        ['A1', '100.000'],
        ['Q4', '50.250'],
        ['B7', '120.500'],
      ]),
      [['Q4', 'A1']],
    );
    expect(report.ok).toBe(true);
    expect(report.totals).toEqual({
      trenchM: '270.750',
      pullM: '349.750',
      routesWithoutLength: 1,
      marked: [
        {
          featureId: F1,
          routeHandle: 'A1',
          routeLengthM: '500.000',
          trenchM: '150.250',
          pullM: '349.750',
        },
        {
          featureId: F2,
          routeHandle: 'B7',
          routeLengthM: '120.500',
          trenchM: '120.500',
          pullM: '0.000',
        },
      ],
    });
  });

  it('flags marks that do not fit their route, in code order', () => {
    const report = general(
      frozen('has_trench', [
        ['B7', '100'],
        ['B7', '20.501'],
        ['C9', '10'],
        ['GONE', '5'],
      ]),
    );
    expect(report.ok).toBe(false);
    expect(report.totals).toBeNull();
    expect(report.issues).toEqual([
      {
        code: 'MARK_ROUTE_MISSING',
        markIds: [id(13)],
        routeHandle: 'GONE',
        featureId: null,
        markedM: null,
        routeLengthM: null,
      },
      {
        code: 'ROUTE_LENGTH_UNKNOWN',
        markIds: [id(12)],
        routeHandle: 'C9',
        featureId: F3,
        markedM: '10.000',
        routeLengthM: null,
      },
      {
        code: 'TRENCH_LONGER_THAN_ROUTE',
        markIds: [id(10), id(11)],
        routeHandle: 'B7',
        featureId: F2,
        markedM: '120.501',
        routeLengthM: '120.500',
      },
    ]);
  });

  it('an issue is a publish blocker of the General', () => {
    const report = general(frozen('has_trench'));
    expect(
      PublishBlockedDetailsSchema.safeParse({
        reason: 'INSTALLATION_UNCLEAR',
        drawingKind: 'general',
        issueCount: report.issueCount,
        issues: report.issues,
      }).success,
    ).toBe(true);
    expect(
      PublishBlockedDetailsSchema.safeParse({
        reason: 'INSTALLATION_UNCLEAR',
        drawingKind: 'secondary',
        issueCount: 1,
        issues: [],
      }).success,
    ).toBe(false);
  });
});

describe('installationChangedSince', () => {
  const f = frozen('has_trench', [['A1', '10']]);
  it('is false when the answer and the marks in force are the frozen ones', () => {
    expect(installationChangedSince(f, { answerId: id(1), activeMarkIds: [id(10)] })).toBe(false);
  });
  it('is true after a new answer, a new mark or a withdrawal', () => {
    expect(installationChangedSince(f, { answerId: id(2), activeMarkIds: [id(10)] })).toBe(true);
    expect(installationChangedSince(f, { answerId: id(1), activeMarkIds: [id(10), id(11)] })).toBe(
      true,
    );
    expect(installationChangedSince(f, { answerId: id(1), activeMarkIds: [] })).toBe(true);
    expect(installationChangedSince(null, { answerId: id(1), activeMarkIds: [] })).toBe(true);
    expect(installationChangedSince(null, { answerId: null, activeMarkIds: [] })).toBe(false);
  });
  it('the frozen shape parses', () => {
    expect(FrozenInstallationSchema.parse(f)).toEqual(f);
  });
});
