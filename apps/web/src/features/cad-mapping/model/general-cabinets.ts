import type { MessageKey } from '@ftth/i18n';
import {
  SECONDARY_PLACEMENT_REFUSALS,
  type SecondaryPlacementRefusal,
  type SharedCabinetsUnmatched,
} from '@ftth/shared';
import type { ClientErrorCode } from '@/shared/api/bff-client';

/** Is this refusal reason one of the eight the suggestion route answers with (409)? */
export function isPlacementRefusal(reason: string | null): reason is SecondaryPlacementRefusal {
  return reason !== null && (SECONDARY_PLACEMENT_REFUSALS as readonly string[]).includes(reason);
}

/**
 * The clear message of a failed «من كبائن الرئيسي»: each 409 refusal reason has its own text;
 * anything else is the generic failure (nothing is guessed).
 */
export function generalCabinetsErrorKey(code: ClientErrorCode, reason: string | null): MessageKey {
  if (code === 'CONFLICT' && isPlacementRefusal(reason)) {
    return `mapping.placement.cabinets.refusal.${reason}`;
  }
  return code === 'FORBIDDEN' ? 'errors.FORBIDDEN' : 'mapping.placement.cabinets.failed';
}

export const UNMATCHED_LISTS = [
  'onlyInSecondary',
  'onlyInGeneral',
  'duplicateInSecondary',
  'duplicateInGeneral',
  'withoutDrawingPosition',
  'unusable',
] as const satisfies readonly (keyof SharedCabinetsUnmatched)[];

/** Does anything in the suggestion's unmatched part need showing? */
export function hasUnmatched(unmatched: SharedCabinetsUnmatched): boolean {
  return (
    UNMATCHED_LISTS.some((key) => unmatched[key].length > 0) ||
    unmatched.unnamedSecondary > 0 ||
    unmatched.unnamedGeneral > 0 ||
    unmatched.listCapped
  );
}
