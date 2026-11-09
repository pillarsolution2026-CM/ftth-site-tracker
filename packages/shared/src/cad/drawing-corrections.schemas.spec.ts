import { describe, expect, it } from 'vitest';
import {
  DrawingCorrectionInputSchema,
  MAX_CORRECTION_COORD,
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
