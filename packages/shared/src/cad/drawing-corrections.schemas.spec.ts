import { describe, expect, it } from 'vitest';
import {
  DrawingCorrectionInputSchema,
  MAX_CORRECTION_COORD,
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
