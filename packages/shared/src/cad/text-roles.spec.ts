import { describe, expect, it } from 'vitest';
import {
  CadMappingInputSchema,
  MappingRuleSchema,
  mappingKindProblems,
  readingModeOf,
  type MappingRule,
} from './cad-mapping.schemas.js';
import {
  boxCode,
  cabinetNameKey,
  handholeTypeOf,
  readRoleText,
  suggestBundleWays,
  suggestTextRoles,
  TEXT_ROLES,
  TEXT_ROLES_BY_KIND,
  textRoleFitsTarget,
  writtenMetres3,
} from './text-roles.js';

describe('reading role texts (ADR-041, Al-Fath examples)', () => {
  it('reads the Secondary box texts', () => {
    expect(readRoleText('9', ['box_number'])).toEqual({ role: 'box_number', number: '9' });
    expect(readRoleText(' 1 - 3 ', ['box_cabinet'])).toEqual({
      role: 'box_cabinet',
      cabinet: '1-3',
    });
    expect(readRoleText('F4C', ['box_cable_type'])).toEqual({ role: 'box_cable_type', cores: 4 });
    expect(readRoleText('398M', ['box_cable_length'])).toEqual({
      role: 'box_cable_length',
      lengthM: '398.000',
    });
  });

  it('reads Secondary bundle labels: type + duct, and the length as its own text', () => {
    expect(readRoleText('1way 7/3.5', ['bundle_label'])).toEqual({
      role: 'bundle_label',
      ways: 1,
      ductSize: '7/3.5',
      lengthM: null,
    });
    expect(readRoleText('12way 7/3.5', ['bundle_label'])).toMatchObject({ ways: 12 });
    expect(readRoleText('455.0M', ['bundle_label'])).toEqual({
      role: 'bundle_label',
      ways: null,
      ductSize: null,
      lengthM: '455.000',
    });
  });

  it('reads spares: «SPn(7/3.5)» on a bundle, «SP 48» on a cable', () => {
    expect(readRoleText('SP3(7/3.5)', ['bundle_spare'])).toEqual({
      role: 'bundle_spare',
      count: 3,
      ductSize: '7/3.5',
    });
    expect(readRoleText('SP 48', ['cable_spare'])).toEqual({ role: 'cable_spare', cores: 48 });
  });

  it('reads the General segment labels on one layer with several roles (EXCH)', () => {
    const exch = ['bundle_label', 'cable_label', 'cable_spare'] as const;
    expect(readRoleText('500M/4way 16/12', exch)).toEqual({
      role: 'bundle_label',
      ways: 4,
      ductSize: '16/12',
      lengthM: '500.000',
    });
    expect(readRoleText('520M/144Core F.O(elfath)', exch)).toEqual({
      role: 'cable_label',
      cores: 144,
      lengthM: '520.000',
    });
    expect(readRoleText('SP 48', exch)).toEqual({ role: 'cable_spare', cores: 48 });
    expect(readRoleText('street name', exch)).toBeNull();
    // Al-Fath General writes one bundle as «1x4 way» (one bundle of 4 ways).
    expect(readRoleText('450m/1x4 way 16/12', exch)).toEqual({
      role: 'bundle_label',
      ways: 4,
      ductSize: '16/12',
      lengthM: '450.000',
    });
  });

  it('reads handholes: type list first, then the number', () => {
    const roles = ['handhole_number', 'handhole_type'] as const;
    expect(readRoleText('04A', roles)).toEqual({ role: 'handhole_number', number: '04A' });
    expect(readRoleText('CH01', roles)).toEqual({ role: 'handhole_number', number: 'CH01' });
    expect(readRoleText('HH1', roles)).toEqual({
      role: 'handhole_type',
      type: 'HH-I',
      written: 'HH1',
    });
    expect(readRoleText('DH', roles)).toMatchObject({ type: 'DH' });
    expect(readRoleText('CH', roles)).toMatchObject({ type: 'HH-II' });
    expect(readRoleText('MH-IV', roles)).toMatchObject({ type: 'MH-IV' });
    // Looks like a type, not in the list → HANDHOLE_TYPE_UNKNOWN later.
    expect(readRoleText('HH3', roles)).toEqual({
      role: 'handhole_type',
      type: null,
      written: 'HH3',
    });
  });

  it('reads the cabinet circle texts', () => {
    const r = (t: string) => readRoleText(t, ['cabinet_info']);
    expect(r('1-7')).toEqual({ role: 'cabinet_info', field: 'name', value: '1-7' });
    expect(r('22U')).toEqual({ role: 'cabinet_info', field: 'type', value: '22U' });
    expect(r('22B')).toEqual({ role: 'cabinet_info', field: 'box_count', value: '22' });
    expect(r('2P')).toEqual({ role: 'cabinet_info', field: 'ports', value: '2' });
    expect(r('Joint 144')).toBeNull();
  });

  it('ignores roles the layer does not carry, and empty texts', () => {
    expect(readRoleText('9', ['box_cabinet'])).toBeNull();
    expect(readRoleText('   ', TEXT_ROLES)).toBeNull();
  });

  it('normalises written lengths to 3 decimals without floats', () => {
    expect(writtenMetres3('10')).toBe('10.000');
    expect(writtenMetres3('10.0')).toBe('10.000');
    expect(writtenMetres3('0455.5')).toBe('455.500');
    expect(writtenMetres3('12.3456')).toBe('12.346');
    expect(writtenMetres3('0.0004')).toBe('0.000');
  });
});

