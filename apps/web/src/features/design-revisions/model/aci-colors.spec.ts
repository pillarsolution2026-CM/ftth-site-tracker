import { describe, expect, it } from 'vitest';
import { ACI_PALETTE, aciHex, aciOf, colorLabel, parseColor, rgbText } from './aci-colors';
import { BY_LAYER_STYLE, currentPatch, currentStyleEdits } from './properties';

describe('AutoCAD index colours (item 34)', () => {
  it('has the 255 colours: 1-9 named, the hues in shades, the greys', () => {
    expect(ACI_PALETTE).toHaveLength(255);
    expect(aciHex(1)).toBe('#ff0000');
    expect(aciHex(10)).toBe('#ff0000');
    expect(aciHex(11)).toBe('#ff8080');
    expect(aciHex(12)).toBe('#cc0000');
    expect(aciHex(30)).toBe('#ff8000');
    expect(aciHex(250)).toBe('#333333');
    expect(aciHex(255)).toBe('#ffffff');
    expect(aciHex(0)).toBeNull();
    expect(aciHex(256)).toBeNull();
  });

  it('names colours as AutoCAD: ByLayer, Red, Color n, r,g,b', () => {
    expect(colorLabel(null)).toBe('ByLayer');
    expect(colorLabel('#ff0000')).toBe('Red');
    expect(colorLabel('#ff8000')).toBe('Color 30');
    expect(colorLabel('#123456')).toBe('18,52,86');
    expect(aciOf('#FF0000')).toBe(1);
    expect(rgbText('#0a141e')).toBe('10,20,30');
  });

  it('reads a True Color typed as r,g,b or #rrggbb', () => {
    expect(parseColor('10, 20, 30')).toBe('#0a141e');
    expect(parseColor('#ABCDEF')).toBe('#abcdef');
    expect(parseColor('256,0,0')).toBeNull();
    expect(parseColor('red')).toBeNull();
  });
});

describe('current properties for new objects (CECOLOR, CELTYPE, CELWEIGHT)', () => {
  it('a new object gets a set_style naming it, none when all are ByLayer', () => {
    expect(currentStyleEdits(BY_LAYER_STYLE, 'NEW-1')).toEqual([]);
    // Transparency alone is screen only: no style is saved for it.
    expect(currentStyleEdits({ ...BY_LAYER_STYLE, transparency: 50 }, 'NEW-1')).toEqual([]);
    expect(
      currentStyleEdits({ ...BY_LAYER_STYLE, color: '#ff0000', lineweight: 0.3 }, 'NEW-7'),
    ).toEqual([
      { kind: 'set_style', handle: 'NEW-7', color: '#ff0000', linetype: null, lineweight: 0.3 },
    ]);
  });

  it('a palette cell changes one current property; a bad transparency is refused', () => {
    expect(currentPatch('color', '')).toEqual({ color: null });
    expect(currentPatch('lineweight', '0.25')).toEqual({ lineweight: 0.25 });
    expect(currentPatch('transparency', '40')).toEqual({ transparency: 40 });
    expect(currentPatch('transparency', 'ByLayer')).toEqual({ transparency: null });
    expect(currentPatch('transparency', '95')).toBeNull();
    expect(currentPatch('layer', 'Route')).toBeNull();
  });
});
