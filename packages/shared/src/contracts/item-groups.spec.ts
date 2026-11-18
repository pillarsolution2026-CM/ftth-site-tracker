import { describe, expect, it } from 'vitest';
import { parentCodeOf } from './contract.schemas.js';
import {
  ITEM_GROUP_RULE_IDS,
  SetItemGroupRequestSchema,
  contractItemGroupInputs,
  deriveItemGroup,
  effectiveItemGroup,
  groupTextKey,
  type GroupableLine,
  type ItemGroup,
} from './item-groups.js';
import draft from './__fixtures__/owner-groups-draft.json' with { type: 'json' };

interface DraftRow {
  code: string;
  kind: 'item' | 'heading';
  description: string | null;
  unit: string | null;
  expected: ItemGroup | null;
}

/** A BOQ as the contract stores it: parents through `parentCodeOf`. */
function linesOf(rows: readonly Omit<DraftRow, 'expected'>[]): GroupableLine[] {
  const codes = new Set(rows.map((row) => row.code));
  return rows.map((row, index) => ({
    id: `line-${index}`,
    kind: row.kind,
    code: row.code,
    description: row.description,
    unit: row.unit,
    parentCode: parentCodeOf(row.code, codes),
  }));
}

function groupsOf(rows: readonly Omit<DraftRow, 'expected'>[]): Map<string, ItemGroup | null> {
  const lines = linesOf(rows);
  const inputs = contractItemGroupInputs(lines);
  const result = new Map<string, ItemGroup | null>();
  for (const line of lines) {
    const input = inputs.get(line.id);
    if (input) result.set(line.code, deriveItemGroup(input)?.group ?? null);
  }
  return result;
}

describe('item groups: the owner draft (golden)', () => {
  const rows = draft as DraftRow[];
  const groups = groupsOf(rows);

  it('covers every priced line of the draft', () => {
    expect(rows.filter((row) => row.kind === 'item')).toHaveLength(160);
  });

  it.each(rows.filter((row) => row.kind === 'item').map((row) => [row.code, row] as const))(
    '%s gets the draft groups',
    (_code, row) => {
      expect(groups.get(row.code)).toEqual(row.expected);
    },
  );

  it('gives headings no groups', () => {
    const lines = linesOf(rows);
    const inputs = contractItemGroupInputs(lines);
    for (const line of lines.filter((l) => l.kind === 'heading')) {
      expect(inputs.has(line.id)).toBe(false);
    }
  });
});

describe('item groups: short descriptions under full headings (work-order papers)', () => {
  const rows: Omit<DraftRow, 'expected'>[] = [
    {
      code: '1-8',
      kind: 'heading',
      unit: null,
      description: 'اعمال الحفر للمسارات الرئيسية والثانوية لجميع انواع التربة عدا التربة الصخرية',
    },
    {
      code: '1-8-1',
      kind: 'item',
      unit: 'م3',
      description: 'حفر خنادق لتركيب مواسير مختلفة الأقطار والإعداد حسب الرسومات',
    },
    {
      code: '1-8-2',
      kind: 'heading',
      unit: null,
      description: 'الحفر للرمى المباشر للشبكة الثانوية لجميع أنواع التربه عدا التربة الصخرية',
    },
    { code: '1-8-2-1', kind: 'item', unit: 'م3', description: 'الرصيف 35 × 70 سم' },
    { code: '1-8-2-2', kind: 'item', unit: 'م3', description: 'الشارع 35 × 90 سم' },
    {
      code: '1-9',
      kind: 'heading',
      unit: null,
      description:
        'اعمال الحفر للمسارات الرئيسية والثانوية للتربة الصخرية وتوريد ووضع طبقة من الخرسانة العادية 15 سم',
    },
    {
      code: '1-9-1',
      kind: 'item',
      unit: 'م3',
      description: 'حفر خنادق لتركيب مواسير مختلفة الأقطار والأعداد على ألا يقل المنسوب عن 60 سم',
    },
    {
      code: '1-9-2',
      kind: 'heading',
      unit: null,
      description: 'اعمال الحفر للتربة الصخرية للرمي المباشر للشبكة الثانوية',
    },
    { code: '1-9-2-1', kind: 'item', unit: 'م3', description: 'الرصيف 35 × 50 سم' },
    {
      code: '1-10',
      kind: 'heading',
      unit: null,
      description: '. الحفر بالاسفلت (الحفر الضيق) micro and mini trenchi باستخدام معدة الحفر',
    },
    { code: '1-10-1', kind: 'item', unit: 'م.ط', description: 'عرض 10سم الى 13 سم و عمق 50سم' },
    {
      code: '1-12-2',
      kind: 'heading',
      unit: null,
      description: 'رفع منسوب غرف التفتيش الحالية لمستوى الأسفلت المطلوب',
    },
    { code: '1-12-2-1', kind: 'item', unit: 'عدد', description: 'من 10 سم الى 50 سم' },
    {
      code: '2-1-4',
      kind: 'heading',
      unit: null,
      description: 'تخطية الطرق العمومية والسكك الحديدية والترع باستخدام الدفع الموجه HDD',
    },
    { code: '2-1-4-4', kind: 'item', unit: 'م.ط', description: 'فاروغة قطر4 بوصة من الخارج' },
    {
      code: '2-2-3',
      kind: 'item',
      unit: 'م.ط',
      description:
        'Installation of Directly Buried HDPE Microduct Bundles (1x24Microduct) in open trench',
    },
    {
      code: '2-12-4',
      kind: 'heading',
      unit: null,
      description: 'تركيب وتثبيت ولحام الـ WallMount Fiber Opric Termination Box',
    },
    { code: '2-12-4-2', kind: 'item', unit: 'عدد', description: 'سعة 4 فرعة' },
    {
      code: '2-13',
      kind: 'heading',
      unit: null,
      description: 'تركيب وتثبيت الكابلات على الحوائط H.C لجميع انواع الكوابل',
    },
    { code: '2-13-2', kind: 'item', unit: 'م.ط', description: 'باستخدام قفيز' },
    {
      code: '5-2-2',
      kind: 'item',
      unit: 'BULDING (1 to 8 unit/flat per building)',
      description:
        'أعمال خرائط ما بعد التنفيذ على أن يتم توفير الخرائط المساحية للمشروع بالكامل عن طريق [العميل]',
    },
  ];
  const groups = groupsOf(rows);

  it.each([
    ['1-8-1', { main: 'حفر', sub: 'خنادق مواسير ت عاديه' }],
    ['1-8-2-1', { main: 'حفر', sub: 'ثانوي ت عاديه' }],
    ['1-8-2-2', { main: 'حفر', sub: 'رئيسي ت عاديه' }],
    ['1-9-1', { main: 'حفر', sub: 'خنادق مواسير ت صخرية' }],
    ['1-9-2-1', { main: 'حفر', sub: 'ثانوي ت صخرية' }],
    ['1-10-1', { main: 'حفر', sub: 'ميكرو ترنش' }],
    ['1-12-2-1', { main: 'غرف', sub: 'رفع منسوب غرف' }],
    ['2-1-4-4', { main: 'تخطيات', sub: 'HDD' }],
    ['2-2-3', { main: 'بنادل', sub: '24 انبوبة' }],
    ['2-12-4-2', { main: 'BOX', sub: null }],
    ['2-13-2', { main: 'H.C', sub: null }],
    ['5-2-2', { main: 'As Built', sub: 'لحد 8 وحدات' }],
  ] as const)('%s', (code, expected) => {
    expect(groups.get(code)).toEqual(expected);
  });
});

