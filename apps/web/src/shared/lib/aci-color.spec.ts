import { describe, expect, it } from 'vitest';
import { aciToCss, trueColorToCss } from './aci-color';

describe('aciToCss', () => {
  it('maps the basic and grey indexes', () => {
    expect(aciToCss(1)).toBe('#FF0000');
    expect(aciToCss(7)).toBe('#FFFFFF');
    expect(aciToCss(252)).toBe('#696969');
  });

  it('matches known palette entries', () => {
    expect(aciToCss(10)).toBe('#FF0000');
    expect(aciToCss(11)).toBe('#FF7F7F');
    expect(aciToCss(12)).toBe('#A50000');
    expect(aciToCss(30)).toBe('#FF7F00');
    expect(aciToCss(40)).toBe('#FFBF00');
  });

  it('formats true colours', () => {
    expect(trueColorToCss(0x00ff7f)).toBe('#00FF7F');
  });
});
