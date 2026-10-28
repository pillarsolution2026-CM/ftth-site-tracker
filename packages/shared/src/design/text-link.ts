import { z } from 'zod';
import type { FeatureType } from './feature-types.js';

/**
 * Text-to-feature linking (ADR-019). Free texts near network features carry their data
 * (build plan: `F 36 C`, `1X2Way16/12`, `150.0M`, box ids `1-1`, B/P/U codes). Each text is matched
 * against these patterns (whole text, trimmed, case-insensitive); a matching text is linked to the
 * nearest feature of the allowed types. Mirrored by `workers/cad/cad_worker/domain/text_links.py`.
 *
 * The kinds only classify the text; their business meaning (e.g. what B/P/U stand for) is not
 * interpreted here.
 */
export const TEXT_LINK_KINDS = [
  'cable',
  'duct',
  'length',
  'box_id',
  'box_bpu',
  /** Text on a candidate layer that matches no pattern; listed but never linked automatically. */
  'other',
  /** Text whose decoding is uncertain (`readable=false`); always reviewed, never guessed. */
  'unreadable',
] as const;
export const TextLinkKindSchema = z.enum(TEXT_LINK_KINDS);
export type TextLinkKind = z.infer<typeof TextLinkKindSchema>;

/** Patterns from the build plan, anchored to the whole text. Order matters: first match wins. */
export const TEXT_LINK_PATTERNS: readonly (readonly [
  Exclude<TextLinkKind, 'other' | 'unreadable'>,
  RegExp,
])[] = [
  ['cable', /^F\s*\d+\s*C$/i],
  ['duct', /^\d+\s*X\s*\d+\s*Way\S*$/i],
  ['length', /^\d+(?:\.\d+)?\s*M$/i],
  ['box_id', /^\d+\s*-\s*\d+$/],
  ['box_bpu', /^\d+\s*[BPU]$/i],
];

/** Feature types a text of each kind may be linked to. */
export const TEXT_LINK_TARGETS: Readonly<Record<TextLinkKind, readonly FeatureType[]>> = {
  cable: ['route'],
  duct: ['route'],
  length: ['route'],
  box_id: ['box'],
  box_bpu: ['box'],
  other: ['route', 'box', 'hhi', 'joint', 'mh'],
  unreadable: ['route', 'box', 'hhi', 'joint', 'mh'],
};

export function classifyLinkText(text: string): Exclude<TextLinkKind, 'unreadable'> {
  const value = text.trim();
  return TEXT_LINK_PATTERNS.find(([, re]) => re.test(value))?.[0] ?? 'other';
}

/**
 * Technical tuning (ADR-019), not business rules:
 * - search radius = LINK_RADIUS_TEXT_HEIGHTS × text height (min LINK_MIN_RADIUS_M), in metres;
 * - confidence = 0.5 × proximity + 0.5 × uniqueness, where proximity = 1 − d1 / radius and
 *   uniqueness = 1 − d1 / d2 (1 when there is no second candidate);
 * - confidence ≥ AUTO_LINK_MIN_CONFIDENCE → `auto`, otherwise `review`.
 */
export const LINK_RADIUS_TEXT_HEIGHTS = 15;
export const LINK_MIN_RADIUS_M = 1;
export const AUTO_LINK_MIN_CONFIDENCE = 0.8;

/**
 * auto = linked with high confidence; review = needs the PM (low confidence, no candidate, or
 * unreadable); confirmed / rejected = decided by the PM; unlinked = `other` texts (not linked).
 */
export const TEXT_LINK_STATUSES = ['auto', 'review', 'confirmed', 'rejected', 'unlinked'] as const;
export const TextLinkStatusSchema = z.enum(TEXT_LINK_STATUSES);
export type TextLinkStatus = z.infer<typeof TextLinkStatusSchema>;
