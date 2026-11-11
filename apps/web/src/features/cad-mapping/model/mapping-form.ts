import {
  CadMappingInputSchema,
  FEATURE_TYPES,
  TEXT_ROLES,
  type DrawingKind,
  type CabinetRole,
  type ItemStatus,
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
import { layerMeaningFields, withSuggestedMeaning, type LayerMeaningForm } from './layer-meaning';
import { initialEpsgText, parseEpsg } from './epsg';
import {
  initialPlacementState,
  placementSignature,
  toPlacement,
  type PlacementFormState,
} from './placement-form';

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

/**
 * What a rule to a feature type adds (ADR-033/034): `kind` (free, e.g. "4 way", "144"), `status`
 * (new or existing) and, for cabinets only and required, `role` ('' = not chosen yet: no default).
 */
export interface RuleAttrsForm {
  kind: string;
  role: CabinetRole | '';
  status: ItemStatus;
}
export const EMPTY_ATTRS: RuleAttrsForm = { kind: '', role: '', status: 'new' };

export interface MappingFormState {
  /** Text of the EPSG input. */
  epsg: string;
  /**
   * Always metres for new mappings (ADR-035: the unit picker left the screen; `$INSUNITS` is shown
   * as information only). A mapping saved earlier keeps its unit.
   */
  unit: DrawingUnit;
  layers: Record<string, MappingTarget>;
  blocks: Record<string, BlockChoice>;
  texts: Record<string, TextChoice>;
  /** By `attrsKey(…)`; absent = EMPTY_ATTRS. */
  attrs: Record<string, RuleAttrsForm>;
  /** Text roles and ways of LAYER rules, by layer name; absent = EMPTY_MEANING. */
  meaning: Record<string, LayerMeaningForm>;
  /** Where the drawing sits on the earth (ADR-035). */
  placement: PlacementFormState;
}

export const attrsKey = {
  layer: (name: string) => `layer:${name}`,
  block: (name: string) => `block:${name}`,
  text: (rowKey: string) => `text:${rowKey}`,
};

export function isFeatureTarget(target: string): boolean {
  return (FEATURE_TYPES as readonly string[]).includes(target);
}

function attrsOfRule(rule: MappingRule): RuleAttrsForm {
  return { kind: rule.kind ?? '', role: rule.role ?? '', status: rule.status ?? 'new' };
}

/** The attributes to send with a rule to `target`; nothing for non-feature targets. */
function ruleAttrs(target: string, attrs: RuleAttrsForm | undefined) {
  if (!isFeatureTarget(target) || !attrs) return {};
  const kind = attrs.kind.trim();
  return {
    ...(kind ? { kind } : {}),
    ...(attrs.status === 'existing' ? { status: attrs.status } : {}),
    ...(target === 'cabinet' && attrs.role ? { role: attrs.role } : {}),
  };
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
      : `mapping.target.${target as 'label' | 'zone' | 'background' | 'ignore'}`
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
 * layer"/"no rule"; before the first save the suggestion is prefilled. The drawing unit is metres
 * unless a saved mapping says otherwise (ADR-035). Text roles and ways come from the saved rule;
 * before the first save they are suggested from the layer texts and name (ADR-041; the PM confirms
 * by saving). A saved mapping is never changed by suggestions until the PM asks for them.
 */
export function initialFormState(
  view: CadMappingView,
  kind: DrawingKind | null = null,
): MappingFormState {
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

  const attrs: Record<string, RuleAttrsForm> = {};
  const rowKeyByText = new Map(
    textRuleRows(view).map((row) => [caselessKey(row.layer, row.text), row.key]),
  );
  for (const rule of savedRules(view)) {
    const value = attrsOfRule(rule);
    if (value.kind === '' && value.role === '' && value.status === 'new') continue;
    if (rule.source === 'layer') attrs[attrsKey.layer(rule.layer)] = value;
    else if (rule.source === 'block') attrs[attrsKey.block(rule.block)] = value;
    else {
      const rowKey = rowKeyByText.get(caselessKey(rule.layer, rule.text));
      if (rowKey) attrs[attrsKey.text(rowKey)] = value;
    }
  }

  const meaning: Record<string, LayerMeaningForm> = {};
  for (const rule of savedRules(view)) {
    if (rule.source === 'layer' && (rule.textRoles !== undefined || rule.ways !== undefined)) {
      meaning[rule.layer] = {
        roles: [...(rule.textRoles ?? [])],
        ways: rule.ways === undefined ? '' : String(rule.ways),
      };
    }
  }

  const state: MappingFormState = {
    epsg: initialEpsgText(view),
    unit: view.mapping?.drawingUnit ?? 'm',
    layers,
    blocks,
    texts,
    attrs,
    meaning,
    placement: initialPlacementState(view),
  };
  return hasMapping ? state : withSuggestedMeaning(view, state, kind);
}

/** Rule rows that point at `cabinet` without a chosen role (save stays off until chosen). */
export function cabinetsWithoutRole(view: CadMappingView, state: MappingFormState): string[] {
  const missing: string[] = [];
  const check = (key: string, target: string, label: string) => {
    if (target === 'cabinet' && (state.attrs[key]?.role ?? '') === '') missing.push(label);
  };
  for (const layer of view.layers) {
    check(
      attrsKey.layer(layer.name),
      state.layers[layer.name] ?? layer.suggestedTarget,
      layer.name,
    );
  }
  for (const block of view.blocks) {
    check(attrsKey.block(block.name), state.blocks[block.name] ?? 'follow', block.name);
  }
  for (const row of textRuleRows(view)) {
    check(attrsKey.text(row.key), state.texts[row.key] ?? 'none', row.text);
  }
  return missing;
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
    Object.entries(state.attrs)
      .filter(([, a]) => a.kind.trim() !== '' || a.role !== '' || a.status !== 'new')
      .map(([key, a]): [string, string] => [key, `${a.kind.trim()}|${a.role}|${a.status}`])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    Object.entries(state.meaning)
      .map(([layer, m]): [string, string] => [
        layer,
        `${TEXT_ROLES.filter((role) => m.roles.includes(role)).join(',')}|${m.ways.trim()}`,
      ])
      .filter(([, value]) => value !== '|')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    placementSignature(state.placement),
  ]);
}

