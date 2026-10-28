import { z } from 'zod';
import {
  FEATURE_TYPES,
  POINT_FEATURE_TYPES,
  PointFeatureTypeSchema,
  type FeatureType,
  isPointFeatureType,
} from '../design/feature-types.js';
import { CadFileStatusSchema } from './cad-file.schemas.js';
import { CrsDetectionSchema, ProjectEpsgSchema } from './crs-detection.schemas.js';
import { DrawingUnitSchema } from './drawing-units.js';

/**
 * Mapping = how a processed drawing becomes design features (ADR-017). One mapping per CAD file,
 * edited by the PM; a design revision stores a frozen copy of it.
 *
 * Targets:
 * - a feature type (`route` | `box` | `hhi` | `joint` | `mh`);
 * - `label`: texts on the layer are candidates for text-to-feature linking;
 * - `background`: drawn in the background tiles only (buildings, roads, street names);
 * - `ignore`: not used at all. Layers without a rule are ignored.
 */
export const MAPPING_TARGETS = [...FEATURE_TYPES, 'label', 'background', 'ignore'] as const;
export const MappingTargetSchema = z.enum(MAPPING_TARGETS);
export type MappingTarget = z.infer<typeof MappingTargetSchema>;

const Name = z.string().min(1).max(255);

/**
 * Rule semantics (applied by the worker when a revision is built):
 * - `layer` → `route`: every curve on the layer is one route feature.
 * - `layer` → point type: every INSERT on the layer is one feature (unless a `block` rule matches).
 * - `layer` → feature type, `label`: its texts are link candidates.
 * - `block` (by block name, any layer) → point type | `background` | `ignore`; wins over the layer rule.
 * - `text` (exact text, trimmed and case-insensitive, on one layer) → point type: one feature at the
 *   text's insertion point (e.g. "NEW-HHI" on layer RRR = handhole). Such texts are not linked.
 */
export const MappingRuleSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('layer'), layer: Name, target: MappingTargetSchema }),
  z.object({
    source: z.literal('block'),
    block: Name,
    target: z.enum([...POINT_FEATURE_TYPES, 'background', 'ignore']),
  }),
  z.object({
    source: z.literal('text'),
    layer: Name,
    text: z.string().trim().min(1).max(255),
    target: PointFeatureTypeSchema,
  }),
]);
export type MappingRule = z.infer<typeof MappingRuleSchema>;

export const MAX_MAPPING_RULES = 2000;

export function mappingRuleKey(rule: MappingRule): string {
  switch (rule.source) {
    case 'layer':
      return `layer:${rule.layer}`;
    case 'block':
      return `block:${rule.block}`;
    case 'text':
      return `text:${rule.layer}:${rule.text.trim().toLowerCase()}`;
  }
}

/** PUT …/cad-files/:cadFileId/mapping */
export const CadMappingInputSchema = z
  .object({
    rules: z.array(MappingRuleSchema).max(MAX_MAPPING_RULES),
    /** Confirmed by the PM (suggested by CRS detection). */
    crsEpsg: ProjectEpsgSchema,
    /** Chosen by the PM; no default (ADR-018). */
    drawingUnit: DrawingUnitSchema,
    /** null on the first save, then the version read (optimistic concurrency). */
    version: z.number().int().min(1).nullable(),
  })
  .superRefine((input, ctx) => {
    const seen = new Set<string>();
    input.rules.forEach((rule, index) => {
      const key = mappingRuleKey(rule);
      if (seen.has(key)) {
        ctx.addIssue({ code: 'custom', path: ['rules', index], message: `Duplicate rule ${key}` });
      }
      seen.add(key);
    });
  });
export type CadMappingInput = z.infer<typeof CadMappingInputSchema>;

export const CadMappingSchema = z.object({
  cadFileId: z.uuid(),
  rules: z.array(MappingRuleSchema),
  crsEpsg: z.number().int(),
  drawingUnit: DrawingUnitSchema,
  /** Decimal string from METRES_PER_UNIT, e.g. "0.0254". */
  metresPerUnit: z.string(),
  version: z.number().int().min(1),
  updatedById: z.uuid().nullable(),
  updatedAt: z.iso.datetime(),
});
export type CadMapping = z.infer<typeof CadMappingSchema>;

