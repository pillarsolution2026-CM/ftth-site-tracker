import {
  MAPPING_TARGETS,
  MAX_BUNDLE_WAYS,
  TEXT_ROLES,
  TEXT_ROLES_BY_KIND,
  suggestBundleWays,
  suggestTextRoles,
  textRoleFitsTarget,
  type CadMappingInput,
  type CadMappingView,
  type DrawingKind,
  type HandholeType,
  type MappingTarget,
  type TextRole,
} from '@ftth/shared';
import type { MappingFormState } from './mapping-form';

/**
 * What a LAYER rule says about its texts and bundles (ADR-041): `roles` = what the layer's texts
 * mean, `ways` = bundle type of a route layer, as typed ('' = none).
 */
export interface LayerMeaningForm {
  roles: TextRole[];
  ways: string;
  /** Handhole types the PM confirmed for other spellings of THIS drawing («HH2» → HH-II). */
  aliases: Record<string, HandholeType>;
}
export const EMPTY_MEANING: LayerMeaningForm = { roles: [], ways: '', aliases: {} };

/**
 * Text roles and ways of layer rules (ADR-041). Roles say what a layer's texts mean; ways is the
 * bundle type of a route layer. Both are suggestions until the PM saves: the form never decides.
 */

/** Targets a layer may take in a file of this kind: `zone` only in a Secondary. */
export function layerTargetsFor(
  kind: DrawingKind | null,
  current: MappingTarget,
): readonly MappingTarget[] {
  return MAPPING_TARGETS.filter(
    (target) => target !== 'zone' || kind === 'secondary' || current === 'zone',
  );
}

/**
 * Roles to offer on a layer: those of the file's kind that fit the target, plus any already chosen
 * (so a role the kind does not read stays visible and can be unticked). Unknown kind: only the
 * chosen ones.
 */
export function roleOptionsFor(
  kind: DrawingKind | null,
  target: string,
  chosen: readonly TextRole[],
): TextRole[] {
  const allowed = kind === null ? [] : TEXT_ROLES_BY_KIND[kind];
  return TEXT_ROLES.filter(
    (role) => chosen.includes(role) || (allowed.includes(role) && textRoleFitsTarget(role, target)),
  );
}

/** True when a role is chosen although the file's kind does not read it (the API refuses it). */
export const roleNotForKind = (kind: DrawingKind | null, role: TextRole): boolean =>
  kind !== null && !TEXT_ROLES_BY_KIND[kind].includes(role);

/** Roles and ways suggested for a layer from its sample texts and name. */
export function suggestMeaning(
  view: CadMappingView,
  kind: DrawingKind | null,
  layer: string,
  target: string,
): LayerMeaningForm {
  const ways = target === 'route' ? suggestBundleWays(layer) : null;
  const roles =
    kind === null
      ? []
      : suggestTextRoles(
          kind,
          target,
          view.texts.filter((row) => row.layer === layer),
        );
  return { roles, ways: ways === null ? '' : String(ways), aliases: {} };
}

/** Layers without roles get the suggestion; chosen roles and typed ways are never replaced. */
export function withSuggestedMeaning(
  view: CadMappingView,
  state: MappingFormState,
  kind: DrawingKind | null,
): MappingFormState {
  const meaning = { ...state.meaning };
  for (const layer of view.layers) {
    const target = state.layers[layer.name] ?? layer.suggestedTarget;
    const current = meaning[layer.name] ?? EMPTY_MEANING;
    const suggested = suggestMeaning(view, kind, layer.name, target);
    const next = {
      roles: current.roles.length > 0 ? current.roles : suggested.roles,
      ways: current.ways !== '' ? current.ways : suggested.ways,
      aliases: current.aliases,
    };
    if (next.roles.length > 0 || next.ways !== '' || Object.keys(next.aliases).length > 0) {
      meaning[layer.name] = next;
    }
  }
  return { ...state, meaning };
}

const WAYS_TEXT = /^[1-9]\d{0,2}$/;

/** The ways of a route layer as a number; null when empty or not a whole number 1…288. */
export function parseWays(text: string): number | null {
  const value = text.trim();
  if (!WAYS_TEXT.test(value)) return null;
  const ways = Number(value);
  return ways <= MAX_BUNDLE_WAYS ? ways : null;
}

/** Route layers whose typed ways are not a whole number from 1 to 288 (save stays off). */
export function layersWithBadWays(view: CadMappingView, state: MappingFormState): string[] {
  return view.layers
    .filter((layer) => {
      const target = state.layers[layer.name] ?? layer.suggestedTarget;
      const ways = (state.meaning[layer.name] ?? EMPTY_MEANING).ways.trim();
      return target === 'route' && ways !== '' && parseWays(ways) === null;
    })
    .map((layer) => layer.name);
}

/** The roles and ways to send with a LAYER rule: only what fits the target, in TEXT_ROLES order. */
export function layerMeaningFields(target: string, meaning: LayerMeaningForm | undefined) {
  if (!meaning) return {};
  const roles = TEXT_ROLES.filter(
    (role) => meaning.roles.includes(role) && textRoleFitsTarget(role, target),
  );
  const ways = target === 'route' ? parseWays(meaning.ways) : null;
  // Aliases only make sense (and are only accepted) on a layer that reads handhole_type.
  const aliases = roles.includes('handhole_type') ? meaning.aliases : {};
  return {
    ...(roles.length > 0 ? { textRoles: roles } : {}),
    ...(ways !== null ? { ways } : {}),
    ...(Object.keys(aliases).length > 0 ? { handholeTypeAliases: aliases } : {}),
  };
}

/** Roles that still fit when a layer changes target (the others would be refused). */
export function rolesFittingTarget(roles: readonly TextRole[], target: string): TextRole[] {
  return roles.filter((role) => textRoleFitsTarget(role, target));
}

/** The alias list sorted for display and for the form signature. */
export const sortedAliases = (aliases: Readonly<Record<string, HandholeType>>) =>
  Object.entries(aliases).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** True when a (case-insensitive, trimmed) spelling already has an alias. */
export const hasAlias = (aliases: Readonly<Record<string, HandholeType>>, found: string) =>
  Object.keys(aliases).some((key) => key.trim().toLowerCase() === found.trim().toLowerCase());

/**
 * The mapping to save when the PM confirms that the spelling `found` means `type` in this drawing:
 * the layer rule that reads `handhole_type` gets `handholeTypeAliases[found] = type` and nothing
 * else changes (version kept for optimistic concurrency). null when there is no saved mapping or no
 * layer rule reads `handhole_type` (then the alias cannot be kept).
 */
export function mappingWithAlias(
  view: CadMappingView | undefined,
  found: string,
  type: HandholeType,
): CadMappingInput | null {
  const mapping = view?.mapping;
  const key = found.trim();
  if (!mapping || key === '') return null;
  const index = mapping.rules.findIndex(
    (rule) => rule.source === 'layer' && rule.textRoles?.includes('handhole_type'),
  );
  if (index < 0) return null;
  const rules = mapping.rules.map((rule, i) => {
    if (i !== index || rule.source !== 'layer') return rule;
    const rest = Object.entries(rule.handholeTypeAliases ?? {}).filter(
      ([k]) => k.trim().toLowerCase() !== key.toLowerCase(),
    );
    return { ...rule, handholeTypeAliases: { ...Object.fromEntries(rest), [key]: type } };
  });
  return {
    rules,
    crsEpsg: mapping.crsEpsg,
    drawingUnit: mapping.drawingUnit,
    version: mapping.version,
    placement: mapping.placement,
  };
}
