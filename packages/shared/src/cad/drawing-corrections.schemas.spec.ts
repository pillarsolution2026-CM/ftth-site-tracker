import { describe, expect, it } from 'vitest';
import {
  CreateDrawingCorrectionsRequestSchema,
  DrawingCorrectionInputSchema,
  MAX_CORRECTIONS_PER_SAVE,
  MAX_CORRECTION_COORD,
  MAX_LINEWEIGHT_MM,
  MAX_NOTE_POINTS,
  SCREEN_ONLY_CORRECTION_KINDS,
  HATCH_PATTERNS,
  MAX_HATCH_LOOPS,
  MAX_HATCH_TRANSPARENCY,
  MAX_TABLE_COLUMNS,
  MAX_TEXT_MASK_OFFSET,
  MIN_TEXT_WIDTH_FACTOR,
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
  it('only notes, styles, shapes, draw order, groups, text formats and tables are screen-only', () => {
    expect([...SCREEN_ONLY_CORRECTION_KINDS].sort()).toEqual([
      'add_note',
      'add_shape',
      'add_table',
      'set_group',
      'set_order',
      'set_style',
      'set_text_format',
    ]);
  });
});

describe('layers for drawing only and layer meanings (owner 2026-11-19, ADR-051)', () => {
  const rules = [
    { source: 'layer', layer: 'R', target: 'route' },
    { source: 'layer', layer: 'BG', target: 'background' },
  ] as Parameters<typeof moveLayerTargets>[0];
  it('a new layer may be for drawing only (like null), and it means nothing', () => {
    expect(
      DrawingCorrectionInputSchema.safeParse({ kind: 'add_layer', layer: 'HOUSES', like: null })
        .success,
    ).toBe(true);
    const targets = moveLayerTargets(rules, [{ kind: 'add_layer', layer: 'HOUSES', like: null }]);
    expect([...targets]).toEqual(['R']);
  });
  it('a layer without a rule takes a meaning; one with its own rule keeps it', () => {
    const targets = moveLayerTargets(rules, [
      { kind: 'add_layer', layer: 'buildings', like: 'R' },
      { kind: 'add_layer', layer: 'BG', like: 'R' },
    ]);
    expect([...targets].sort()).toEqual(['R', 'buildings']);
  });
});

describe('screen shapes and draw order (owner 2026-11-24)', () => {
  const parse = (input: object) => DrawingCorrectionInputSchema.safeParse(input);
  const ok = (input: object) => parse(input).success;
  const square = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  it('are screen only', () => {
    expect(SCREEN_ONLY_CORRECTION_KINDS).toEqual(
      expect.arrayContaining(['add_shape', 'set_order']),
    );
  });
  it('a hatch or gradient needs a closed boundary of 3+ points; defaults are filled in', () => {
    const hatch = parse({ kind: 'add_shape', shape: 'hatch', layer: 'L', points: square });
    expect(hatch.success && hatch.data).toMatchObject({
      pattern: null,
      scale: 1,
      angle: 0,
      color: null,
      color2: null,
    });
    expect(ok({ kind: 'add_shape', shape: 'hatch', layer: 'L', points: square.slice(0, 2) })).toBe(
      false,
    );
    expect(
      ok({
        kind: 'add_shape',
        shape: 'gradient',
        layer: 'L',
        points: square,
        color: '#ff0000',
        color2: '#0000ff',
        angle: 45,
      }),
    ).toBe(true);
    expect(
      ok({ kind: 'add_shape', shape: 'hatch', layer: 'L', points: square, pattern: 'X' }),
    ).toBe(false);
  });
  it('a donut is one centre with an outer diameter above the inner one', () => {
    const donut = { kind: 'add_shape', shape: 'donut', layer: 'L', points: [[1, 1]] };
    expect(ok({ ...donut, inner: 0, outer: 2 })).toBe(true);
    expect(ok({ ...donut, inner: 2, outer: 2 })).toBe(false);
    expect(ok({ ...donut, inner: 0 })).toBe(false);
    expect(
      ok({
        ...donut,
        points: [
          [1, 1],
          [2, 2],
        ],
        outer: 2,
      }),
    ).toBe(false);
  });
  it('an XLINE or RAY is a point and a different direction point', () => {
    const line = { kind: 'add_shape', shape: 'xline', layer: 'L' };
    expect(
      ok({
        ...line,
        points: [
          [0, 0],
          [1, 1],
        ],
      }),
    ).toBe(true);
    expect(
      ok({
        ...line,
        points: [
          [0, 0],
          [0, 0],
        ],
      }),
    ).toBe(false);
    expect(ok({ ...line, shape: 'ray', points: [[0, 0]] })).toBe(false);
  });
  it('a draw order is a finite number on one handle', () => {
    expect(ok({ kind: 'set_order', handle: 'C1', order: -3.5 })).toBe(true);
    expect(ok({ kind: 'set_order', handle: 'C1', order: Number.NaN })).toBe(false);
    expect(ok({ kind: 'set_order', handle: 'C1', order: 2e9 })).toBe(false);
  });
});

