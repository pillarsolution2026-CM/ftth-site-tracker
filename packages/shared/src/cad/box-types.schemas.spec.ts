import { describe, expect, it } from 'vitest';
import {
  BOX_SHAPE_NONE,
  BOX_TYPE_LABEL_MAX,
  BoxShapeGallerySchema,
  BoxShapePreviewSchema,
  BoxShapeSignatureSchema,
  BoxTypesReportSchema,
  FrozenBoxTypesSchema,
  MAX_BOX_SHAPE_PREVIEW_VERTICES,
  SetBoxTypesRequestSchema,
  boxTypeLabel,
  boxTypesApply,
  boxTypesChangedSince,
  evaluateBoxTypes,
  latestChoicePerShape,
  type BoxShape,
  type BoxShapeGallery,
  type FrozenBoxTypes,
} from './box-types.schemas.js';
import {
  PUBLISH_CHECK_KEYS,
  PublishBlockedDetailsSchema,
  PublishReadinessSchema,
} from '../design/design-revision.schemas.js';
import { BoxReadingSchema, readingOf } from '../design/feature-reading.schemas.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const sig = (c: string) => `v1-${c.repeat(64)}`;
const A = sig('a');
const B = sig('b');
const C = sig('c');
const L1 = id(201);
const L2 = id(202);

const shape = (s: string, count: number, more: Partial<BoxShape> = {}): BoxShape => ({
  shape: s,
  source: 'block',
  count,
  blockNames: ['box c'],
  sampleHandles: ['1F'],
  preview: null,
  ...more,
});

const gallery = (shapes: BoxShape[], more: Partial<BoxShapeGallery> = {}): BoxShapeGallery => ({
  version: 1,
  boxCount: shapes.reduce((n, s) => n + s.count, 0),
  shapeCount: shapes.length,
  shapes,
  boxesWithoutShape: 0,
  ...more,
});

const frozen = (pairs: [string, string][]): FrozenBoxTypes => ({
  choices: pairs.map(([s, line], i) => ({
    choiceId: id(10 + i),
    shape: s,
    workOrderLineId: line,
    line: { code: line === L1 ? '2-12-4-8' : '2-12-4-9', description: 'd', label: 'd' },
  })),
});

const evaluate = (
  g: BoxShapeGallery | null,
  f: FrozenBoxTypes | null,
  lines: string[] = [L1, L2],
  workOrderExists = true,
) =>
  evaluateBoxTypes({
    applies: true,
    gallery: g,
    frozen: f,
    workOrderExists,
    workOrderLineIds: new Set(lines),
  });

describe('box shape signature', () => {
  it('accepts versioned sha256 and none, refuses anything else', () => {
    expect(BoxShapeSignatureSchema.safeParse(A).success).toBe(true);
    expect(BoxShapeSignatureSchema.safeParse(BOX_SHAPE_NONE).success).toBe(true);
    expect(BoxShapeSignatureSchema.safeParse('box c').success).toBe(false);
    expect(BoxShapeSignatureSchema.safeParse(`v1-${'A'.repeat(64)}`).success).toBe(false);
    expect(BoxShapeSignatureSchema.safeParse(`v0-${'a'.repeat(64)}`).success).toBe(false);
  });

  it('applies to a roles-mode Secondary only', () => {
    expect(boxTypesApply('secondary', 'roles')).toBe(true);
    expect(boxTypesApply('secondary', 'legacy')).toBe(false);
    expect(boxTypesApply('general', 'roles')).toBe(false);
  });
});

describe('preview and gallery bounds', () => {
  it('caps preview vertices and needs x, y pairs inside the unit box', () => {
    const square = [-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5, -0.5, -0.5];
    expect(
      BoxShapePreviewSchema.safeParse({ paths: [square], texts: [], truncated: false }).success,
    ).toBe(true);
    expect(
      BoxShapePreviewSchema.safeParse({ paths: [[0, 0, 0.5]], texts: [], truncated: false })
        .success,
    ).toBe(false);
    expect(
      BoxShapePreviewSchema.safeParse({ paths: [[0, 0, 2, 0]], texts: [], truncated: false })
        .success,
    ).toBe(false);
    const big = Array.from({ length: (MAX_BOX_SHAPE_PREVIEW_VERTICES + 1) * 2 }, () => 0);
    expect(
      BoxShapePreviewSchema.safeParse({ paths: [big], texts: [], truncated: true }).success,
    ).toBe(false);
  });

  it('refuses a gallery listing one shape twice', () => {
    expect(BoxShapeGallerySchema.safeParse(gallery([shape(A, 2), shape(B, 1)])).success).toBe(true);
    expect(BoxShapeGallerySchema.safeParse(gallery([shape(A, 2), shape(A, 1)])).success).toBe(
      false,
    );
  });
});

