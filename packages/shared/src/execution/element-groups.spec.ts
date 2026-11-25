import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ELEMENT_GROUPS,
  ELEMENT_KEYS,
  ReplaceElementGroupsRequestSchema,
  elementKeyOf,
  groupsForElement,
  isCubicMetreUnit,
  lineNeedsDimensions,
  volumeOf,
} from './element-groups.js';
import { RecordUpdatePayloadSchema } from './execution.schemas.js';

describe('elementKeyOf (ADR-056)', () => {
  it('maps a route and a ring by drawing kind, rooms of any type to room', () => {
    expect(elementKeyOf('route', 'general')).toBe('route_general');
    expect(elementKeyOf('route', 'secondary')).toBe('route_secondary');
    expect(elementKeyOf('ring', 'secondary')).toBe('route_secondary');
    expect(elementKeyOf('hhi', 'general')).toBe('room');
    expect(elementKeyOf('mh', 'secondary')).toBe('room');
    expect(elementKeyOf('cabinet', 'secondary')).toBe('cabinet');
    expect(elementKeyOf('box', 'secondary')).toBe('box');
    expect(elementKeyOf('joint', 'general')).toBe('joint');
  });
});

describe('DEFAULT_ELEMENT_GROUPS (owner 2026-11-25)', () => {
  it('covers every element and keeps copper cables on the General route only', () => {
    expect(Object.keys(DEFAULT_ELEMENT_GROUPS).sort()).toEqual([...ELEMENT_KEYS].sort());
    expect(DEFAULT_ELEMENT_GROUPS.route_general).toHaveLength(15);
    expect(DEFAULT_ELEMENT_GROUPS.route_secondary).toHaveLength(14);
    expect(DEFAULT_ELEMENT_GROUPS.route_general).toContain('كابلات نحاس');
    expect(DEFAULT_ELEMENT_GROUPS.route_secondary).not.toContain('كابلات نحاس');
    expect(DEFAULT_ELEMENT_GROUPS.cabinet).toEqual([
      'قاعدة كابينة',
      'كابينه',
      'ODF',
      'مقسم اشارة',
      'RACK',
    ]);
    expect(DEFAULT_ELEMENT_GROUPS.box).toEqual(['BOX', 'أعمال الدفع الهوائي', 'مقسم اشارة']);
    expect(DEFAULT_ELEMENT_GROUPS.planning).toEqual(['As Built', 'GIS', 'AS PLAN']);
  });
});

describe('groupsForElement', () => {
  const item = (id: string, main: string | null, sub: string | null = null) => ({
    id,
    group: main === null ? null : { main, sub },
  });
  const catalog = [
    item('a', 'بنادل', '24 انبوبة'),
    item('b', 'بنادل', '12 انبوبة'),
    item('c', 'بنادل', '24 انبوبة'),
    item('d', 'كونيكتور'),
    item('e', 'ODF'),
    item('f', null),
  ];
  const map = [{ element: 'route_secondary' as const, mains: ['حفر', 'بنادل', 'كونيكتور'] }];

  it('keeps map order, drops groups without lines, buckets by sub group', () => {
    const groups = groupsForElement(map, 'route_secondary', catalog);
    expect(groups.map((g) => g.main)).toEqual(['بنادل', 'كونيكتور']);
    expect(groups[0]?.subs.map((s) => [s.sub, s.items.map((i) => i.id)])).toEqual([
      ['24 انبوبة', ['a', 'c']],
      ['12 انبوبة', ['b']],
    ]);
    expect(groups[1]?.subs).toEqual([{ sub: null, items: [catalog[3]] }]);
  });

  it('is empty for an element missing from the map', () => {
    expect(groupsForElement(map, 'cabinet', catalog)).toEqual([]);
  });
});

