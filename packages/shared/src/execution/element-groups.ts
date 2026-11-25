import { z } from 'zod';
import { Decimal4StringSchema } from '../common/decimal.js';
import { GROUP_NAME_MAX, type ItemGroup } from '../contracts/item-groups.js';
import type { DrawingKind } from '../cad/drawing-kind.schemas.js';
import type { FeatureType } from '../design/feature-types.js';

/**
 * Supervisor BOQ picking by groups (ADR-056, owner 2026-11-21 … 2026-11-25).
 *
 * The supervisor taps an element of the drawing, sees the MAIN groups set for that element, picks
 * one, then its sub group, then the work-order line, and types the quantity. The element → main
 * groups map is ONE system-level rule (not per contract): a group name in it applies to every
 * contract whose lines carry that main group (ADR-048 groups). Under an element the device shows
 * only the main groups that have lines in the work order(s) of the bundle.
 *
 * A main group used by a contract line but linked to no element is a warning for the admin, who
 * links it from the admin screen; from then on it applies to all contracts.
 */

/**
 * Elements the supervisor can open:
 * - `route_general` / `route_secondary`: a route (and a ring: owner 2026-11-25, a ring is recorded
 *   as a bundle) on a General / Secondary drawing (the route offers «كابلات نحاس» on the General only).
 * - `cabinet`, `box`, `joint`.
 * - `room`: a handhole or manhole of any of the 7 types, new or existing.
 * - `planning`: the «التخطيط» button of a drawing (both kinds); no element is tapped.
 */
export const ELEMENT_KEYS = [
  'route_general',
  'route_secondary',
  'cabinet',
  'box',
  'room',
  'joint',
  'planning',
] as const;
export const ElementKeySchema = z.enum(ELEMENT_KEYS);
export type ElementKey = z.infer<typeof ElementKeySchema>;

/** The element of a tapped feature on a drawing of `drawingKind`. */
export function elementKeyOf(featureType: FeatureType, drawingKind: DrawingKind): ElementKey {
  switch (featureType) {
    case 'route':
    case 'ring':
      return drawingKind === 'general' ? 'route_general' : 'route_secondary';
    case 'cabinet':
      return 'cabinet';
    case 'box':
      return 'box';
    case 'hhi':
    case 'mh':
      return 'room';
    case 'joint':
      return 'joint';
  }
}

const ROUTE_SECONDARY = [
  'حفر',
  'بنادل',
  'طبقة خرسانية',
  'كونيكتور',
  'طبات',
  'تخطيات',
  'عدايات',
  'مواسير',
  'SUBDUCT',
  'كابلات ألياف ضوئية',
  'أعمال الدفع الهوائي',
  'مانع تسريب',
  'طبقة إحلال',
  'H.C',
] as const;

/**
 * The map the owner set (2026-11-25). Names are the ADR-048 main group names exactly. Seeded by
 * migration 0030; the admin may change it later (each change is an event).
 */
export const DEFAULT_ELEMENT_GROUPS: Readonly<Record<ElementKey, readonly string[]>> = {
  route_general: [...ROUTE_SECONDARY, 'كابلات نحاس'],
  route_secondary: ROUTE_SECONDARY,
  cabinet: ['قاعدة كابينة', 'كابينه', 'ODF', 'مقسم اشارة', 'RACK'],
  box: ['BOX', 'أعمال الدفع الهوائي', 'مقسم اشارة'],
  room: ['غرف', 'لحام في الغرف'],
  joint: ['لحام في الغرف'],
  planning: ['As Built', 'GIS', 'AS PLAN'],
};

const MainGroupNameSchema = z.string().trim().min(1).max(GROUP_NAME_MAX);

export const ElementGroupsSchema = z.object({
  element: ElementKeySchema,
  /** Main group names in display order. */
  mains: z.array(z.string()),
});
export type ElementGroups = z.infer<typeof ElementGroupsSchema>;

/** GET /admin/element-groups (platform admin). */
export const ElementGroupsResponseSchema = z.object({
  elements: z.array(
    ElementGroupsSchema.extend({
      /** Optimistic concurrency for PUT; 1 = the seeded map. */
      version: z.number().int().min(1),
    }),
  ),
  /**
   * Main groups some contract line uses (rule or manual group) that no element offers: the
   * supervisor cannot reach those lines until the admin links them. Sorted by name.
   */
  unlinked: z.array(z.object({ main: z.string(), lineCount: z.number().int().min(1) })),
  /** Every main group used by some contract line, for the picker. Sorted by name. */
  knownMains: z.array(z.string()),
});
export type ElementGroupsResponse = z.infer<typeof ElementGroupsResponseSchema>;

