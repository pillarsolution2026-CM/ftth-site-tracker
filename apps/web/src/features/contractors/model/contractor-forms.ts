import {
  ContractorInputSchema,
  Decimal4StringSchema,
  Decimal6StringSchema,
  PhoneSchema,
  RegisterContractorRequestSchema,
  type Contractor,
  type ContractorInput,
  type ContractorLine,
  type ContractorLineAvailability,
  type RegisterContractorRequest,
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
// Registration (a contractor on the work order)
// ---------------------------------------------------------------------------------------------

export interface LineDraft {
  selected: boolean;
  quantity: string;
  unitPrice: string;
}

export interface RegistrationFormValues {
  contractorId: string;
  registeredOn: string;
  /** By work-order line id. */
  lines: Record<string, LineDraft>;
}

export interface LineErrors {
  quantity?: Msg;
  unitPrice?: Msg;
}

export interface RegistrationErrors {
  contractorId?: Msg;
  registeredOn?: Msg;
  lines?: Msg;
  line: Record<string, LineErrors>;
}

export const EMPTY_REGISTRATION_FORM: RegistrationFormValues = {
  contractorId: '',
  registeredOn: '',
  lines: {},
};

/** Why a work-order line cannot be given to a contractor, or null when it can. */
export function lineBlockReason(line: ContractorLineAvailability): MessageKey | null {
  if (!line.assignable) return 'contractors.register.notAssignable';
  if (compareDecimals(line.availableQuantity, '0') <= 0) return 'contractors.register.nothingLeft';
  return null;
}

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

/** Price rules: at most 6 decimals, at most the contract price. */
export function checkPrice(raw: string, contractPrice: string): { value: string } | { error: Msg } {
  const value = normalizeDecimalInput(raw);
  if (!Decimal6StringSchema.safeParse(value).success) {
    return { error: msg('contractors.validation.price') };
  }
  if (compareDecimals(value, contractPrice) > 0) {
    return { error: msg('contractors.validation.priceMax', { contractPrice }) };
  }
  return { value };
}

export type RegistrationResult =
  { ok: true; payload: RegisterContractorRequest } | { ok: false; errors: RegistrationErrors };

/** Mirrors the server rules so the admin sees the problem before saving; the server still decides. */
export function validateRegistration(
  values: RegistrationFormValues,
  availability: readonly ContractorLineAvailability[],
): RegistrationResult {
  const errors: RegistrationErrors = { line: {} };
  if (values.contractorId === '') errors.contractorId = msg('contractors.validation.contractor');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.registeredOn)) {
    errors.registeredOn = msg('contractors.validation.date');
  }
  const lines: RegisterContractorRequest['lines'] = [];
  for (const line of availability) {
    const draft = values.lines[line.workOrderItemId];
    if (!draft?.selected || lineBlockReason(line) !== null) continue;
    const quantity = checkQuantity(draft.quantity, line.availableQuantity);
    const price = checkPrice(draft.unitPrice, line.contractPrice);
    if ('error' in quantity || 'error' in price) {
      errors.line[line.workOrderItemId] = {
        ...('error' in quantity ? { quantity: quantity.error } : {}),
        ...('error' in price ? { unitPrice: price.error } : {}),
      };
      continue;
    }
    lines.push({
      workOrderItemId: line.workOrderItemId,
      quantity: quantity.value,
      unitPrice: price.value,
    });
  }
  const chosen = availability.filter(
    (line) => values.lines[line.workOrderItemId]?.selected && lineBlockReason(line) === null,
  );
  if (chosen.length === 0) errors.lines = msg('contractors.validation.noLines');

  const failed =
    errors.contractorId ||
    errors.registeredOn ||
    errors.lines ||
    Object.keys(errors.line).length > 0;
  if (failed) return { ok: false, errors };
  const parsed = RegisterContractorRequestSchema.safeParse({
    contractorId: values.contractorId,
    registeredOn: values.registeredOn,
    lines,
  });
  if (!parsed.success) {
    return {
      ok: false,
      errors: { ...errors, contractorId: msg('contractors.validation.contractor') },
    };
  }
  return { ok: true, payload: parsed.data };
}

// ---------------------------------------------------------------------------------------------
// One line of a registration: quantity and dated price
// ---------------------------------------------------------------------------------------------

/**
 * A new quantity: at most what the work-order line still has for contractors, counting the
 * quantity this line already holds.
 */
export function validateLineQuantity(
  raw: string,
  line: ContractorLine,
  availability: ContractorLineAvailability | undefined,
): { ok: true; quantity: string } | { ok: false; error: Msg } {
  const max = availability ? sumDecimals([availability.availableQuantity, line.quantity]) : null;
  const result = checkQuantity(raw, max);
  return 'error' in result
    ? { ok: false, error: result.error }
    : { ok: true, quantity: result.value };
}

export interface AddLineValues {
  workOrderItemId: string;
  quantity: string;
  unitPrice: string;
}

export interface AddLineErrors {
  workOrderItemId?: Msg;
  quantity?: Msg;
  unitPrice?: Msg;
}

export const EMPTY_ADD_LINE: AddLineValues = { workOrderItemId: '', quantity: '', unitPrice: '' };

/** Why a work-order line cannot be added to this contractor, or null when it can. */
export function addLineBlockReason(
  line: ContractorLineAvailability,
  registration: { lines: readonly ContractorLine[] },
): MessageKey | null {
  if (registration.lines.some((entry) => entry.workOrderItemId === line.workOrderItemId)) {
    return 'contractors.line.alreadyHas';
  }
  return lineBlockReason(line);
}

/** Adding a line to an existing registration: same checks as the registration form. */
export function validateAddLine(
  values: AddLineValues,
  registration: { lines: readonly ContractorLine[] },
  availability: readonly ContractorLineAvailability[],
):
  | { ok: true; payload: { workOrderItemId: string; quantity: string; unitPrice: string } }
  | { ok: false; errors: AddLineErrors } {
  const line = availability.find((entry) => entry.workOrderItemId === values.workOrderItemId);
  if (!line || addLineBlockReason(line, registration) !== null) {
    return { ok: false, errors: { workOrderItemId: msg('contractors.validation.chooseLine') } };
  }
  const quantity = checkQuantity(values.quantity, line.availableQuantity);
  const price = checkPrice(values.unitPrice, line.contractPrice);
  if ('error' in quantity || 'error' in price) {
    return {
      ok: false,
      errors: {
        ...('error' in quantity ? { quantity: quantity.error } : {}),
        ...('error' in price ? { unitPrice: price.error } : {}),
      },
    };
  }
  return {
    ok: true,
    payload: {
      workOrderItemId: line.workOrderItemId,
      quantity: quantity.value,
      unitPrice: price.value,
    },
  };
}

export interface PriceFormValues {
  effectiveFrom: string;
  unitPrice: string;
}

export interface PriceFormErrors {
  effectiveFrom?: Msg;
  unitPrice?: Msg;
}

/** A dated price: after the latest price date (ISO dates compare as text), at most the contract price. */
export function validatePriceForm(
  values: PriceFormValues,
  line: ContractorLine,
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
  const price = checkPrice(values.unitPrice, line.contractPrice);
  if ('error' in price) errors.unitPrice = price.error;
  if (errors.effectiveFrom || errors.unitPrice || !('value' in price)) return { ok: false, errors };
  return { ok: true, payload: { effectiveFrom: values.effectiveFrom, unitPrice: price.value } };
}