/**
 * The PUT payload: one layer rule for every layer (so a saved mapping is complete), block rules for
 * blocks that do not follow their layer, text rules for chosen texts and the placement. Returns
 * null while the EPSG is not valid.
 */
export function buildMappingInput(
  view: CadMappingView,
  state: MappingFormState,
  version: number | null,
): CadMappingInput | null {
  const epsg = parseEpsg(state.epsg);
  if (!epsg.ok) return null;

  const rules: MappingRule[] = [];
  for (const layer of view.layers) {
    const target = state.layers[layer.name] ?? layer.suggestedTarget;
    rules.push({
      source: 'layer',
      layer: layer.name,
      target,
      ...ruleAttrs(target, state.attrs[attrsKey.layer(layer.name)]),
      ...layerMeaningFields(target, state.meaning[layer.name]),
    });
  }
  for (const block of view.blocks) {
    const choice = state.blocks[block.name] ?? 'follow';
    if (choice !== 'follow') {
      rules.push({
        source: 'block',
        block: block.name,
        target: choice,
        ...ruleAttrs(choice, state.attrs[attrsKey.block(block.name)]),
      });
    }
  }
  for (const row of textRuleRows(view)) {
    const choice = state.texts[row.key] ?? 'none';
    if (choice !== 'none') {
      rules.push({
        source: 'text',
        layer: row.layer,
        text: row.text.trim(),
        target: choice,
        ...ruleAttrs(choice, state.attrs[attrsKey.text(row.key)]),
      });
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
    placement: toPlacement(state.placement),
  });
  return parsed.success ? parsed.data : null;
}