/** PUT /admin/element-groups/:element — replaces that element's list. */
export const ReplaceElementGroupsRequestSchema = z
  .strictObject({
    mains: z.array(MainGroupNameSchema).max(60),
    expectedVersion: z.number().int().min(1),
  })
  .refine((body) => new Set(body.mains).size === body.mains.length, {
    message: 'A main group appears twice',
    path: ['mains'],
  });
export type ReplaceElementGroupsRequest = z.infer<typeof ReplaceElementGroupsRequestSchema>;

/**
 * What the device offers under an element: the element's main groups (map order) that have at
 * least one catalog line, each with its sub groups (first-seen order; `null` = lines with no sub
 * group, shown directly) and their lines.
 */
export interface GroupedLines<T> {
  main: string;
  subs: { sub: string | null; items: T[] }[];
}

export function groupsForElement<T extends { group: ItemGroup | null }>(
  map: readonly ElementGroups[],
  element: ElementKey,
  catalog: readonly T[],
): GroupedLines<T>[] {
  const mains = map.find((entry) => entry.element === element)?.mains ?? [];
  const out: GroupedLines<T>[] = [];
  for (const main of mains) {
    const subs: { sub: string | null; items: T[] }[] = [];
    for (const item of catalog) {
      if (item.group?.main !== main) continue;
      const sub = item.group.sub;
      let bucket = subs.find((entry) => entry.sub === sub);
      if (bucket === undefined) {
        bucket = { sub, items: [] };
        subs.push(bucket);
      }
      bucket.items.push(item);
    }
    if (subs.length > 0) out.push({ main, subs });
  }
  return out;
}

// ---------- digging dimensions (owner 2026-11-17: the supervisor always types L, W and D) ----------

/**
 * Main groups whose cubic-metre lines take length × width × depth from the supervisor. ASSUMPTION to
 * confirm with the owner: «طبقة خرسانية» m3 lines too (the 2026-11-17 rule had the concrete layer
 * typed as L × W × D).
 */
export const DIMENSION_MAIN_GROUPS = ['حفر', 'طبقة خرسانية'] as const;

const normalizeUnit = (unit: string): string =>
  unit
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[³]/g, '3')
    .replace(/\s+/g, '')
    .toLowerCase();

/** True for «م3», «م٣», «m3», «م³». */
export function isCubicMetreUnit(unit: string): boolean {
  const u = normalizeUnit(unit);
  return u === 'م3' || u === 'm3';
}

/** A line needs dimensions when its unit is m3 and its main group is a digging group. */
export function lineNeedsDimensions(unit: string, group: ItemGroup | null): boolean {
  return (
    group !== null &&
    (DIMENSION_MAIN_GROUPS as readonly string[]).includes(group.main) &&
    isCubicMetreUnit(unit)
  );
}

const PositiveDecimal4 = Decimal4StringSchema.refine(
  (value) => !/^0(\.0+)?$/.test(value),
  'Must be greater than zero',
);

/** Metres. */
export const LineDimensionsSchema = z.strictObject({
  lengthM: PositiveDecimal4,
  widthM: PositiveDecimal4,
  depthM: PositiveDecimal4,
});
export type LineDimensions = z.infer<typeof LineDimensionsSchema>;

const SCALE = 4;

function toScaled(value: string): bigint {
  const [int, frac = ''] = value.split('.');
  return BigInt(`${int}${frac.padEnd(SCALE, '0')}`);
}

/**
 * L × W × D in m3, exact, rounded half up to 4 decimals, as a decimal string without trailing
 * zeros (e.g. 10 × 0.35 × 0.9 = «3.15»). The quantity of a dimensioned line must equal this.
 */
export function volumeOf(dims: LineDimensions): string {
  const product = toScaled(dims.lengthM) * toScaled(dims.widthM) * toScaled(dims.depthM);
  // product has 12 decimals; round half up to 4.
  const divisor = 10n ** 8n;
  const rounded = (product + divisor / 2n) / divisor;
  const text = rounded.toString().padStart(SCALE + 1, '0');
  const int = text.slice(0, -SCALE);
  const frac = text.slice(-SCALE).replace(/0+$/, '');
  return frac === '' ? int : `${int}.${frac}`;
}

/** Compares two decimal strings numerically (both ≤ 4 decimals). */
export function sameQuantity(a: string, b: string): boolean {
  return toScaled(a) === toScaled(b);
}