describe('item groups: lines no rule knows', () => {
  it.each([
    'تركيب كابينة توزيع نحاسية سعة 800 خط فوق الكابينة الحالية',
    'تكسير حوائط خرسانية مسلحة متهالكة',
    'بند جديد غير معروف',
  ])('%s → no group (an error for the admin)', (description) => {
    expect(deriveItemGroup({ description, unit: 'عدد', parents: [] })).toBeNull();
  });

  it('needs a description', () => {
    expect(deriveItemGroup({ description: null, unit: 'عدد', parents: ['تنظيف غرف'] })).toBeNull();
  });
});

describe('effectiveItemGroup', () => {
  const bundle = {
    description: 'سحب حزمة مواسير سعة 12 انبوبة داخل المواسير الحالية',
    unit: 'م.ط',
    parents: [],
  };

  it('uses the rule when nobody chose', () => {
    expect(effectiveItemGroup(bundle, null)).toEqual({
      group: { main: 'بنادل', sub: '12 انبوبة' },
      source: 'rule',
      ruleId: 'bundles',
      ruleGroup: { main: 'بنادل', sub: '12 انبوبة' },
    });
  });

  it('lets a manual choice win and keeps what the rule gives', () => {
    const state = effectiveItemGroup(bundle, { group: { main: 'سحب', sub: null } });
    expect(state.source).toBe('manual');
    expect(state.group).toEqual({ main: 'سحب', sub: null });
    expect(state.ruleGroup).toEqual({ main: 'بنادل', sub: '12 انبوبة' });
  });

  it('goes back to the rule when the manual choice is removed', () => {
    expect(effectiveItemGroup(bundle, { group: null }).source).toBe('rule');
  });

  it('is none when no rule applies and nobody chose', () => {
    expect(effectiveItemGroup({ description: 'بند جديد', unit: 'عدد', parents: [] }, null)).toEqual(
      {
        group: null,
        source: 'none',
        ruleId: null,
        ruleGroup: null,
      },
    );
  });

  it('gives a manually grouped unknown line source manual', () => {
    const state = effectiveItemGroup(
      { description: 'بند جديد', unit: 'عدد', parents: [] },
      { group: { main: 'متنوع', sub: null } },
    );
    expect(state).toMatchObject({ source: 'manual', ruleId: null, ruleGroup: null });
  });
});

describe('groupTextKey', () => {
  it('unifies letter forms, digits, spaces and case', () => {
    expect(groupTextKey('  إنشاء   غرفة  ٣٥ Cutter ')).toBe('انشاء غرفه 35 cutter');
  });
});

describe('SetItemGroupRequestSchema', () => {
  it('accepts a main and a sub group', () => {
    expect(
      SetItemGroupRequestSchema.parse({ main: ' بنادل ', sub: '12 انبوبة', expectedVersion: 3 }),
    ).toEqual({
      main: 'بنادل',
      sub: '12 انبوبة',
      expectedVersion: 3,
    });
  });

  it('accepts main null to go back to the rule', () => {
    expect(SetItemGroupRequestSchema.safeParse({ main: null, expectedVersion: 1 }).success).toBe(
      true,
    );
  });

  it('refuses a sub group without a main group', () => {
    expect(
      SetItemGroupRequestSchema.safeParse({ main: null, sub: 'x', expectedVersion: 1 }).success,
    ).toBe(false);
  });

  it('refuses an empty main group', () => {
    expect(SetItemGroupRequestSchema.safeParse({ main: '  ', expectedVersion: 1 }).success).toBe(
      false,
    );
  });
});

describe('rule ids', () => {
  it('are unique', () => {
    expect(new Set(ITEM_GROUP_RULE_IDS).size).toBe(ITEM_GROUP_RULE_IDS.length);
  });
});
