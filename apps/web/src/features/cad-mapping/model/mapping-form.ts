import {
  CadMappingInputSchema,
  FEATURE_TYPES,
  POINT_FEATURE_TYPES,
  isPointFeatureType,
  mappingRuleKey,
  type CadMappingInput,
  type CadMappingView,
  type DrawingUnit,
  type MappingRule,
  type MappingTarget,
  type PointFeatureType,
} from '@ftth/shared';
import type { MessageKey } from '@ftth/i18n';
import { initialEpsgText, parseEpsg } from './epsg';

export const LAYER_TARGETS: readonly MappingTarget[] = [
  ...FEATURE_TYPES,
  'label',
  'background',
  'ignore',
];

export const BLOCK_TARGETS = [...POINT_FEATURE_TYPES, 'background', 'ignore'] as const;
export type BlockTarget = (typeof BLOCK_TARGETS)[number];
/** `follow` = no block rule: the block takes the target of its layer. */
export type BlockChoice = 'follow' | BlockTarget;
/** `none` = no text rule. */
export type TextChoice = 'none' | PointFeatureType;

export interface MappingFormState {
  /** Text of the EPSG input. */
  epsg: string;
  /** '' = not chosen yet: the drawing unit has no default (ADR-018). */
  unit: DrawingUnit | '';
  layers: Record<string, MappingTarget>;
  blocks: Record<string, BlockChoice>;
  texts: Record<string, TextChoice>;
}

export interface TextRuleRow {
  key: string;
  layer: string;
  text: string;
  /** null for a saved rule whose text is no longer in the (limited) list. */
  count: number | null;
  suggestedTarget: PointFeatureType | null;
}

export function targetLabelKey(target: MappingTarget): MessageKey {
  return (
    (FEATURE_TYPES as readonly string[]).includes(target)
      ? `featureType.${target as (typeof FEATURE_TYPES)[number]}`
      : `mapping.target.${target as 'label' | 'background' | 'ignore'}`
  ) as MessageKey;
}

const textKeyOf = (layer: string, text: string) => `${layer}\u0000${text.trim()}`;
const caselessKey = (layer: string, text: string) => `${layer}\u0000${text.trim().toLowerCase()}`;

function savedRules(view: CadMappingView): MappingRule[] {
  return view.mapping?.rules ?? [];
}

function savedLayerTargets(view: CadMappingView): Map<string, MappingTarget> {
  const map = new Map<string, MappingTarget>();
  for (const rule of savedRules(view))
    if (rule.source === 'layer') map.set(rule.layer, rule.target);
  return map;
}

function savedBlockTargets(view: CadMappingView): Map<string, BlockTarget> {
  const map = new Map<string, BlockTarget>();
  for (const rule of savedRules(view))
    if (rule.source === 'block') map.set(rule.block, rule.target);
  return map;
}

/** Text rows to show: the readable texts of the file, plus saved rules that fell out of the list. */
export function textRuleRows(view: CadMappingView): TextRuleRow[] {
  const rows: TextRuleRow[] = view.texts.map((row) => ({
    key: textKeyOf(row.layer, row.text),
    layer: row.layer,
    text: row.text,
    count: row.count,
    suggestedTarget:
      row.suggestedTarget !== null && isPointFeatureType(row.suggestedTarget)
        ? row.suggestedTarget
        : null,
  }));
  const known = new Set(rows.map((row) => caselessKey(row.layer, row.text)));
  for (const rule of savedRules(view)) {
    if (rule.source !== 'text' || known.has(caselessKey(rule.layer, rule.text))) continue;
    rows.push({
      key: textKeyOf(rule.layer, rule.text),
      layer: rule.layer,
      text: rule.text,
      count: null,
      suggestedTarget: null,
    });
  }
  return rows;
}

