import { describe, expect, it } from 'vitest';
import { resolveCommand, suggestCommands } from './cad-commands';

/** Item 33: AutoCAD's command-line AutoComplete (names, aliases, mid-word, Enter takes the first). */

const names = (typed: string) => suggestCommands(typed).map((s) => s.label);

describe('AutoComplete of the command line', () => {
  it('«jo» + Enter is JOIN, not «Unknown command "JO"» (bug)', () => {
    expect(resolveCommand('jo')).toBe('join');
    expect(resolveCommand('JOI')).toBe('join');
  });
  it('an exact name or alias comes first', () => {
    expect(suggestCommands('l')[0]?.id).toBe('line');
    expect(suggestCommands('C')[0]?.id).toBe('circle');
    expect(suggestCommands('co')[0]?.id).toBe('copy');
    expect(suggestCommands('line')[0]?.id).toBe('line');
    expect(resolveCommand('M')).toBe('move');
  });
  it('names that start with the text come next, alphabetically', () => {
    const la = names('LA');
    expect(la[0]).toBe('LA (LAYER)');
    // LAYER is already first (its alias), so it is not listed twice.
    expect(la.slice(1, 4)).toEqual(['LAYCUR', 'LAYDEL', 'LAYERP']);
  });
  it('aliases that start with the text are offered with their command', () => {
    expect(names('dl')).toContain('DLI (DIMLINEAR)');
    expect(resolveCommand('dl')).toBe('dimlinear');
  });
  it('mid-word matches come after the prefix matches', () => {
    const oin = names('OIN');
    expect(oin).toEqual(['BREAKATPOINT', 'JOIN', 'POINT']);
    const tr = suggestCommands('TR');
    const firstMid = tr.findIndex((s) => s.mid);
    const lastPrefix = tr.map((s) => s.mid).lastIndexOf(false);
    expect(firstMid).toBeGreaterThan(lastPrefix);
    expect(tr.find((s) => s.mid)?.label).toMatch(/TR/);
  });
  it('each command once; AutoCAD prefixes _ and . allowed; nothing for nonsense', () => {
    const all = suggestCommands('L').map((s) => s.id);
    expect(new Set(all).size).toBe(all.length);
    expect(resolveCommand('_jo')).toBe('join');
    expect(suggestCommands('')).toEqual([]);
    expect(suggestCommands('QQQZ')).toEqual([]);
    expect(resolveCommand('QQQZ')).toBeNull();
    expect(resolveCommand('3,4')).toBeNull();
  });
});
