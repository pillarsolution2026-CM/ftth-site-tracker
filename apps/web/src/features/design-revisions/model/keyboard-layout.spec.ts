import { describe, expect, it } from 'vitest';
import { latinize, latinKey } from './keyboard-layout';

describe('commands typed with the Arabic keyboard layout', () => {
  it('a non-Latin key is read by its physical key', () => {
    expect(latinKey({ key: 'ة', code: 'KeyM' })).toBe('m');
    expect(latinKey({ key: 'م', code: 'KeyL' })).toBe('l');
    expect(latinKey({ key: 'ث', code: 'KeyE' })).toBe('e');
    expect(latinKey({ key: '٣', code: 'Digit3' })).toBe('3');
    expect(latinKey({ key: 'و', code: 'Comma' })).toBe(',');
  });

  it('a Latin character, Enter and other keys are left alone', () => {
    expect(latinKey({ key: 'M', code: 'KeyM' })).toBe('M');
    expect(latinKey({ key: '5', code: 'Digit5' })).toBe('5');
    expect(latinKey({ key: 'Enter', code: 'Enter' })).toBe('Enter');
    expect(latinKey({ key: 'ة' })).toBe('ة');
  });

  it('text typed with the Arabic layout becomes the command', () => {
    expect(latinize('ة')).toBe('m');
    expect(latinize('مي')).toBe('ld');
    expect(latinize('ضصث')).toBe('qwe');
    expect(latinize('لا')).toBe('b');
    expect(latinize('٠،٥')).toBe('0,5');
    expect(latinize('line 10,20')).toBe('line 10,20');
  });
});