describe('dimensions', () => {
  it('recognises cubic metre units', () => {
    for (const unit of ['م3', 'م٣', ' م 3 ', 'M3', 'م³']) expect(isCubicMetreUnit(unit)).toBe(true);
    for (const unit of ['م.ط', 'عدد', 'م2']) expect(isCubicMetreUnit(unit)).toBe(false);
  });

  it('needs dimensions only on digging m3 lines', () => {
    expect(lineNeedsDimensions('م3', { main: 'حفر', sub: 'رئيسي ت عاديه' })).toBe(true);
    expect(lineNeedsDimensions('م3', { main: 'طبقة خرسانية', sub: 'عادية' })).toBe(true);
    expect(lineNeedsDimensions('م.ط', { main: 'حفر', sub: 'ميكرو ترنش' })).toBe(false);
    expect(lineNeedsDimensions('م3', { main: 'طبقة إحلال', sub: 'رمل ناعم' })).toBe(false);
    expect(lineNeedsDimensions('م3', null)).toBe(false);
  });

  it('multiplies exactly and rounds half up to 4 decimals', () => {
    expect(volumeOf({ lengthM: '10', widthM: '0.35', depthM: '0.9' })).toBe('3.15');
    expect(volumeOf({ lengthM: '1', widthM: '1', depthM: '1' })).toBe('1');
    expect(volumeOf({ lengthM: '0.0001', widthM: '0.5', depthM: '1' })).toBe('0.0001');
    expect(volumeOf({ lengthM: '0.0001', widthM: '0.4', depthM: '1' })).toBe('0');
    expect(volumeOf({ lengthM: '12.3456', widthM: '0.35', depthM: '0.7' })).toBe('3.0247');
  });
});

describe('RecordUpdatePayloadSchema (ADR-056)', () => {
  const base = {
    designRevisionId: '00000000-0000-4000-8000-000000000002',
    workType: 'civil',
    label: null,
    note: null,
    gps: null,
    photos: [
      {
        photoId: '00000000-0000-4000-8000-000000000003',
        requirementKey: 'general',
        sha256: 'a'.repeat(64),
        sizeBytes: 10,
        contentType: 'image/jpeg',
        takenAt: '2026-11-25T10:00:00+02:00',
        gps: null,
      },
    ],
    acknowledgedWarnings: [],
  };
  const line = (extra: object) => ({
    workOrderItemId: '00000000-0000-4000-8000-000000000004',
    role: 'work',
    performer: { kind: 'self' },
    ...extra,
  });

  it('accepts a dimensioned line whose quantity is the product', () => {
    const parsed = RecordUpdatePayloadSchema.safeParse({
      ...base,
      featureId: '00000000-0000-4000-8000-000000000001',
      lines: [
        line({ quantity: '3.15', dimensions: { lengthM: '10', widthM: '0.35', depthM: '0.9' } }),
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses a quantity that is not the product', () => {
    const parsed = RecordUpdatePayloadSchema.safeParse({
      ...base,
      featureId: '00000000-0000-4000-8000-000000000001',
      lines: [
        line({ quantity: '3', dimensions: { lengthM: '10', widthM: '0.35', depthM: '0.9' } }),
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it('needs a drawing when no element is tapped («التخطيط»)', () => {
    const noDrawing = RecordUpdatePayloadSchema.safeParse({
      ...base,
      featureId: null,
      lines: [line({ quantity: '1' })],
    });
    expect(noDrawing.success).toBe(false);
    const withDrawing = RecordUpdatePayloadSchema.safeParse({
      ...base,
      featureId: null,
      drawingId: '00000000-0000-4000-8000-000000000005',
      lines: [line({ quantity: '1' })],
    });
    expect(withDrawing.success).toBe(true);
  });
});

describe('ReplaceElementGroupsRequestSchema', () => {
  it('refuses a duplicate main group', () => {
    expect(
      ReplaceElementGroupsRequestSchema.safeParse({ mains: ['حفر', 'حفر'], expectedVersion: 1 })
        .success,
    ).toBe(false);
  });
});