/**
 * Starting values of the form. Layers: the saved rule, else the name-based suggestion (nothing is
 * stored until the PM saves). Blocks and texts: once a mapping exists, no rule means "follow the
 * layer"/"no rule"; before the first save the suggestion is prefilled. The drawing unit is only
 * prefilled from a saved mapping, never from detection (ADR-018).
 */
export function initialFormState(view: CadMappingView): MappingFormState {
  const layerSaved = savedLayerTargets(view);
  const blockSaved = savedBlockTargets(view);
  const hasMapping = view.mapping !== null;

  const layers: Record<string, MappingTarget> = {};
  for (const layer of view.layers) {
    layers[layer.name] = layerSaved.get(layer.name) ?? layer.suggestedTarget;
  }

  const blocks: Record<string, BlockChoice> = {};
  for (const block of view.blocks) {
    const suggested =
      block.suggestedTarget !== null && isPointFeatureType(block.suggestedTarget)
        ? block.suggestedTarget
        : null;
    blocks[block.name] = hasMapping
      ? (blockSaved.get(block.name) ?? 'follow')
      : (suggested ?? 'follow');
  }

  const savedTexts = new Map<string, PointFeatureType>();
  for (const rule of savedRules(view)) {
    if (rule.source === 'text') savedTexts.set(caselessKey(rule.layer, rule.text), rule.target);
  }
  const texts: Record<string, TextChoice> = {};
  for (const row of textRuleRows(view)) {
    texts[row.key] = hasMapping
      ? (savedTexts.get(caselessKey(row.layer, row.text)) ?? 'none')
      : (row.suggestedTarget ?? 'none');
  }

  return {
    epsg: initialEpsgText(view),
    unit: view.mapping?.drawingUnit ?? '',
    layers,
    blocks,
    texts,
  };
}

/** True when the row shows the name-based suggestion that has never been saved. */
export function isSuggestedLayer(
  view: CadMappingView,
  layerName: string,
  current: MappingTarget,
): boolean {
  const row = view.layers.find((layer) => layer.name === layerName);
  return (
    row !== undefined && !savedLayerTargets(view).has(layerName) && current === row.suggestedTarget
  );
}

/** Stable text of the editable state, to tell whether anything changed since the last save. */
export function formSignature(state: MappingFormState): string {
  const sorted = (record: Record<string, string>) =>
    Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([
    state.epsg.trim(),
    state.unit,
    sorted(state.layers),
    sorted(state.blocks),
    sorted(state.texts),
  ]);
}

/**
 * The PUT payload: one layer rule for every layer (so a saved mapping is complete), block rules for
 * blocks that do not follow their layer, text rules for chosen texts. Returns null while the EPSG
 * or the drawing unit is not valid, so a save can never go out without a chosen unit.
 */
export function buildMappingInput(
  view: CadMappingView,
  state: MappingFormState,
  version: number | null,
): CadMappingInput | null {
  const epsg = parseEpsg(state.epsg);
  if (!epsg.ok || state.unit === '') return null;

  const rules: MappingRule[] = [];
  for (const layer of view.layers) {
    rules.push({
      source: 'layer',
      layer: layer.name,
      target: state.layers[layer.name] ?? layer.suggestedTarget,
    });
  }
  for (const block of view.blocks) {
    const choice = state.blocks[block.name] ?? 'follow';
    if (choice !== 'follow') rules.push({ source: 'block', block: block.name, target: choice });
  }
  for (const row of textRuleRows(view)) {
    const choice = state.texts[row.key] ?? 'none';
    if (choice !== 'none') {
      rules.push({ source: 'text', layer: row.layer, text: row.text.trim(), target: choice });
    }
  }

  // Texts differing only by case would collide (the match is case-insensitive): keep the first.
  const seen = new Set<string>();
  const unique = rules.filter((rule) => {
    const key = mappingRuleKey(rule);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const parsed = CadMappingInputSchema.safeParse({
    rules: unique,
    crsEpsg: epsg.value,
    drawingUnit: state.unit,
    version,
  });
  return parsed.success ? parsed.data : null;
}
