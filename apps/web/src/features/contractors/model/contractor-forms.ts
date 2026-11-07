import {
  ContractorInputSchema,
  Decimal4StringSchema,
  Decimal6StringSchema,
  PhoneSchema,
  scopeKeyOf,
  type Contractor,
  type ContractorInput,
  type ContractorLine,
  type ContractorLineAvailability,
  type ContractorImportTarget,
} from '@ftth/shared';
import type { MessageKey } from '@ftth/i18n';
import { compareDecimals, normalizeDecimalInput, sumDecimals } from '@/shared/lib/decimal';

/** A message key with the figures it needs; the component formats and translates it. */
export interface Msg {
  key: MessageKey;
  params?: Record<string, string>;
}

const msg = (key: MessageKey, params?: Record<string, string>): Msg =>
  params ? { key, params } : { key };

// ---------------------------------------------------------------------------------------------
// Contractor (shared list)
// ---------------------------------------------------------------------------------------------

export type ContractorField =
  'name' | 'contactName' | 'contactPhone' | 'commercialRegister' | 'taxCard';
export type ContractorFormValues = Record<ContractorField, string>;
export type ContractorFormErrors = Partial<Record<ContractorField, MessageKey>>;

export const EMPTY_CONTRACTOR_FORM: ContractorFormValues = {
  name: '',
  contactName: '',
  contactPhone: '',
  commercialRegister: '',
  taxCard: '',
};

export function contractorToForm(contractor: Contractor): ContractorFormValues {
  return {
    name: contractor.name,
    contactName: contractor.contactName,
    contactPhone: contractor.contactPhone,
    commercialRegister: contractor.commercialRegister ?? '',
    taxCard: contractor.taxCard ?? '',
  };
}

const CONTRACTOR_MESSAGES: Record<ContractorField, MessageKey> = {
  name: 'validation.required',
  contactName: 'validation.required',
  contactPhone: 'contractors.validation.phone',
  commercialRegister: 'validation.tooLong',
  taxCard: 'validation.tooLong',
};

export type ContractorFormResult =
  { ok: true; payload: ContractorInput } | { ok: false; errors: ContractorFormErrors };

/** Required: name, contact person, phone. Empty optional fields become `null` (an edit can clear them). */
export function validateContractorForm(values: ContractorFormValues): ContractorFormResult {
  const optional = (value: string) => (value.trim() === '' ? null : value.trim());
  const input = {
    name: values.name.trim(),
    contactName: values.contactName.trim(),
    contactPhone: values.contactPhone.trim(),
    commercialRegister: optional(values.commercialRegister),
    taxCard: optional(values.taxCard),
  };
  const errors: ContractorFormErrors = {};
  if (input.name === '') errors.name = CONTRACTOR_MESSAGES.name;
  if (input.contactName === '') errors.contactName = CONTRACTOR_MESSAGES.contactName;
  if (!PhoneSchema.safeParse(input.contactPhone).success) {
    errors.contactPhone =
      input.contactPhone === '' ? 'validation.required' : CONTRACTOR_MESSAGES.contactPhone;
  }
  const parsed = ContractorInputSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (typeof field === 'string' && field in CONTRACTOR_MESSAGES) {
        errors[field as ContractorField] ??= CONTRACTOR_MESSAGES[field as ContractorField];
      }
    }
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, payload: input };
}

// ---------------------------------------------------------------------------------------------
// Where an uploaded sheet goes: a new registration or an existing one
// ---------------------------------------------------------------------------------------------

export interface NewTargetValues {
  contractorId: string;
  registeredOn: string;
}

export interface NewTargetErrors {
  contractorId?: Msg;
  registeredOn?: Msg;
}

/** The contractor from the list and the registration date; both are needed before the upload. */
export function validateNewTarget(
  values: NewTargetValues,
):
  | { ok: true; target: Extract<ContractorImportTarget, { kind: 'new' }> }
  | { ok: false; errors: NewTargetErrors } {
  const errors: NewTargetErrors = {};
  if (values.contractorId === '') errors.contractorId = msg('contractors.validation.contractor');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.registeredOn)) {
    errors.registeredOn = msg('contractors.validation.date');
  }
  if (errors.contractorId || errors.registeredOn) return { ok: false, errors };
  return {
    ok: true,
    target: { kind: 'new', contractorId: values.contractorId, registeredOn: values.registeredOn },
  };
}

