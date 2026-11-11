import {
  MAPPING_TARGETS,
  MAX_BUNDLE_WAYS,
  TEXT_ROLES,
  TEXT_ROLES_BY_KIND,
  suggestBundleWays,
  suggestTextRoles,
  textRoleFitsTarget,
  type CadMappingView,
  type DrawingKind,
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
}
export const EMPTY_MEANING: LayerMeaningForm = { roles: [], ways: '' };

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
  return { roles, ways: ways === null ? '' : String(ways) };
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
    };
    if (next.roles.length > 0 || next.ways !== '') meaning[layer.name] = next;
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
  return {
    ...(roles.length > 0 ? { textRoles: roles } : {}),
    ...(ways !== null ? { ways } : {}),
  };
}

/** Roles that still fit when a layer changes target (the others would be refused). */
export function rolesFittingTarget(roles: readonly TextRole[], target: string): TextRole[] {
  return roles.filter((role) => textRoleFitsTarget(role, target));
}