describe('layers, groups and attributes (owner 2026-11-24)', () => {
  const parse = (input: object) => DrawingCorrectionInputSchema.safeParse(input);
  const ok = (input: object) => parse(input).success;
  it('a copy may go on another layer; without one it keeps the original layer', () => {
    const copy = parse({ kind: 'copy_item', handle: 'C1', dx: 1, dy: 0 });
    expect(copy.success && copy.data).toMatchObject({ toLayer: null });
    expect(ok({ kind: 'copy_item', handle: 'C1', dx: 0, dy: 0, toLayer: 'NEW' })).toBe(true);
  });
  it('a merge needs two layers', () => {
    expect(ok({ kind: 'merge_layer', from: 'A', to: 'B' })).toBe(true);
    expect(ok({ kind: 'merge_layer', from: 'A', to: 'A' })).toBe(false);
  });
  it('a group has a name; no handles ungroups it', () => {
    const group = parse({ kind: 'set_group', name: 'G1', handles: ['A', 'B'] });
    expect(group.success && group.data).toMatchObject({ block: false });
    expect(ok({ kind: 'set_group', name: 'G1', handles: [] })).toBe(true);
    expect(ok({ kind: 'set_group', name: ' ', handles: [] })).toBe(false);
  });
  it('an attribute changes from one value to another', () => {
    expect(ok({ kind: 'set_attribute', handle: 'I1', from: 'FDB-1', to: 'FDB-2' })).toBe(true);
    expect(ok({ kind: 'set_attribute', handle: 'I1', from: 'X', to: 'X' })).toBe(false);
  });
});

describe('text formats (ADR-055 part 7)', () => {
  const parse = (input: object) => DrawingCorrectionInputSchema.safeParse(input);
  const ok = (input: object) => parse(input).success;
  it('defaults: no width factor, not MText, no wrap, no mask', () => {
    const format = parse({ kind: 'set_text_format', handle: 'T1' });
    expect(format.success && format.data).toEqual({
      kind: 'set_text_format',
      handle: 'T1',
      widthFactor: null,
      mtext: false,
      wrap: null,
      mask: null,
    });
  });
  it('a width factor, a wrap width and a mask stay within their bounds', () => {
    expect(ok({ kind: 'set_text_format', handle: 'T1', widthFactor: 1.5 })).toBe(true);
    expect(
      ok({ kind: 'set_text_format', handle: 'T1', widthFactor: MIN_TEXT_WIDTH_FACTOR / 2 }),
    ).toBe(false);
    expect(ok({ kind: 'set_text_format', handle: 'T1', wrap: 0 })).toBe(false);
    expect(ok({ kind: 'set_text_format', handle: 'T1', mtext: true, wrap: 40 })).toBe(true);
    const masked = parse({ kind: 'set_text_format', handle: 'T1', mask: { offset: 0.35 } });
    expect(masked.success && masked.data.kind === 'set_text_format' && masked.data.mask).toEqual({
      offset: 0.35,
      color: null,
    });
    expect(
      ok({ kind: 'set_text_format', handle: 'T1', mask: { offset: MAX_TEXT_MASK_OFFSET + 1 } }),
    ).toBe(false);
    expect(ok({ kind: 'set_text_format', handle: 'T1', mask: { offset: 1, color: 'red' } })).toBe(
      false,
    );
  });
});

