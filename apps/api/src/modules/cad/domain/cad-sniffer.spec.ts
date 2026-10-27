import { describe, expect, it } from 'vitest';
import { declaredFormat, verifyCadContent } from './cad-sniffer.js';

const bytes = (text: string) => Buffer.from(text, 'latin1');
const asciiDxf = '  0\r\nSECTION\r\n  2\r\nHEADER\r\n';

describe('declaredFormat', () => {
  it.each([
    ['plan.dwg', 'dwg'],
    ['PLAN.DXF', 'dxf'],
    ['a.b.c.dwg', 'dwg'],
  ])('%s is %s', (name, format) => {
    expect(declaredFormat(name)).toBe(format);
  });

  it.each(['plan.pdf', 'plan', 'plan.dwg.exe', 'dwg', ''])('refuses %j', (name) => {
    expect(() => declaredFormat(name)).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_FILE' }),
    );
  });
});

describe('verifyCadContent', () => {
  it('accepts DWG files that start with AC10 + 2 digits', () => {
    expect(() => verifyCadContent('dwg', bytes('AC1032\0\0\0'))).not.toThrow();
    expect(() => verifyCadContent('dwg', bytes('AC1015'))).not.toThrow();
  });

  it.each(['AC1.50', 'AC20xx', 'AC10', '%PDF-1.7', '', asciiDxf])('refuses %j as DWG', (head) => {
    expect(() => verifyCadContent('dwg', bytes(head))).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_FILE' }),
    );
  });

  it('accepts ASCII DXF, with comments, BOM and different line endings', () => {
    expect(() => verifyCadContent('dxf', bytes(asciiDxf))).not.toThrow();
    expect(() => verifyCadContent('dxf', bytes('0\nSECTION\n2\nHEADER\n'))).not.toThrow();
    expect(() =>
      verifyCadContent('dxf', bytes('999\nexported by tool\n999\nsecond comment\n0\nSECTION\n')),
    ).not.toThrow();
    expect(() => verifyCadContent('dxf', Buffer.from('﻿0\nSECTION\n', 'utf8'))).not.toThrow();
  });

  it('accepts binary DXF', () => {
    expect(() =>
      verifyCadContent('dxf', bytes('AutoCAD Binary DXF\r\n\x1a\0\x00SECTION')),
    ).not.toThrow();
  });

  it.each([
    '',
    'AC1032',
    '%PDF-1.7',
    '0\nENDSEC\n',
    '999\ncomment only\n',
    '2\nSECTION\n',
    'PK\u0003\u0004',
  ])('refuses %j as DXF', (head) => {
    expect(() => verifyCadContent('dxf', bytes(head))).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_FILE' }),
    );
  });
});
