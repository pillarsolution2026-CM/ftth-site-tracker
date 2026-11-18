import { z } from 'zod';

/**
 * Item groups (جروبات البنود), ADR-048, owner 2026-11-18.
 *
 * Every priced line of a contract BOQ has a main group (جروب الأعمال الرئيسي, e.g. «بنادل») and an
 * optional sub group (جروب الأعمال الفرعي, e.g. «12 انبوبة»). The groups are NOT uploaded per
 * contract: they are a fixed system rule. The system reads each line's description (and the
 * headings above it, and its unit) and derives its groups. The rules below were written from the
 * owner's groups draft («اقتراح جروبات العقد - في C و D.xlsx», edited by the owner, 2026-11-16).
 *
 * - A line no rule can group is an error shown to the admin, who sets its groups by hand.
 * - The admin may change the groups of any line at any time, also after approval. A manual choice
 *   wins over the rule (see `effectiveItemGroup`).
 * - Headings never have groups.
 * - Execution, takeoff and certificates use the grouped copy of the BOQ (later phases); quantities
 *   stay on the line, so changing a line's group never moves a recorded quantity.
 */

export const GROUP_NAME_MAX = 80;

const GroupNameSchema = z.string().trim().min(1).max(GROUP_NAME_MAX);

/** The groups of one priced line. */
export const ItemGroupSchema = z.object({
  main: z.string(),
  /** Null when the main group has no sub groups (e.g. «كونيكتور»). */
  sub: z.string().nullable(),
});
export type ItemGroup = z.infer<typeof ItemGroupSchema>;

/**
 * `rule` = derived by the system rule `ruleId`; `manual` = set by an admin; `none` = no rule
 * matched and nobody set it (an error to fix). Headings carry `null` instead of a group state.
 */
export const ITEM_GROUP_SOURCES = ['rule', 'manual', 'none'] as const;
export const ItemGroupSourceSchema = z.enum(ITEM_GROUP_SOURCES);
export type ItemGroupSource = z.infer<typeof ItemGroupSourceSchema>;

export const ItemGroupStateSchema = z.object({
  /** Null only when `source` is `none`. */
  group: ItemGroupSchema.nullable(),
  source: ItemGroupSourceSchema,
  /** The rule that matched (also shown when a manual choice overrides it). */
  ruleId: z.string().nullable(),
  /** What the rule gives, so the admin can compare with a manual choice. Null when no rule matched. */
  ruleGroup: ItemGroupSchema.nullable(),
});
export type ItemGroupState = z.infer<typeof ItemGroupStateSchema>;

/**
 * PUT /admin/contracts/:contractId/items/:itemId/group (admin, draft or approved).
 * `main: null` removes the manual choice: the line goes back to the rule (or to «no group»).
 */
export const SetItemGroupRequestSchema = z
  .strictObject({
    main: GroupNameSchema.nullable(),
    sub: GroupNameSchema.nullable().optional(),
    expectedVersion: z.number().int().min(1),
  })
  .refine((body) => body.main !== null || body.sub === undefined || body.sub === null, {
    message: 'A sub group needs a main group',
    path: ['sub'],
  });
export type SetItemGroupRequest = z.infer<typeof SetItemGroupRequestSchema>;

// ---------- the rule ----------

/** What the rule reads for one line. `parents`: the headings/lines above it, nearest first. */
export interface ItemGroupInput {
  description: string | null;
  unit: string | null;
  parents: readonly (string | null)[];
}

export interface ItemGroupMatch {
  group: ItemGroup;
  ruleId: string;
}

/**
 * Text form used by the rules: Arabic letter forms unified (أإآ→ا, ة→ه, ى→ي), diacritics and
 * tatweel removed, Arabic-Indic digits → ASCII, spaces collapsed, lower case.
 */