describe('roles, kinds and identities', () => {
  it('fits roles to label layers or their own feature layer only', () => {
    expect(textRoleFitsTarget('cabinet_info', 'label')).toBe(true);
    expect(textRoleFitsTarget('cabinet_info', 'cabinet')).toBe(true);
    expect(textRoleFitsTarget('cabinet_info', 'box')).toBe(false);
    expect(textRoleFitsTarget('bundle_label', 'route')).toBe(true);
  });

  it('splits roles by drawing kind', () => {
    expect(TEXT_ROLES_BY_KIND.secondary).toContain('box_number');
    expect(TEXT_ROLES_BY_KIND.general).not.toContain('box_number');
    expect(TEXT_ROLES_BY_KIND.general).toContain('handhole_type');
    expect(TEXT_ROLES_BY_KIND.secondary).not.toContain('cable_label');
  });

  it('matches handhole types and cabinet names loosely, builds box codes', () => {
    expect(handholeTypeOf(' hh-ii ')).toBe('HH-II');
    expect(handholeTypeOf('HH2')).toBeNull();
    expect(cabinetNameKey(' 1 - 7 ')).toBe(cabinetNameKey('1-7'));
    expect(boxCode('1-3', ' 9 ')).toBe('1-3/9');
  });

  it('suggests ways from a layer name and roles from sample texts', () => {
    expect(suggestBundleWays('1X12w Line')).toBe(12);
    expect(suggestBundleWays('OUTER DUCT 4 WAY PRIMARY')).toBe(4);
    expect(suggestBundleWays('Single 1w Line')).toBe(1);
    expect(suggestBundleWays('CABINA')).toBeNull();
    expect(suggestTextRoles('secondary', 'label', [{ text: '9', count: 150 }])).toEqual([
      'box_number',
    ]);
    expect(
      suggestTextRoles('secondary', 'cabinet', [
        { text: '1-7', count: 1 },
        { text: '22U', count: 1 },
      ]),
    ).toEqual(['cabinet_info']);
    expect(suggestTextRoles('general', 'label', [{ text: '04A', count: 3 }])).toEqual([
      'handhole_number',
    ]);
    expect(suggestTextRoles('general', 'label', [{ text: 'street', count: 3 }])).toEqual([]);
  });
});