// ---------------------------------------------------------------------------------------------
// Quantity and price checks
// ---------------------------------------------------------------------------------------------

/** Quantity rules: above 0, at most 4 decimals, at most `max` (when known). */
export function checkQuantity(raw: string, max: string | null): { value: string } | { error: Msg } {
  const value = normalizeDecimalInput(raw);
  if (!Decimal4StringSchema.safeParse(value).success || compareDecimals(value, '0') <= 0) {
    return { error: msg('contractors.validation.quantity') };
  }
  if (max !== null && compareDecimals(value, max) > 0) {
    return { error: msg('contractors.validation.quantityMax', { available: max }) };
  }
  return { value };
}

/** Price rules: at most 6 decimals, at most `maxAllowed` (what the scopes leave of the contract price). */
export function checkPrice(raw: string, maxAllowed: string): { value: string } | { error: Msg } {
  const value = normalizeDecimalInput(raw);
  if (!Decimal6StringSchema.safeParse(value).success) {
    return { error: msg('contractors.validation.price') };
  }
  if (compareDecimals(value, maxAllowed) > 0) {
    return { error: msg('contractors.validation.priceMaxAllowed', { maxAllowed }) };
  }
  return { value };
}

/** The usage of the line's own scope in the work-order line's availability, if any. */
export function scopeUsageOf(
  line: ContractorLine,
  availability: ContractorLineAvailability | undefined,
) {
  const key = scopeKeyOf(line.scope);
  return availability?.scopes.find((entry) => scopeKeyOf(entry.scope) === key);
}

/**
 * A new quantity: at most what is still free for the line's scope, counting the quantity this
 * line already holds.
 */
export function validateLineQuantity(
  raw: string,
  line: ContractorLine,
  availability: ContractorLineAvailability | undefined,
): { ok: true; quantity: string } | { ok: false; error: Msg } {
  const usage = scopeUsageOf(line, availability);
  const max = usage ? sumDecimals([usage.availableQuantity, line.quantity]) : null;
  const result = checkQuantity(raw, max);
  return 'error' in result
    ? { ok: false, error: result.error }
    : { ok: true, quantity: result.value };
}

export interface PriceFormValues {
  effectiveFrom: string;
  unitPrice: string;
}

export interface PriceFormErrors {
  effectiveFrom?: Msg;
  unitPrice?: Msg;
}

/**
 * The most a new price of this line's scope may be: the room the scopes leave under the contract
 * price, plus the highest price this scope already counts for. Without availability, the contract
 * price.
 */
export function maxAllowedPriceOf(
  line: ContractorLine,
  availability: ContractorLineAvailability | undefined,
): string {
  if (!availability) return line.contractPrice;
  const usage = scopeUsageOf(line, availability);
  return sumDecimals([availability.priceRoom, usage?.highestPrice ?? '0']);
}

/** A dated price: after the latest price date (ISO dates compare as text), within the allowed maximum. */
export function validatePriceForm(
  values: PriceFormValues,
  line: ContractorLine,
  availability?: ContractorLineAvailability,
):
  | { ok: true; payload: { effectiveFrom: string; unitPrice: string } }
  | { ok: false; errors: PriceFormErrors } {
  const errors: PriceFormErrors = {};
  const latest = line.prices[line.prices.length - 1]?.effectiveFrom ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.effectiveFrom)) {
    errors.effectiveFrom = msg('contractors.validation.date');
  } else if (latest !== '' && values.effectiveFrom <= latest) {
    errors.effectiveFrom = msg('contractors.validation.priceDate', { latest });
  }
  const price = checkPrice(values.unitPrice, maxAllowedPriceOf(line, availability));
  if ('error' in price) errors.unitPrice = price.error;
  if (errors.effectiveFrom || errors.unitPrice || !('value' in price)) return { ok: false, errors };
  return { ok: true, payload: { effectiveFrom: values.effectiveFrom, unitPrice: price.value } };
}