export function groupTextKey(text: string | null | undefined): string {
  if (text === null || text === undefined) return '';
  return text
    .normalize('NFC')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

interface Ctx {
  /** The line's own description. */
  self: string;
  /** The texts above it, nearest first. */
  up: readonly string[];
  /** self + every parent: for words that may sit in a heading. */
  all: string;
  unit: string;
}

const has = (text: string, ...words: string[]): boolean => words.every((w) => text.includes(w));
const hasAny = (text: string, ...words: string[]): boolean => words.some((w) => text.includes(w));

/** The first text, self then parents, that contains `word`. */
function nearestWith(c: Ctx, word: string): string | null {
  for (const text of [c.self, ...c.up]) if (text.includes(word)) return text;
  return null;
}

type Soil = 'عادية' | 'صخرية';

/** Soil from the nearest text that says it. «عدا التربة الصخرية» means normal soil. */
function soilOf(c: Ctx): Soil | null {
  for (const text of [c.self, ...c.up]) {
    if (text.includes('عدا التربه الصخريه')) return 'عادية';
    if (text.includes('صخري')) return 'صخرية';
    if (text.includes('تربه العاديه')) return 'عادية';
  }
  return null;
}

/** Labels exactly as in the owner's draft. */
const soilLabel = (soil: Soil): string => (soil === 'عادية' ? 'ت عاديه' : 'ت صخرية');

interface Rule {
  id: string;
  /** Returns the groups, or null when the rule does not apply. */
  apply: (c: Ctx) => ItemGroup | null;
}

const g = (main: string, sub: string | null = null): ItemGroup => ({ main, sub });

/** Ordered: the first rule that applies wins. */
const RULES: readonly Rule[] = [
  // ---- rooms (غرف) and their maintenance ----
  {
    id: 'rooms.cleaning',
    apply: (c) => (has(c.all, 'تنظيف', 'غرف') ? g('غرف', 'تنظيف غرف') : null),
  },
  {
    id: 'base.raise',
    apply: (c) =>
      has(c.self, 'رفع منسوب') && hasAny(c.self, 'قواعد', 'قاعده')
        ? g('قاعدة كابينة', 'رفع منسوب قاعدة')
        : null,
  },
  {
    id: 'rooms.raise',
    apply: (c) => (has(c.all, 'رفع منسوب', 'غرف') ? g('غرف', 'رفع منسوب غرف') : null),
  },
  { id: 'rooms.secure', apply: (c) => (has(c.self, 'تامين غرف') ? g('غرف', 'تأمين غرف') : null) },
  {
    id: 'rooms.frameCover',
    apply: (c) =>
      has(c.self, 'استبدال') && hasAny(c.self, 'الحلق', 'غطاء') ? g('غرف', 'حلق وغطاء') : null,
  },
  {
    id: 'rooms.sleeves',
    apply: (c) => {
      const text = nearestWith(c, 'الجلب المرمله');
      if (text === null) return null;
      if (text.includes('110')) return g('غرف', 'فتحات جلب 110');
      if (hasAny(text, '50', '32')) return g('غرف', 'فتحات جلب 50 و 32');
      return null;
    },
  },
  {
    id: 'rooms.reveal',
    apply: (c) => (has(c.self, 'كشف', 'غرف') ? g('غرف', 'كشف غرف حالية') : null),
  },
  {
    id: 'rooms.junction',
    apply: (c) =>
      hasAny(c.self, 'junction box', 'غرفه توزيع') ? g('غرف', 'غرفة توزيع 40×40') : null,
  },
  {
    id: 'rooms.nonConcrete',
    apply: (c) => (has(c.all, 'غير خرسانيه', 'غرف') ? g('غرف', 'غرف غير خرسانيه') : null),
  },
  {
    id: 'rooms.special',
    apply: (c) => (has(c.self, 'غرف', 'خاصه', 'خرسانيه') ? g('غرف', 'غرف خرسانية خاصة') : null),
  },
  {
    id: 'rooms.new',
    apply: (c) => (has(c.self, 'غرفه تفتيش طراز') ? g('غرف', 'غرف خرسانية جديدة') : null),
  },
  // ---- layers and cabinet bases ----
  {
    id: 'replacement.fineSand',
    apply: (c) => (has(c.self, 'ردم الرمل الناعم') ? g('طبقة إحلال', 'رمل ناعم') : null),
  },
  {
    id: 'replacement.sandGravel',
    apply: (c) => (has(c.self, 'احلال', 'زلط') ? g('طبقة إحلال', 'رمل وزلط') : null),
  },
  {
    id: 'base.new',
    apply: (c) =>
      hasAny(c.self, 'قاعده كابينه', 'قواعد الكباين') ? g('قاعدة كابينة', 'قاعدة جديدة') : null,
  },
  {
    id: 'concrete.layer',
    apply: (c) => {
      if (!has(c.self, 'طبقه خرسانيه')) return null;
      if (c.self.includes('مسلحه')) return g('طبقة خرسانية', 'مسلحة');
      if (c.self.includes('عاديه')) return g('طبقة خرسانية', 'عادية');
      return null;
    },
  },
  { id: 'ductBanks', apply: (c) => (c.all.includes('عدايه') ? g('عدايات') : null) },
  // ---- crossings (تخطيات): method from the nearest text that names it ----
  {
    id: 'crossings',
    apply: (c) => {
      if (!c.all.includes('تخطيه')) return null;
      for (const text of [c.self, ...c.up]) {
        if (hasAny(text, 'hdd', 'الدفع الموجه', 'فاروغه')) return g('تخطيات', 'HDD');
        if (hasAny(text, 'بريمه', 'هيدروليكي')) return g('تخطيات', 'بريمة / دفع هيدروليكي');
        if (hasAny(text, 'endless', 'المرنه', 'اسفل الترعه'))
          return g('تخطيات', 'Endless pipe أسفل الترعة');
        if (hasAny(text, 'معلقه', 'الكباري')) return g('تخطيات', 'مواسير حديد معلقة');
      }
      return null;
    },
  },
  // ---- cables pulled in / out ----
  {
    id: 'cables.fiber',
    apply: (c) => {
      const fiber =
        (c.self.includes('سحب') && hasAny(c.self, 'كابلات الياف', 'كابلات الالياف')) ||
        c.self.includes('pulling out cables');
      if (!fiber) return null;
      const out = hasAny(c.self, 'من داخل', 'pulling out', 'خارج المواسير');
      return g('كابلات ألياف ضوئية', out ? 'سحب كابل حالي للخارج' : 'سحب كابل جديد');
    },
  },
  {
    id: 'cables.copper',
    apply: (c) =>
      c.self.includes('كابلات نحاسيه') && hasAny(c.all, 'من داخل', 'خارج المواسير')
        ? g('كابلات نحاس', 'سحب كابل حالي للخارج')
        : null,
  },
  // ---- bundles (بنادل): laid or pulled, sub group = capacity ----
  {
    id: 'bundles',
    apply: (c) => {
      const isBundle =
        hasAny(c.self, 'حزمه', 'bundle') || hasAny(c.self, 'ماسوره مفرده', 'single microduct');
      if (!isBundle) return null;
      const count =
        /(\d+)\s*(?:انبوبه|انابيب)/.exec(c.self) ?? /1\s*x\s*(\d+)\s*microduct/.exec(c.self);
      if (count?.[1]) return g('بنادل', `${count[1]} انبوبة`);
      if (hasAny(c.self, 'مفرده', 'single', 'واحده')) return g('بنادل', 'ماسورة مفردة');
      return null;
    },
  },
  // ---- subduct ----
  {
    id: 'subduct.directBurial',
    apply: (c) =>
      has(c.self, 'قطر 32') && c.self.includes('رمي مباشر') ? g('SUBDUCT', 'رمي مباشر') : null,
  },
  {
    id: 'subduct.damagedOut',
    apply: (c) => (has(c.self, 'subduct', 'تالف') ? g('SUBDUCT', 'سحب تالف للخارج') : null),
  },
  {
    id: 'subduct.pullIn',
    apply: (c) =>
      has(c.all, 'subduct', 'سحب', 'داخل المواسير') && c.self.includes('110')
        ? g('SUBDUCT', 'سحب داخل مواسير 110')
        : null,
  },
  // ---- pipes ----
  {
    id: 'pipes.newPlastic',
    apply: (c) =>
      c.self.includes('مواسير بلاستيك') && c.all.includes('تركيب')
        ? g('مواسير', 'تركيب مواسير جديدة')
        : null,
  },
  {
    id: 'pipes.repair',
    apply: (c) =>
      c.self.includes('اصلاح') && c.self.includes('مواسير')
        ? g('مواسير', 'إصلاح مواسير حالية')
        : null,
  },
  {
    id: 'pipes.calibrate',
    apply: (c) => (c.self.includes('معايره ماسوره') ? g('مواسير', 'معايرة مواسير حالية') : null),
  },
  // ---- bundle accessories ----
  {
    id: 'connectors',
    apply: (c) => (hasAny(c.self, 'موصلات', 'connectors') ? g('كونيكتور') : null),
  },
  {
    id: 'gasBlock',
    apply: (c) => (hasAny(c.self, 'مانع تسرب', 'gas block') ? g('مانع تسريب') : null),
  },
  { id: 'endCaps', apply: (c) => (hasAny(c.self, 'طبه', 'end caps') ? g('طبات') : null) },
  // ---- digging (حفر) ----
  {
    id: 'dig.microTrench',
    apply: (c) =>
      hasAny(c.all, 'micro trench', 'mini trench', 'ميكرو ترنش') ? g('حفر', 'ميكرو ترنش') : null,
  },
  {
    id: 'dig.crossCuts',
    apply: (c) => (c.self.includes('القطعيات العرضيه') ? g('حفر', 'قطعيات عرضية') : null),
  },
  {
    id: 'dig.asphaltCutter',
    apply: (c) => {
      if (!c.all.includes('cutter')) return null;
      const role = c.self.includes('الرئيسيه')
        ? 'رئيسي'
        : c.self.includes('الثانويه')
          ? 'ثانوي'
          : null;
      const soil = soilOf(c);
      return role && soil ? g('حفر', `${role} ${soilLabel(soil)}`) : null;
    },
  },
  {
    id: 'dig.directBurial',
    apply: (c) => {
      if (!c.all.includes('الرمي المباشر') && !c.all.includes('للرمي المباشر')) return null;
      if (!c.all.includes('حفر')) return null;
      const role = c.self.includes('رصيف') ? 'ثانوي' : c.self.includes('شارع') ? 'رئيسي' : null;
      const soil = soilOf(c);
      return role && soil ? g('حفر', `${role} ${soilLabel(soil)}`) : null;
    },
  },
  {
    id: 'dig.pipeTrenches',
    apply: (c) => {
      if (!c.self.includes('حفر خنادق')) return null;
      const soil = soilOf(c);
      return soil ? g('حفر', `خنادق مواسير ${soilLabel(soil)}`) : null;
    },
  },
  {
    id: 'dig.specialSizes',
    apply: (c) => (c.self.includes('مقاسات خاصه') ? g('حفر', 'مقاسات خاصة') : null),
  },
  {
    id: 'dig.faults',
    apply: (c) => (has(c.self, 'حفر', 'اعطال') ? g('حفر', 'بحث عن أعطال') : null),
  },
  // ---- installations ----
  {
    id: 'blowing',
    apply: (c) => {
      if (!hasAny(c.all, 'الدفع الهوائي', 'air blown')) return null;
      if (!hasAny(c.self, 'كوابل', 'cables')) return null;
      return hasAny(c.self, 'اكبر من 12', 'more than 12')
        ? g('أعمال الدفع الهوائي', 'أكبر من 12 لحد 288')
        : g('أعمال الدفع الهوائي', 'لحد 12 فرعة');
    },
  },
  { id: 'cabinetBody', apply: (c) => (c.self.includes('بودي كابينه') ? g('كابينه') : null) },
  {
    id: 'spliceJoint',
    apply: (c) => (c.self.includes('joint closure') ? g('لحام في الغرف') : null),
  },
  { id: 'odf', apply: (c) => (c.self.includes('odf') ? g('ODF') : null) },
  {
    id: 'splitter',
    apply: (c) => {
      if (!c.self.includes('مقسم اشاره')) return null;
      if (c.self.includes('غير شامل')) return g('مقسم اشارة', 'بدون لحام');
      if (c.self.includes('شامل')) return g('مقسم اشارة', 'شامل لحام');
      return null;
    },
  },
  {
    id: 'box',
    apply: (c) =>
      c.self.includes('فرعه') && hasAny(c.all, 'بوكس', 'termination box') ? g('BOX') : null,
  },
  {
    id: 'rack',
    apply: (c) => {
      if (!hasAny(c.self, 'راك', 'rack')) return null;
      const height = /ارتفاع\s*(\d+(?:\s*-\s*\d+)?)/.exec(c.self) ?? /(\d+)\s*u\b/.exec(c.self);
      const value = height?.[1];
      return value ? g('RACK', `ارتفاع ${value.replace(/\s+/g, '')}`) : null;
    },
  },
  {
    id: 'wallCables',
    apply: (c) => (hasAny(c.all, 'h.c', 'على الحوائط', 'علي الحوائط') ? g('H.C') : null),
  },
  // ---- maps ----
  {
    id: 'maps.asBuilt',
    apply: (c) => {
      if (!c.self.includes('ما بعد التنفيذ')) return null;
      const scope = `${c.unit} ${c.self}`;
      if (hasAny(scope, 'more than 8', 'اكثر من 8')) return g('As Built', 'أكثر من 8 وحدات');
      if (hasAny(scope, '1 to 8', 'حتي 8', 'لحد 8')) return g('As Built', 'لحد 8 وحدات');
      return null;
    },
  },
  { id: 'maps.gis', apply: (c) => (c.self.includes('خرائط مساحيه رقميه') ? g('GIS') : null) },
  {
    id: 'maps.asPlan',
    apply: (c) => {
      if (!has(c.self, 'التخطيط', 'الخرائط المساحيه')) return null;
      if (c.self.includes('عن طريق الشركه المنفذه')) return g('AS PLAN', 'خرائط بمعرفتنا');
      if (c.self.includes('توفير الخرائط')) return g('AS PLAN', 'خرائط من العميل');
      return null;
    },
  },
];

/** The ids of every rule, in order (for tests and the ADR). */
export const ITEM_GROUP_RULE_IDS: readonly string[] = RULES.map((rule) => rule.id);

/** Groups of one priced line by the system rule, or null when no rule applies. */
export function deriveItemGroup(input: ItemGroupInput): ItemGroupMatch | null {
  const self = groupTextKey(input.description);
  if (self === '') return null;
  const up = input.parents.map(groupTextKey).filter((text) => text !== '');
  const ctx: Ctx = { self, up, all: [self, ...up].join(' | '), unit: groupTextKey(input.unit) };
  for (const rule of RULES) {
    const group = rule.apply(ctx);
    if (group) return { group, ruleId: rule.id };
  }
  return null;
}

/** A manual choice of an admin (latest one wins). `group: null` = back to the rule. */
export interface ManualItemGroup {
  group: ItemGroup | null;
}

/** The group state of a priced line: manual choice first, then the rule, else `none`. */
export function effectiveItemGroup(
  input: ItemGroupInput,
  manual: ManualItemGroup | null | undefined,
): ItemGroupState {
  const match = deriveItemGroup(input);
  const ruleId = match?.ruleId ?? null;
  const ruleGroup = match?.group ?? null;
  if (manual?.group) return { group: manual.group, source: 'manual', ruleId, ruleGroup };
  if (match) return { group: match.group, source: 'rule', ruleId, ruleGroup };
  return { group: null, source: 'none', ruleId: null, ruleGroup: null };
}

/** Minimal line shape for `contractItemGroupInputs`. */
export interface GroupableLine {
  id: string;
  kind: 'item' | 'heading';
  code: string;
  description: string | null;
  unit: string | null;
  parentCode: string | null;
}

/**
 * Rule inputs for every priced line of a BOQ, keyed by line id. Parents are walked through
 * `parentCode` (nearest first); when a code is used twice, the first line with that code is used.
 */
export function contractItemGroupInputs(
  lines: readonly GroupableLine[],
): Map<string, ItemGroupInput> {
  const byCode = new Map<string, GroupableLine>();
  for (const line of lines) if (!byCode.has(line.code)) byCode.set(line.code, line);
  const inputs = new Map<string, ItemGroupInput>();
  for (const line of lines) {
    if (line.kind !== 'item') continue;
    const parents: (string | null)[] = [];
    const seen = new Set<string>([line.code]);
    let parentCode = line.parentCode;
    while (parentCode !== null && !seen.has(parentCode)) {
      seen.add(parentCode);
      const parent = byCode.get(parentCode);
      if (!parent) break;
      parents.push(parent.description);
      parentCode = parent.parentCode;
    }
    inputs.set(line.id, { description: line.description, unit: line.unit, parents });
  }
  return inputs;
}