describe('choices', () => {
  it('request: unique shapes, null clears, at least one', () => {
    const ok = SetBoxTypesRequestSchema.parse({
      choices: [
        { shape: A, workOrderLineId: L1 },
        { shape: B, workOrderLineId: null },
      ],
    });
    expect(ok.fromPreviousVersion).toBe(false);
    expect(
      SetBoxTypesRequestSchema.safeParse({
        choices: [
          { shape: A, workOrderLineId: L1 },
          { shape: A, workOrderLineId: L2 },
        ],
      }).success,
    ).toBe(false);
    expect(SetBoxTypesRequestSchema.safeParse({ choices: [] }).success).toBe(false);
    expect(
      SetBoxTypesRequestSchema.safeParse({ choices: [{ shape: A, workOrderLineId: L1 }], x: 1 })
        .success,
    ).toBe(false);
  });

  it('latest row per shape wins (rows newest first)', () => {
    const rows = [
      { shape: A, workOrderLineId: null, n: 3 },
      { shape: B, workOrderLineId: L2, n: 2 },
      { shape: A, workOrderLineId: L1, n: 1 },
    ];
    expect(latestChoicePerShape(rows).map((r) => r.n)).toEqual([3, 2]);
  });

  it('frozen choices: one per shape', () => {
    expect(FrozenBoxTypesSchema.safeParse(frozen([[A, L1]])).success).toBe(true);
    expect(
      FrozenBoxTypesSchema.safeParse(
        frozen([
          [A, L1],
          [A, L2],
        ]),
      ).success,
    ).toBe(false);
  });

  it('rebuild needed when the live choices in force differ from the frozen ones', () => {
    const f = frozen([
      [A, L1],
      [B, L2],
    ]);
    expect(boxTypesChangedSince(f, [id(10), id(11)])).toBe(false);
    expect(boxTypesChangedSince(f, [id(10)])).toBe(true);
    expect(boxTypesChangedSince(f, [id(10), id(99)])).toBe(true);
    expect(boxTypesChangedSince(null, [])).toBe(false);
    expect(boxTypesChangedSince(null, [id(1)])).toBe(true);
  });
});

