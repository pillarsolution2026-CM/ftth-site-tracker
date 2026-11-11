import { z } from 'zod';
import { DrawingKindSchema } from '../cad/drawing-kind.schemas.js';
import { HandholeTypeSchema, MAX_BUNDLE_WAYS, TextRoleSchema } from '../cad/text-roles.js';
import { DecimalStringSchema } from '../common/decimal.js';

/**
 * What the worker read from a feature's role texts (ADR-041), stored in
 * `design_features.attrs.reading` next to the Phase-1 attrs (`kind`, `role`, `status`, `texts`).
 * Written in `roles` reading mode only; absent otherwise and on revisions built before. Lengths are
 * the WRITTEN ones (ADR-040: the written length counts), metres with 3 decimals. The feature `code`
 * also changes in roles mode: box = `boxCode(cabinet, number)`, hhi = number, cabinet = name.
 */
export const READING_ATTR_KEY = 'reading';

const Handle = z.string().min(1).max(64);
const Cores = z.number().int().min(1);
const Count = z.number().int().min(0);
const Ways = z.number().int().min(1).max(MAX_BUNDLE_WAYS);
/** "7/3.5" (outer/inner mm as written). */
const DuctSize = z.string().min(1).max(32);

/** Handles of the texts each role took (one per role, several for bundle_spare). */
const RoleTexts = z.partialRecord(TextRoleSchema, z.array(Handle).min(1));

export const BoxReadingSchema = z.object({
  of: z.literal('box'),
  /** Cabinet written next to the box (box_cabinet); the box belongs to it wherever it sits. */
  cabinet: z.string().nullable(),
  number: z.string().nullable(),
  /** «F4C» → 4. */
  cableCores: Cores.nullable(),
  /** Building cable length from the cabinet («398M»). */
  cableLengthM: DecimalStringSchema.nullable(),
  texts: RoleTexts,
});

export const RouteReadingSchema = z.object({
  of: z.literal('route'),
  /** From the layer rule (`ways`); null when the rule has none. */
  ways: Ways.nullable(),
  /** From the bundle label; ≠ `ways` → LABEL_TYPE_MISMATCH. */
  labelWays: Ways.nullable(),
  ductSize: DuctSize.nullable(),
  /** Written bundle length (bundle_label). */
  writtenLengthM: DecimalStringSchema.nullable(),
  /** General: cable label on this segment («520M/144Core»). */
  cableCores: Cores.nullable(),
  cableLengthM: DecimalStringSchema.nullable(),
  /** General: «SP n» on this cable. */
  spareCores: Cores.nullable(),
  /** Secondary: «SPn(7/3.5)» at this bundle's end. */
  spares: z.array(z.object({ count: z.number().int().min(1), ductSize: DuctSize })),
  /** Secondary, 1way only: connectors where it leaves another bundle (0, 1 or 2 ends). */
  connectors: Count,
  texts: RoleTexts,
});

export const HandholeReadingSchema = z.object({
  of: z.literal('hhi'),
  number: z.string().nullable(),
  /** null: no type text, or one outside the list (see `typeText`). */
  type: HandholeTypeSchema.nullable(),
  typeText: z.string().nullable(),
  texts: RoleTexts,
});

export const CabinetReadingSchema = z.object({
  of: z.literal('cabinet'),
  /** «1-7»: the cabinet's identity in both drawings (cabinetNameKey). */
  name: z.string().nullable(),
  /** «22U» as written (body size; not interpreted here). */
  type: z.string().nullable(),
  /** «22B» → 22. */
  boxCount: Count.nullable(),
  /** «2P» → 2; information only. */
  ports: Count.nullable(),
  /** Secondary: boxes whose box_cabinet is this name; null in the General. */
  boxesDrawn: Count.nullable(),
  /** Secondary: the zone curve (smallest handle of its group) around it; null = none. */
  zoneHandle: Handle.nullable(),
  texts: RoleTexts,
});

export const FeatureReadingSchema = z.discriminatedUnion('of', [
  BoxReadingSchema,
  RouteReadingSchema,
  HandholeReadingSchema,
  CabinetReadingSchema,
]);
export type FeatureReading = z.infer<typeof FeatureReadingSchema>;
export type BoxReading = z.infer<typeof BoxReadingSchema>;
export type RouteReading = z.infer<typeof RouteReadingSchema>;
export type HandholeReading = z.infer<typeof HandholeReadingSchema>;
export type CabinetReading = z.infer<typeof CabinetReadingSchema>;

/** The reading in a feature's attrs, or null (legacy mode, older revisions, other types). */
export function readingOf(attrs: Readonly<Record<string, unknown>>): FeatureReading | null {
  const parsed = FeatureReadingSchema.safeParse(attrs[READING_ATTR_KEY]);
  return parsed.success ? parsed.data : null;
}

// ---------- revision totals (`design_revisions.counts.reading`) ----------

/**
 * Counts that are not features, kept for the quantities (ADR-040 part H) and shown on the
 * revision page. Lengths are Σ WRITTEN lengths (3 decimals); unlabelled routes are counted apart.
 */
export const ReadingTotalsSchema = z.object({
  drawingKind: DrawingKindSchema,
  /** Per bundle type and duct size; `ways` null = route rule without ways. */
  bundles: z.array(
    z.object({
      ways: Ways.nullable(),
      ductSize: DuctSize.nullable(),
      count: Count,
      writtenLengthM: DecimalStringSchema,
      /** Routes of this group with no written length. */
      withoutLength: Count,
    }),
  ),
  /** Secondary: one per 1way leaving another bundle (two drops from one point = two). */
  connectors: z.array(z.object({ ductSize: DuctSize.nullable(), count: Count })),
  /** Secondary: spare singles per size («SPn(size)») and their end caps (2 × n each). */
  spares: z.array(z.object({ ductSize: DuctSize, singles: Count, endCaps: Count })),
  /** General: cables per core count with Σ written length. */
  cables: z.array(z.object({ cores: Cores, count: Count, writtenLengthM: DecimalStringSchema })),
  /** General: handholes per type (null = untyped). */
  handholes: z.array(z.object({ type: HandholeTypeSchema.nullable(), count: Count })),
});
export type ReadingTotals = z.infer<typeof ReadingTotalsSchema>;

/** End caps per spare single (owner: bundle end + cabinet side). */
export const END_CAPS_PER_SPARE = 2;
