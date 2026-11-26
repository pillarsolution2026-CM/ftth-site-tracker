import { describe, expect, it } from 'vitest';
import { insidePolygon } from './draw-shapes';
import {
  autoNumber,
  CHAR_ADVANCE,
  changeCase,
  combineTexts,
  constantSize,
  encloseText,
  fitFactor,
  mostReadable,
  PLAIN_FORMAT,
  textLength,
  turnBetween,
  wrapLines,
  type TextState,
} from './text-tools';

const state = (patch: Partial<TextState> = {}): TextState => ({
  index: 0,
  handle: 'T1',
  kind: 'TEXT',
  x: 0,
  y: 0,
  height: 2,
  rotation: 0,
  text: 'ABCDE',
  format: PLAIN_FORMAT,
  ...patch,
});

describe('TCASE', () => {
  it('changes case as AutoCAD: Sentence, lower, UPPER, Title, toGGLE', () => {
    expect(changeCase('hello WORLD. new one', 'S')).toBe('Hello world. New one');
    expect(changeCase('FDB-1 Box', 'L')).toBe('fdb-1 box');
    expect(changeCase('fdb-1 box', 'U')).toBe('FDB-1 BOX');
    expect(changeCase('main CABLE route', 'T')).toBe('Main Cable Route');
    expect(changeCase('Ab-c', 'G')).toBe('aB-C');
  });
});

describe('TORIENT', () => {
  it('Most Readable turns upside-down texts by 180° and keeps the others', () => {
    expect(mostReadable(0)).toBe(0);
    expect(mostReadable(45)).toBe(45);
    expect(mostReadable(90)).toBe(90);
    expect(mostReadable(180)).toBe(0);
    expect(mostReadable(200)).toBe(20);
    expect(mostReadable(-90)).toBe(90);
    expect(mostReadable(300)).toBe(300);
  });
  it('turns by the short way', () => {
    expect(turnBetween(10, 350)).toBe(-20);
    expect(turnBetween(350, 10)).toBe(20);
  });
});

describe('TEXTFIT', () => {
  it('the width factor makes the text reach the end point along its direction', () => {
    const t = state();
    const natural = textLength(t.text, t.height, null);
    expect(natural).toBeCloseTo(5 * 2 * CHAR_ADVANCE);
    expect(fitFactor(t, [0, 0], [natural * 2, 5])).toBeCloseTo(2);
    expect(fitFactor(state({ rotation: 90 }), [0, 0], [0, natural / 2])).toBeCloseTo(0.5);
    expect(fitFactor(t, [0, 0], [-1, 0])).toBeNull();
  });
});

describe('TCOUNT', () => {
  const items = [
    { index: 1, x: 10, y: 0, text: 'B' },
    { index: 2, x: 0, y: 5, text: 'A' },
    { index: 3, x: 5, y: 10, text: 'C' },
  ];
  it('sorts by Y (top to bottom), X (left to right) or the picking order', () => {
    expect(autoNumber(items, 'Y', 1, 1, 'O').map((n) => n.index)).toEqual([3, 2, 1]);
    expect(autoNumber(items, 'X', 1, 1, 'O').map((n) => n.index)).toEqual([2, 3, 1]);
    expect(autoNumber(items, 'S', 1, 1, 'O').map((n) => n.index)).toEqual([1, 2, 3]);
  });
  it('places numbers by Overwrite, Prefix, Suffix and Find&replace from start by increment', () => {
    expect(autoNumber(items, 'S', 5, 10, 'O').map((n) => n.text)).toEqual(['5', '15', '25']);
    expect(autoNumber(items, 'S', 1, 1, 'P').map((n) => n.text)).toEqual(['1 B', '2 A', '3 C']);
    expect(autoNumber(items, 'S', 1, 1, 'S').map((n) => n.text)).toEqual(['B 1', 'A 2', 'C 3']);
    const found = autoNumber(
      [
        { index: 1, x: 0, y: 0, text: 'FDB-#' },
        { index: 2, x: 0, y: 0, text: 'NONE' },
        { index: 3, x: 0, y: 0, text: '#/#' },
      ],
      'S',
      1,
      1,
      'F',
      '#',
    );
    expect(found).toEqual([
      { index: 1, text: 'FDB-1' },
      { index: 3, text: '2/2' },
    ]);
  });
  it('leaves texts that would pass 255 characters', () => {
    const long = { index: 9, x: 0, y: 0, text: 'x'.repeat(255) };
    expect(autoNumber([long], 'S', 1, 1, 'P')).toEqual([]);
  });
});

describe('TCIRCLE', () => {
  it('circles, slots and rectangles enclose the text box with the offset', () => {
    const t = state();
    const length = textLength(t.text, t.height, null);
    for (const shape of ['C', 'S', 'R'] as const) {
      const loop = encloseText(t, 0.35, shape);
      expect(insidePolygon(loop, [length / 2, 1])).toBe(true);
      expect(insidePolygon(loop, [0.01, 0.01])).toBe(true);
      expect(insidePolygon(loop, [length + 5, 1])).toBe(false);
    }
    const rect = encloseText(t, 0.5, 'R');
    expect(rect[0]?.[0]).toBeCloseTo(-1);
    expect(rect[0]?.[1]).toBeCloseTo(-1);
  });
  it('Constant uses the largest text for all', () => {
    const size = constantSize([state(), state({ text: 'A', height: 4 })]);
    expect(size.height).toBe(4);
    expect(size.length).toBeCloseTo(textLength('ABCDE', 2, null));
  });
});

describe('TXT2MTXT', () => {
  it('combines top to bottom and wraps at the widest text', () => {
    const combined = combineTexts([
      state({ index: 1, handle: 'B', text: 'second line', y: 0 }),
      state({ index: 2, handle: 'A', text: 'first', y: 5 }),
    ]);
    expect(combined?.first.handle).toBe('A');
    expect(combined?.text).toBe('first second line');
    expect(combined?.rest.map((r) => r.handle)).toEqual(['B']);
    expect(combined?.wrap).toBeCloseTo(textLength('second line', 2, null));
    expect(combineTexts([state({ text: 'x'.repeat(200) }), state({ text: 'y'.repeat(60) })])).toBe(
      null,
    );
  });
  it('wraps words at the width', () => {
    const one = textLength('first', 2, null);
    expect(wrapLines('first second line', 2, null, textLength('second line', 2, null))).toEqual([
      'first',
      'second line',
    ]);
    expect(wrapLines('a b', 2, null, one * 10)).toEqual(['a b']);
  });
});