describe('mapping rules with meaning (ADR-041)', () => {
  const base = { crsEpsg: 32636, drawingUnit: 'm', version: null } as const;

  it('accepts text roles, ways and zone layers', () => {
    const parsed = CadMappingInputSchema.parse({
      ...base,
      rules: [
        { source: 'layer', layer: 'TXTNMPER', target: 'label', textRoles: ['box_number'] },
        {
          source: 'layer',
          layer: 'CABINA',
          target: 'cabinet',
          role: 'sub',
          textRoles: ['cabinet_info'],
        },
        { source: 'layer', layer: 'ftth', target: 'route', kind: '1way', ways: 1 },
        { source: 'layer', layer: 'ZONE', target: 'zone' },
      ],
    });
    expect(parsed.rules).toHaveLength(4);
  });

  it('refuses roles on the wrong target, duplicates, ways off routes, attrs on zones', () => {
    const bad = [
      { source: 'layer', layer: 'A', target: 'box', textRoles: ['cabinet_info'] },
      { source: 'layer', layer: 'A', target: 'label', textRoles: ['box_number', 'box_number'] },
      { source: 'layer', layer: 'A', target: 'label', textRoles: [] },
      { source: 'layer', layer: 'A', target: 'box', ways: 4 },
      { source: 'layer', layer: 'A', target: 'zone', kind: 'x' },
      { source: 'block', block: 'B', target: 'box', textRoles: ['box_number'] },
    ];
    for (const rule of bad) {
      const parsed = MappingRuleSchema.safeParse(rule);
      // The block rule's unknown key is stripped: it parses but carries no roles.
      if (rule.source === 'block') expect(parsed.success && 'textRoles' in parsed.data).toBe(false);
      else expect(parsed.success).toBe(false);
    }
  });

  it('keeps old mappings in legacy reading mode', () => {
    const legacy: MappingRule[] = [{ source: 'layer', layer: 'BOX', target: 'box' }];
    const zone: MappingRule = { source: 'layer', layer: 'Z', target: 'zone' };
    const role: MappingRule = {
      source: 'layer',
      layer: 'T',
      target: 'label',
      textRoles: ['box_cabinet'],
    };
    expect(readingModeOf(legacy)).toBe('legacy');
    expect(readingModeOf([...legacy, zone])).toBe('roles');
    expect(readingModeOf([...legacy, role])).toBe('roles');
  });

  it('finds rules that do not belong to the drawing kind', () => {
    const rules: MappingRule[] = [
      { source: 'layer', layer: 'T', target: 'label', textRoles: ['box_number', 'cabinet_info'] },
      { source: 'layer', layer: 'Z', target: 'zone' },
    ];
    expect(mappingKindProblems(rules, 'secondary')).toEqual([]);
    expect(mappingKindProblems(rules, 'general')).toEqual([
      { index: 0, reason: 'ROLE_NOT_FOR_KIND', role: 'box_number' },
      { index: 1, reason: 'ZONE_NOT_FOR_KIND', role: null },
    ]);
  });
});

describe('hostile input (ReDoS guard)', () => {
  it('reads "1" + 1998 spaces + "Z" as nothing, fast', () => {
    const text = `1${' '.repeat(1998)}Z`;
    const started = performance.now();
    expect(readRoleText(text, ['cable_label'])).toBeNull();
    expect(readRoleText(text, ['bundle_label'])).toBeNull();
    expect(suggestBundleWays(text)).toBeNull();
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('skips role texts longer than 64 characters', () => {
    expect(readRoleText(`${'1'.repeat(70)}Core`, ['cable_label'])).toBeNull();
    expect(readRoleText('12Core', ['cable_label'])).toMatchObject({ role: 'cable_label' });
  });
});

describe('hostile input (ReDoS guard)', () => {
  it('reads "1" + 1998 spaces + "Z" as nothing, fast', () => {
    const text = `1${' '.repeat(1998)}Z`;
    const started = performance.now();
    expect(readRoleText(text, ['cable_label'])).toBeNull();
    expect(readRoleText(text, ['bundle_label'])).toBeNull();
    expect(suggestBundleWays(text)).toBeNull();
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('skips role texts longer than 64 characters', () => {
    expect(readRoleText(`${'1'.repeat(70)}Core`, ['cable_label'])).toBeNull();
    expect(readRoleText('12Core', ['cable_label'])).toMatchObject({ role: 'cable_label' });
  });
});
