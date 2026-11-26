import { describe, expect, it } from 'vitest';
import { formatPrompt, textLineBelow } from '../hooks/use-canvas-edit';
import { acadAngle, lookupCommand } from './cad-commands';

/** Phase 7 (owner 2026-11-26, item 19): command names and prompt lines as AutoCAD 2D. */

const t = (key: string) =>
  key === 'design.cad.or'
    ? 'or'
    : key === 'design.cad.cmd.mirrorErase'
      ? 'Erase source objects?'
      : 'Specify base point';

describe('AutoCAD aliases (acad.pgp)', () => {
  it('BPOLY, DIMLIN and PAINTER name BOUNDARY, DIMLINEAR and MATCHPROP', () => {
    expect(lookupCommand('bpoly')).toBe('boundary');
    expect(lookupCommand('DIMLIN')).toBe('dimlinear');
    expect(lookupCommand('painter')).toBe('matchprop');
  });
});

describe('prompt lines', () => {
  it('a question lists its options without «or»; «Specify …» keeps it', () => {
    const yesNo = [
      { word: 'Yes', key: 'Y' },
      { word: 'No', key: 'N' },
    ];
    expect(
      formatPrompt(t as never, 'MIRROR', { key: 'mirrorErase', options: yesNo, fallback: 'No' }),
    ).toBe('MIRROR Erase source objects? [Yes/No] <No>:');
    expect(
      formatPrompt(t as never, 'MOVE', {
        key: 'basePoint',
        options: [{ word: 'Displacement', key: 'D' }],
        fallback: 'Displacement',
      }),
    ).toBe('MOVE Specify base point or [Displacement] <Displacement>:');
  });
  it('angles in a default are whole degrees (AUPREC 0)', () => {
    expect(acadAngle(90)).toBe('90');
    expect(acadAngle(-0.2)).toBe('0');
    expect(acadAngle(22.6)).toBe('23');
  });
  it('the next TEXT line starts 5/3 of the height lower', () => {
    expect(textLineBelow({ x: 4, y: 10 }, 3)).toEqual({ x: 4, y: 5 });
  });
});