describe('tables (owner 2026-11-26)', () => {
  const parse = (input: object) => DrawingCorrectionInputSchema.safeParse(input);
  const ok = (input: object) => parse(input).success;
  const table = {
    kind: 'add_table',
    layer: 'L',
    x: 0,
    y: 100,
    columns: [63.5, 63.5],
    rows: [9, 9, 9],
    height: 4.5,
    cells: [
      ['Title', ''],
      ['A', 'B'],
      ['', '1'],
    ],
  };
  it('a table with one cell per row and column; styles default to Title / Header / Data', () => {
    const parsed = parse(table);
    expect(parsed.success && parsed.data).toMatchObject({ styles: ['title', 'header', 'data'] });
  });
  it('refuses cells that do not match the rows and columns', () => {
    expect(ok({ ...table, cells: [['a', 'b']] })).toBe(false);
    expect(ok({ ...table, cells: [['a'], ['b'], ['c']] })).toBe(false);
  });
  it('refuses a zero width, too many columns and control characters', () => {
    expect(ok({ ...table, columns: [0, 10] })).toBe(false);
    const wide = Array.from({ length: MAX_TABLE_COLUMNS + 1 }, () => 1);
    expect(ok({ ...table, columns: wide, cells: table.cells.map(() => wide.map(() => '')) })).toBe(
      false,
    );
    expect(
      ok({
        ...table,
        cells: [
          ['a', ''],
          ['', ''],
          ['', ''],
        ],
      }),
    ).toBe(false);
    expect(ok({ ...table, styles: ['data', 'data', 'title'] })).toBe(true);
    expect(ok({ ...table, styles: ['data', 'data', 'note'] })).toBe(false);
  });
});

describe('HATCH (ADR-055 part 8)', () => {
  const parse = (input: object) => DrawingCorrectionInputSchema.safeParse(input);
  const ok = (input: object) => parse(input).success;
  const square = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  const island = [
    [3, 3],
    [6, 3],
    [6, 6],
  ];
  const hatch = { kind: 'add_shape', shape: 'hatch', layer: 'L', points: square };
  it('new fields have AutoCAD defaults (saved hatches without them stay valid)', () => {
    const parsed = parse(hatch);
    expect(parsed.success && parsed.data).toMatchObject({
      loops: [],
      island: 'normal',
      background: null,
      transparency: 0,
      origin: null,
      double: false,
      drawOrder: 'behind',
    });
  });
  it('a hatch keeps several loops, a pattern of the gallery and its properties', () => {
    expect(
      ok({
        ...hatch,
        loops: [island],
        pattern: 'AR-B816',
        island: 'outer',
        background: '#202020',
        transparency: MAX_HATCH_TRANSPARENCY,
        origin: [5, 5],
        drawOrder: 'front',
      }),
    ).toBe(true);
    expect(ok({ ...hatch, pattern: 'USER', double: true, scale: 2 })).toBe(true);
    expect(ok({ ...hatch, transparency: MAX_HATCH_TRANSPARENCY + 1 })).toBe(false);
    expect(ok({ ...hatch, transparency: 1.5 })).toBe(false);
    expect(ok({ ...hatch, loops: [island.slice(0, 2)] })).toBe(false);
    expect(ok({ ...hatch, loops: Array.from({ length: MAX_HATCH_LOOPS + 1 }, () => island) })).toBe(
      false,
    );
    expect(ok({ ...hatch, island: 'all' })).toBe(false);
  });
  it('GR_ patterns are for gradients only; loops are for hatches and gradients only', () => {
    expect(ok({ ...hatch, pattern: 'GR_LINEAR' })).toBe(false);
    expect(ok({ ...hatch, shape: 'gradient', pattern: 'GR_SPHER', loops: [island] })).toBe(true);
    expect(ok({ ...hatch, shape: 'gradient', pattern: 'ANSI31' })).toBe(false);
    expect(ok({ ...hatch, shape: 'wipeout', loops: [island] })).toBe(false);
    expect(HATCH_PATTERNS).toEqual(expect.arrayContaining(['ANSI31', 'SOLID', 'GR_INVCUR']));
  });
});
