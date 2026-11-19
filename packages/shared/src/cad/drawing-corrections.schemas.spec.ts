import { describe, expect, it } from 'vitest';
import {
  CreateDrawingCorrectionsRequestSchema,
  DrawingCorrectionInputSchema,
  MAX_CORRECTIONS_PER_SAVE,
  MAX_CORRECTION_COORD,
  MAX_LINEWEIGHT_MM,
  MAX_NOTE_POINTS,
  SCREEN_ONLY_CORRECTION_KINDS,
  moveLayerTargets,
} from './drawing-corrections.schemas.js';

describe('DrawingCorrectionInputSchema (security review limits)', () => {
  it('accepts coordinates up to the bound and refuses beyond it', () => {
    const at = (x: number) =>
      DrawingCorrectionInputSchema.safeParse({ kind: 'add_item', layer: 'L', x, y: 0 }).success;
    expect(at(MAX_CORRECTION_COORD)).toBe(true);
    expect(at(-MAX_CORRECTION_COORD)).toBe(true);
    expect(at(MAX_CORRECTION_COORD + 1)).toBe(false);
    expect(at(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('refuses control characters in texts, layers and handles', () => {
    const nul = String.fromCharCode(0);
    expect(
      DrawingCorrectionInputSchema.safeParse({ kind: 'set_text', handle: 'A1', text: `a${nul}b` })
        .success,
    ).toBe(false);
    expect(
      DrawingCorrectionInputSchema.safeParse({
        kind: 'move_layer',
        handle: 'A1',
        toLayer: `L${nul}`,
      }).success,
    ).toBe(false);
    expect(
      DrawingCorrectionInputSchema.safeParse({ kind: 'set_text', handle: `A${nul}`, text: 'x' })
        .success,
    ).toBe(false);
    expect(
      DrawingCorrectionInputSchema.safeParse({ kind: 'set_text', handle: 'A1', text: 'وصلة 144' })
        .success,
    ).toBe(true);
  });
});

describe('dismiss_problem (ADR-046)', () => {
  const dismiss = {
    kind: 'dismiss_problem',
    code: 'LABEL_MISSING',
    handle: '220D',
    reason: 'cable without its own label here',
  };

  it('accepts a known problem code, a handle and a reason', () => {
    expect(DrawingCorrectionInputSchema.parse(dismiss)).toEqual(dismiss);
  });

  it('requires a reason and refuses unknown codes and extra fields', () => {
    const bad = [
      { ...dismiss, reason: '   ' },
      { ...dismiss, code: 'NOT_A_CODE' },
      { ...dismiss, handle: 'x'.repeat(65) },
      { ...dismiss, extra: 1 },
    ];
    for (const input of bad) {
      expect(DrawingCorrectionInputSchema.safeParse(input).success).toBe(false);
    }
  });
});

describe('moveLayerTargets (owner 2026-11-09: only layers with a rule)', () => {
  it('keeps layers mapped to a feature type or label, never ignore / background / block rules', () => {
    const targets = moveLayerTargets([
      { source: 'layer', layer: 'CAB', target: 'cabinet', role: 'sub' },
      { source: 'layer', layer: 'TXT', target: 'label' },
      { source: 'layer', layer: 'BG', target: 'background' },
      { source: 'layer', layer: 'NO', target: 'ignore' },
      { source: 'block', block: 'B', target: 'box' },
    ] as Parameters<typeof moveLayerTargets>[0]);
    expect([...targets].sort()).toEqual(['CAB', 'TXT']);
  });
});

describe('CreateDrawingCorrectionsRequestSchema (ADR-047)', () => {
  const one = { correction: { kind: 'set_text', handle: 'T1', text: 'x' } };
  it('takes 1 to MAX_CORRECTIONS_PER_SAVE edits, each with a problem of null by default', () => {
    const parsed = CreateDrawingCorrectionsRequestSchema.parse({ items: [one] });
    expect(parsed.items[0]?.problem).toBeNull();
    const full = Array.from({ length: MAX_CORRECTIONS_PER_SAVE }, () => one);
    expect(CreateDrawingCorrectionsRequestSchema.safeParse({ items: full }).success).toBe(true);
  });
  it('refuses none, too many, a bad edit or an extra field', () => {
    const many = Array.from({ length: MAX_CORRECTIONS_PER_SAVE + 1 }, () => one);
    for (const body of [
      { items: [] },
      { items: many },
      { items: [{ correction: { kind: 'set_text', handle: 'T1', text: '' } }] },
      { items: [one], extra: 1 },
    ]) {
      expect(CreateDrawingCorrectionsRequestSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe('move_item and rotate_item (ADR-047)', () => {
  it('accepts a move and a turn within the bounds', () => {
    for (const input of [
      { kind: 'move_item', handle: 'C1', dx: -2.5, dy: 10 },
      { kind: 'rotate_item', handle: 'C1', x: 1, y: 2, angle: -360 },
      { kind: 'rotate_item', handle: 'C1', x: 1, y: 2, angle: 45.5 },
    ]) {
      expect(DrawingCorrectionInputSchema.safeParse(input).success).toBe(true);
    }
  });
  it('refuses missing fields, a turn past a full one, infinite moves and extra fields', () => {
    for (const input of [
      { kind: 'move_item', handle: 'C1', dx: 1 },
      { kind: 'move_item', handle: 'C1', dx: 1, dy: Number.POSITIVE_INFINITY },
      { kind: 'rotate_item', handle: 'C1', x: 0, y: 0, angle: 360.5 },
      { kind: 'rotate_item', handle: 'C1', x: 0, y: 0, angle: 10, extra: 1 },
      { kind: 'move_item', handle: '', dx: 0, dy: 0 },
    ]) {
      expect(DrawingCorrectionInputSchema.safeParse(input).success).toBe(false);
    }
  });
});

describe('CAD ribbon corrections (ADR-050)', () => {
  const ok = (input: object) => DrawingCorrectionInputSchema.safeParse(input).success;
  it('accepts erase, copy, mirror, scale, a drawn line and the layer commands', () => {
    expect(ok({ kind: 'erase_item', handle: 'C1' })).toBe(true);
    expect(ok({ kind: 'copy_item', handle: 'C1', dx: 1, dy: -2 })).toBe(true);
    expect(ok({ kind: 'mirror_item', handle: 'C1', x1: 0, y1: 0, x2: 1, y2: 0 })).toBe(true);
    expect(ok({ kind: 'scale_item', handle: 'C1', x: 0, y: 0, factor: 2 })).toBe(true);
    expect(
      ok({
        kind: 'add_curve',
        layer: 'R',
        points: [
          [0, 0],
          [1, 1],
        ],
      }),
    ).toBe(true);
    expect(ok({ kind: 'add_layer', layer: 'NEW', like: 'R' })).toBe(true);
    expect(ok({ kind: 'rename_layer', from: 'R', to: 'R2' })).toBe(true);
    expect(ok({ kind: 'delete_layer', layer: 'R' })).toBe(true);
  });
  it('refuses a mirror line of one point, a zero scale, one point, and same-name layers', () => {
    expect(ok({ kind: 'mirror_item', handle: 'C1', x1: 1, y1: 1, x2: 1, y2: 1 })).toBe(false);
    expect(ok({ kind: 'scale_item', handle: 'C1', x: 0, y: 0, factor: 0 })).toBe(false);
    expect(ok({ kind: 'add_curve', layer: 'R', points: [[0, 0]] })).toBe(false);
    expect(ok({ kind: 'add_layer', layer: 'R', like: 'R' })).toBe(false);
    expect(ok({ kind: 'rename_layer', from: 'R', to: 'R' })).toBe(false);
  });
  it('a layer added or renamed takes the rule of its source, through chains', () => {
    const rules = [{ source: 'layer', layer: 'R', target: 'route' }] as Parameters<
      typeof moveLayerTargets
    >[0];
    const targets = moveLayerTargets(rules, [
      { kind: 'add_layer', layer: 'NEW', like: 'R' },
      { kind: 'rename_layer', from: 'NEW', to: 'NEW2' },
      { kind: 'add_layer', layer: 'X', like: 'UNMAPPED' },
    ]);
    expect([...targets].sort()).toEqual(['NEW', 'NEW2', 'R']);
  });
});

describe('AutoCAD-like screen corrections (ADR-051)', () => {
  const parse = (input: object) => DrawingCorrectionInputSchema.safeParse(input);
  const ok = (input: object) => parse(input).success;
  const line = [
    [0, 0],
    [3, 4],
  ];
  it('set_curve replaces a curve with 2+ finite points, open by default', () => {
    const parsed = parse({ kind: 'set_curve', handle: 'C1', points: line });
    expect(parsed.success && parsed.data).toMatchObject({ kind: 'set_curve', closed: false });
    expect(ok({ kind: 'set_curve', handle: 'C1', points: line, closed: true })).toBe(true);
    expect(ok({ kind: 'set_curve', handle: 'C1', points: [[0, 0]] })).toBe(false);
    expect(
      ok({
        kind: 'set_curve',
        handle: 'C1',
        points: [
          [0, 0],
          [Infinity, 1],
        ],
      }),
    ).toBe(false);
    expect(ok({ kind: 'set_curve', handle: 'C1', points: line, layer: 'R' })).toBe(false);
  });
  it('add_note takes a dimension or leader of 1-MAX_NOTE_POINTS points, text optional', () => {
    const parsed = parse({ kind: 'add_note', note: 'dimension', layer: 'DIM', points: line });
    expect(parsed.success && parsed.data).toMatchObject({ text: null });
    expect(
      ok({ kind: 'add_note', note: 'leader', layer: 'DIM', points: [[1, 1]], text: 'ODB' }),
    ).toBe(true);
    const many = Array.from({ length: MAX_NOTE_POINTS + 1 }, (_, i) => [i, i]);
    expect(ok({ kind: 'add_note', note: 'leader', layer: 'DIM', points: many })).toBe(false);
    expect(ok({ kind: 'add_note', note: 'leader', layer: 'DIM', points: [] })).toBe(false);
    expect(ok({ kind: 'add_note', note: 'table', layer: 'DIM', points: line })).toBe(false);
    expect(
      ok({ kind: 'add_note', note: 'leader', layer: 'DIM', points: line, text: '\u0007' }),
    ).toBe(false);
  });
  it('set_style takes a #rrggbb colour, a known line type and a bounded weight; null = by layer', () => {
    const parsed = parse({ kind: 'set_style', handle: 'C1', color: '#FF0000' });
    expect(parsed.success && parsed.data).toMatchObject({ linetype: null, lineweight: null });
    expect(ok({ kind: 'set_style', handle: 'C1', linetype: 'dashed', lineweight: 0.35 })).toBe(
      true,
    );
    expect(ok({ kind: 'set_style', handle: 'C1' })).toBe(true);
    expect(ok({ kind: 'set_style', handle: 'C1', color: 'red' })).toBe(false);
    expect(ok({ kind: 'set_style', handle: 'C1', linetype: 'zigzag' })).toBe(false);
    expect(ok({ kind: 'set_style', handle: 'C1', lineweight: MAX_LINEWEIGHT_MM + 1 })).toBe(false);
    expect(ok({ kind: 'set_style', handle: 'C1', lineweight: -1 })).toBe(false);
  });
  it('only notes and styles are screen-only', () => {
    expect([...SCREEN_ONLY_CORRECTION_KINDS].sort()).toEqual(['add_note', 'set_style']);
  });
});
