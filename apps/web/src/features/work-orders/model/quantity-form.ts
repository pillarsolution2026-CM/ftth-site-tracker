import { Decimal4StringSchema } from '@ftth/shared';
import type { MessageKey } from '@ftth/i18n';
import { compareDecimals, normalizeDecimalInput, sumDecimals } from '@/shared/lib/decimal';

export type QuantityValidation = { ok: true; quantity: string } | { ok: false; error: MessageKey };

/** The only editable field of a work-order line (ADR-028). Stays a string end to end. */
export function validateQuantity(raw: string): QuantityValidation {
  const quantity = normalizeDecimalInput(raw);
  if (quantity === '') return { ok: false, error: 'validation.required' };
  if (!Decimal4StringSchema.safeParse(quantity).success) {
    return { ok: false, error: 'validation.decimal' };
  }
  return { ok: true, quantity };
}

/**
 * Quantity above what the line could take: what is available plus the quantity the line holds
 * now. A warning only; the server has the final say (409 QUANTITY_EXCEEDS_CONTRACT).
 */
export function exceedsAvailable(
  quantity: string,
  currentQuantity: string,
  availableQuantity: string,
): boolean {
  return compareDecimals(quantity, sumDecimals([availableQuantity, currentQuantity])) > 0;
}
