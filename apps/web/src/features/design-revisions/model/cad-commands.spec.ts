import { describe, expect, it } from 'vitest';
import {
  acadNumber,
  COMMANDS,
  lookupCommand,
  matchOption,
  parseEntry,
  towards,
} from './cad-commands';
import { linearDimension } from './geometry';

describe('command names and aliases (ADR-051)', () => {
  it('finds a command by name or alias, any case, with AutoCAD prefixes', () => {
    expect(lookupCommand('l')).toBe('line');
    expect(lookupCommand('PL')).toBe('pline');
    expect(lookupCommand('_move')).toBe('move');
    expect(lookupCommand('.Co')).toBe('copy');
    expect(lookupCommand('dli')).toBe('dimlinear');
    expect(lookupCommand('LAYMCUR')).toBe('laymcur');
    expect(lookupCommand('ARRAY')).toBeNull();
    expect(lookupCommand('TABLE')).toBeNull();
  });
  it('has the aliases the owner asked for, each once', () => {
    const wanted: Record<string, string> = {
      L: 'line',
      PL: 'pline',
      C: 'circle',
      A: 'arc',
      REC: 'rectang',
      M: 'move',
      CO: 'copy',
      S: 'stretch',
      RO: 'rotate',
      MI: 'mirror',
      SC: 'scale',
      TR: 'trim',
      F: 'fillet',
      E: 'erase',
      O: 'offset',
      J: 'join',
      T: 'text',
      DLI: 'dimlinear',
      LE: 'leader',
      LA: 'layer',
      MA: 'matchprop',
    };
    for (const [alias, id] of Object.entries(wanted)) expect(lookupCommand(alias)).toBe(id);
    const all = Object.values(COMMANDS).flatMap((c) => [c.name, ...c.aliases]);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('typed entries', () => {
  const last = { x: 10, y: 5 };
  it('reads absolute, relative and polar points', () => {
    expect(parseEntry('3,4', last)).toEqual({ kind: 'point', point: { x: 3, y: 4 } });
    expect(parseEntry(' -1.5 , .5 ', last)).toEqual({ kind: 'point', point: { x: -1.5, y: 0.5 } });
    expect(parseEntry('#3,4', last)).toEqual({ kind: 'point', point: { x: 3, y: 4 } });
    expect(parseEntry('@2,-1', last)).toEqual({ kind: 'point', point: { x: 12, y: 4 } });
    const polar = parseEntry('@10<90', last);
    expect(polar.kind).toBe('point');
    if (polar.kind === 'point') {
      expect(polar.point.x).toBeCloseTo(10, 9);
      expect(polar.point.y).toBeCloseTo(15, 9);
    }
    expect(parseEntry('@1,1', null)).toEqual({ kind: 'bad' });
  });
  it('reads numbers, words and nothing', () => {
    expect(parseEntry('25', last)).toEqual({ kind: 'number', value: 25 });
    expect(parseEntry('-0.5', last)).toEqual({ kind: 'number', value: -0.5 });
    expect(parseEntry('c', last)).toEqual({ kind: 'word', word: 'C' });
    expect(parseEntry('3P', last)).toEqual({ kind: 'bad' });
    expect(parseEntry('', last)).toEqual({ kind: 'empty' });
    expect(parseEntry('1,2,3', last)).toEqual({ kind: 'bad' });
  });
  it('direct distance goes toward the pointer', () => {
    expect(towards({ x: 0, y: 0 }, { x: 0, y: 7 }, 3)).toEqual({ x: 0, y: 3 });
    expect(towards({ x: 0, y: 0 }, null, 3)).toEqual({ x: 3, y: 0 });
  });
  it('options match their short form or the whole word', () => {
    const options = [
      { word: 'Close', key: 'C' },
      { word: 'Undo', key: 'U' },
    ];
    expect(matchOption(options, 'c')).toBe('C');
    expect(matchOption(options, 'undo')).toBe('U');
    expect(matchOption(options, 'x')).toBeNull();
    expect(acadNumber(2.5)).toBe('2.5000');
  });
});

describe('DIMLINEAR placement', () => {
  it('above the points measures X; beside them measures Y', () => {
    const h = linearDimension([0, 0], [10, 4], [5, 8]);
    expect(h).toMatchObject({ direction: 'horizontal', value: 10, middle: [5, 8] });
    expect(h.line).toEqual([
      [0, 8],
      [10, 8],
    ]);
    const v = linearDimension([0, 0], [10, 4], [15, 2]);
    expect(v).toMatchObject({ direction: 'vertical', value: 4 });
    expect(v.extensions[1]).toEqual([
      [10, 4],
      [15, 4],
    ]);
  });
});