describe('label', () => {
  it('collapses whitespace and cuts long descriptions', () => {
    expect(boxTypeLabel('  بوكس 8 فرعة\n بسبليتر 4 ')).toBe('بوكس 8 فرعة بسبليتر 4');
    const long = boxTypeLabel('x'.repeat(200));
    expect(long).toHaveLength(BOX_TYPE_LABEL_MAX);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('evaluateBoxTypes', () => {
  it('not applicable → ok, nothing listed', () => {
    const r = evaluateBoxTypes({
      applies: false,
      gallery: null,
      frozen: null,
      workOrderExists: false,
      workOrderLineIds: new Set(),
    });
    expect(r).toMatchObject({ applies: false, ok: true, issueCount: 0, totals: null });
  });

  it('every shape chosen with an existing line → ok, boxes per line', () => {
    const r = evaluate(
      gallery([shape(A, 150), shape(B, 40), shape(C, 7)]),
      frozen([
        [A, L1],
        [B, L2],
        [C, L1],
      ]),
    );
    expect(r.ok).toBe(true);
    expect(r.totals).toEqual([
      { workOrderLineId: L1, code: '2-12-4-8', label: 'd', boxCount: 157, shapes: [A, C] },
      { workOrderLineId: L2, code: '2-12-4-9', label: 'd', boxCount: 40, shapes: [B] },
    ]);
  });

  it('a shape with no choice is BOX_TYPE_UNSET; a deleted line is BOX_TYPE_LINE_MISSING', () => {
    const r = evaluate(
      gallery([shape(A, 150), shape(B, 40), shape(C, 7)]),
      frozen([
        [A, L1],
        [C, L2],
      ]),
      [L1],
    );
    expect(r.ok).toBe(false);
    expect(r.totals).toBeNull();
    expect(r.issues.map((i) => [i.code, i.shape, i.boxCount])).toEqual([
      ['BOX_TYPE_UNSET', B, 40],
      ['BOX_TYPE_LINE_MISSING', C, 7],
    ]);
    expect(r.issues[1]?.workOrderLineId).toBe(L2);
  });

  it('a choice for a shape absent from the drawing is ignored', () => {
    const r = evaluate(
      gallery([shape(A, 3)]),
      frozen([
        [A, L1],
        [B, L2],
      ]),
      [L1],
    );
    expect(r.ok).toBe(true);
    expect(r.totals?.map((t) => t.workOrderLineId)).toEqual([L1]);
  });

  it('unclear readings block: no gallery, unread shapes, too many shapes, no work order', () => {
    expect(evaluate(null, null).issues.map((i) => i.code)).toEqual(['BOX_SHAPES_NOT_READ']);
    const unread = evaluate(gallery([shape(A, 3)], { boxCount: 5, boxesWithoutShape: 2 }), {
      choices: frozen([[A, L1]]).choices,
    });
    expect(unread.issues).toEqual([
      { code: 'BOX_SHAPE_UNKNOWN', shape: null, boxCount: 2, workOrderLineId: null },
    ]);
    const many = evaluate(
      gallery([shape(A, 3)], { boxCount: 10, shapeCount: 4 }),
      frozen([[A, L1]]),
    );
    expect(many.issues).toEqual([
      { code: 'BOX_SHAPES_TOO_MANY', shape: null, boxCount: 7, workOrderLineId: null },
    ]);
    const noWo = evaluate(gallery([shape(A, 3)]), null, [], false);
    expect(noWo.issues.map((i) => i.code)).toEqual(['WORK_ORDER_MISSING', 'BOX_TYPE_UNSET']);
  });

  it('a Secondary without boxes is ok with empty totals', () => {
    const r = evaluate(gallery([]), null);
    expect(r).toMatchObject({ ok: true, totals: [] });
  });

  it('report parses with changedSinceBuild', () => {
    const r = evaluate(gallery([shape(A, 1)]), frozen([[A, L1]]));
    expect(BoxTypesReportSchema.safeParse({ ...r, changedSinceBuild: false }).success).toBe(true);
  });
});

describe('publish contracts', () => {
  it('check key and blocker', () => {
    expect(PUBLISH_CHECK_KEYS).toContain('box_types');
    const details = PublishBlockedDetailsSchema.parse({
      reason: 'BOX_TYPES_UNCLEAR',
      drawingKind: 'secondary',
      issueCount: 1,
      issues: [{ code: 'BOX_TYPE_UNSET', shape: A, boxCount: 197, workOrderLineId: null }],
    });
    expect(details.reason).toBe('BOX_TYPES_UNCLEAR');
    expect(
      PublishBlockedDetailsSchema.safeParse({ ...details, drawingKind: 'general' }).success,
    ).toBe(false);
  });

  it('readiness defaults boxTypes to null', () => {
    const r = PublishReadinessSchema.parse({
      checks: PUBLISH_CHECK_KEYS.map((key) => ({ key, ok: true, count: null })),
      canPublish: true,
      drawingKind: 'general',
      otherRevisionId: null,
      needsAcknowledgement: false,
    });
    expect(r.boxTypes).toBeNull();
  });
});

describe('box reading', () => {
  const base = {
    of: 'box',
    cabinet: '1-3',
    number: '9',
    cableCores: 4,
    cableLengthM: '398.000',
    texts: {},
  };

  it('readings stored before ADR-043 read with shape and type null', () => {
    const r = BoxReadingSchema.parse(base);
    expect(r.shape).toBeNull();
    expect(r.boxType).toBeNull();
  });

  it('keeps the shape and the frozen type; a bad value drops only its field', () => {
    const r = readingOf({
      reading: {
        ...base,
        shape: A,
        boxType: { workOrderLineId: L1, code: '2-12-4-8', label: 'd' },
      },
    });
    expect(r).toMatchObject({ of: 'box', shape: A, boxType: { workOrderLineId: L1 } });
    const bad = readingOf({ reading: { ...base, shape: 'box c', boxType: { x: 1 } } });
    expect(bad).toMatchObject({ of: 'box', number: '9', shape: null, boxType: null });
  });
});