export const SUGGESTION_SOURCES = ['name_pattern', 'default'] as const;

export const MappingLayerRowSchema = z.object({
  name: z.string(),
  aciColor: z.number().int().min(1).max(255),
  trueColor: z.number().int().nullable(),
  isOn: z.boolean(),
  entityCounts: z.record(z.string(), z.number().int().min(0)),
  entityTotal: z.number().int().min(0),
  suggestedTarget: MappingTargetSchema,
  suggestionSource: z.enum(SUGGESTION_SOURCES),
});
export type MappingLayerRow = z.infer<typeof MappingLayerRowSchema>;

export const MappingBlockRowSchema = z.object({
  name: z.string(),
  count: z.number().int().min(1),
  layers: z.array(z.string()),
  /** null = no suggestion (the layer rule applies). */
  suggestedTarget: MappingTargetSchema.nullable(),
});
export type MappingBlockRow = z.infer<typeof MappingBlockRowSchema>;

/** Distinct readable texts per layer (most frequent first), to pick `text` rules from. */
export const MappingTextRowSchema = z.object({
  layer: z.string(),
  text: z.string(),
  count: z.number().int().min(1),
  suggestedTarget: MappingTargetSchema.nullable(),
});
export type MappingTextRow = z.infer<typeof MappingTextRowSchema>;

export const MAPPING_TEXT_ROWS_LIMIT = 300;

/** GET …/cad-files/:cadFileId/mapping */
export const CadMappingViewSchema = z.object({
  cadFileId: z.uuid(),
  fileStatus: CadFileStatusSchema,
  projectEpsg: z.number().int(),
  insUnits: z.number().int().nullable(),
  crsDetection: CrsDetectionSchema.nullable(),
  layers: z.array(MappingLayerRowSchema),
  blocks: z.array(MappingBlockRowSchema),
  texts: z.array(MappingTextRowSchema),
  /** null until the PM saves a mapping. */
  mapping: CadMappingSchema.nullable(),
});
export type CadMappingView = z.infer<typeof CadMappingViewSchema>;

// ---------- name-based suggestions (only suggestions: the PM confirms every rule) ----------

/**
 * Patterns from the build plan's examples: `N_DUC_CBL` → route, `sub` → box, `NEW-HHI` → hhi,
 * `JONT 144` → joint. Label layers are recognised by TXT/TEXT/CAP in the name. Anything else is
 * suggested as background. These are hints, never business rules.
 */
const LAYER_PATTERNS: readonly (readonly [RegExp, MappingTarget])[] = [
  [/N[_-]?DUC[_-]?CBL/i, 'route'],
  [/^sub$/i, 'box'],
  [/HHI/i, 'hhi'],
  [/^jo?i?nt\b/i, 'joint'],
  [/(^|[_\s-])(TXT|TEXT)([_\s-]|$)|^CAP\b/i, 'label'],
];
const BLOCK_PATTERNS: readonly (readonly [RegExp, FeatureType])[] = [
  [/^sub$/i, 'box'],
  [/HHI/i, 'hhi'],
  [/^jo?i?nt\b/i, 'joint'],
];
const TEXT_PATTERNS: readonly (readonly [RegExp, FeatureType])[] = [[/^NEW[-_ ]?HHI$/i, 'hhi']];

export function suggestLayerTarget(name: string): {
  target: MappingTarget;
  source: (typeof SUGGESTION_SOURCES)[number];
} {
  const hit = LAYER_PATTERNS.find(([re]) => re.test(name.trim()));
  return hit
    ? { target: hit[1], source: 'name_pattern' }
    : { target: 'background', source: 'default' };
}

export function suggestBlockTarget(name: string): FeatureType | null {
  return BLOCK_PATTERNS.find(([re]) => re.test(name.trim()))?.[1] ?? null;
}

export function suggestTextTarget(text: string): FeatureType | null {
  return TEXT_PATTERNS.find(([re]) => re.test(text.trim()))?.[1] ?? null;
}

/** True when a rule target creates point features (used by the UI to validate block/text rules). */
export function isPointTarget(target: string): boolean {
  return isPointFeatureType(target);
}
