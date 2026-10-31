import {
  CreateContractRequestSchema,
  ITEM_TEXT_LIMITS,
  type ContractDetail,
  type ContractItem,
  type ContractItemInput,
  type CreateContractRequest,
  type UpdateContractRequest,
} from '@ftth/shared';
import type { MessageKey } from '@ftth/i18n';
import { errorCodeOf, errorReasonOf } from '@/shared/api/bff-client';
import {
  validateItemForm,
  type ItemFormErrors,
  type ItemFormValues,
} from '@/features/work-orders/model/item-form';

// ---------------------------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------------------------

export type ContractField =
  'number' | 'name' | 'client' | 'currency' | 'startsOn' | 'durationDays' | 'notes';
export type ContractFormValues = Record<ContractField, string>;
export type ContractFormErrors = Partial<Record<ContractField, MessageKey>>;

export const EMPTY_CONTRACT_FORM: ContractFormValues = {
  number: '',
  name: '',
  client: '',
  currency: '',
  startsOn: '',
  durationDays: '',
  notes: '',
};

export function contractToForm(contract: ContractDetail): ContractFormValues {
  return {
    number: contract.number,
    name: contract.name,
    client: contract.client,
    currency: contract.currency,
    startsOn: contract.startsOn ?? '',
    durationDays: contract.durationDays === null ? '' : String(contract.durationDays),
    notes: contract.notes ?? '',
  };
}

const MESSAGES: Record<ContractField, MessageKey> = {
  number: 'validation.required',
  name: 'validation.required',
  client: 'validation.required',
  currency: 'admin.validation.currency',
  startsOn: 'validation.date',
  durationDays: 'admin.contracts.validation.duration',
  notes: 'validation.tooLong',
};

type HeaderPayload = Omit<CreateContractRequest, 'currency'>;

/** Empty optional fields become `null` so an edit can clear them. */
function headerParts(values: ContractFormValues): {
  payload: HeaderPayload;
  errors: ContractFormErrors;
} {
  const errors: ContractFormErrors = {};
  const days = values.durationDays.trim();
  let durationDays: number | null = null;
  if (days !== '') {
    if (/^\d{1,5}$/.test(days)) durationDays = Number(days);
    else errors.durationDays = MESSAGES.durationDays;
  }
  const payload: HeaderPayload = {
    number: values.number.trim(),
    name: values.name.trim(),
    client: values.client.trim(),
    startsOn: values.startsOn.trim() === '' ? null : values.startsOn.trim(),
    durationDays,
    notes: values.notes.trim() === '' ? null : values.notes.trim(),
  };
  return { payload, errors };
}

function issuesToErrors(issues: readonly { path: readonly PropertyKey[] }[]): ContractFormErrors {
  const errors: ContractFormErrors = {};
  for (const issue of issues) {
    const field = issue.path[0];
    if (typeof field === 'string' && field in MESSAGES) {
      errors[field as ContractField] ??= MESSAGES[field as ContractField];
    }
  }
  return errors;
}

export type CreateContractValidation =
  { ok: true; payload: CreateContractRequest } | { ok: false; errors: ContractFormErrors };

export function validateCreateContract(values: ContractFormValues): CreateContractValidation {
  const { payload, errors } = headerParts(values);
  const parsed = CreateContractRequestSchema.safeParse({
    ...payload,
    currency: values.currency.trim().toUpperCase(),
  });
  if (parsed.success && Object.keys(errors).length === 0) {
    return { ok: true, payload: parsed.data };
  }
  return {
    ok: false,
    errors: { ...(parsed.success ? {} : issuesToErrors(parsed.error.issues)), ...errors },
  };
}

export type UpdateContractValidation =
  | { ok: true; payload: Omit<UpdateContractRequest, 'expectedVersion'> }
  | { ok: false; errors: ContractFormErrors };

/** Edit: the currency is never sent (fixed after creation). */
export function validateUpdateContract(values: ContractFormValues): UpdateContractValidation {
  const { payload, errors } = headerParts(values);
  const parsed = CreateContractRequestSchema.omit({ currency: true }).safeParse(payload);
  if (parsed.success && Object.keys(errors).length === 0) {
    return { ok: true, payload: parsed.data };
  }
  return {
    ok: false,
    errors: { ...(parsed.success ? {} : issuesToErrors(parsed.error.issues)), ...errors },
  };
}

// ---------------------------------------------------------------------------------------------
// BOQ line (item or heading)
// ---------------------------------------------------------------------------------------------

export type LineKind = 'item' | 'heading';
export interface LineFormValues extends ItemFormValues {
  kind: LineKind;
}
export type LineFormErrors = ItemFormErrors;

export const EMPTY_LINE_FORM: LineFormValues = {
  kind: 'item',
  code: '',
  description: '',
  unit: '',
  quantity: '',
  unitPrice: '',
  workType: '',
};

export function lineToForm(item: ContractItem): LineFormValues {
  return {
    kind: item.kind,
    code: item.code,
    description: item.description ?? '',
    unit: item.unit ?? '',
    quantity: item.quantity ?? '',
    unitPrice: item.unitPrice ?? '',
    workType: item.workType ?? '',
  };
}

export type LineValidation =
  { ok: true; data: ContractItemInput } | { ok: false; errors: LineFormErrors };

/** A heading needs only a code and may have a title; an item has the work-order item rules. */
export function validateLineForm(values: LineFormValues): LineValidation {
  if (values.kind === 'heading') {
    const code = values.code.trim();
    if (code === '') return { ok: false, errors: { code: 'validation.required' } };
    if (code.length > ITEM_TEXT_LIMITS.code) {
      return { ok: false, errors: { code: 'validation.tooLong' } };
    }
    const description = values.description.trim();
    if (description.length > ITEM_TEXT_LIMITS.description) {
      return { ok: false, errors: { description: 'validation.tooLong' } };
    }
    return {
      ok: true,
      data: { kind: 'heading', code, description: description === '' ? null : description },
    };
  }
  const result = validateItemForm(values);
  return result.ok
    ? { ok: true, data: { kind: 'item', ...result.data } }
    : { ok: false, errors: result.errors };
}

/** Another line that already uses this code (the line being edited is ignored). */
export function findDuplicateLines(
  items: readonly ContractItem[],
  code: string,
  ignoreItemId?: string,
): ContractItem[] {
  return items.filter((item) => item.code === code && item.id !== ignoreItemId);
}

// ---------------------------------------------------------------------------------------------
// BOQ display
// ---------------------------------------------------------------------------------------------

/** Indentation level of each line from `parentCode` (0 at the top). */
export function boqDepths(items: readonly ContractItem[]): Map<string, number> {
  const parentOfCode = new Map<string, string | null>();
  for (const item of items) {
    if (!parentOfCode.has(item.code)) parentOfCode.set(item.code, item.parentCode);
  }
  const depths = new Map<string, number>();
  for (const item of items) {
    let depth = 0;
    let parent = item.parentCode;
    const seen = new Set<string>();
    while (parent !== null && !seen.has(parent)) {
      seen.add(parent);
      depth += 1;
      parent = parentOfCode.get(parent) ?? null;
    }
    depths.set(item.id, depth);
  }
  return depths;
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

const REASON_MESSAGES: Readonly<Record<string, MessageKey>> = {
  STALE_VERSION: 'admin.contracts.reasons.STALE_VERSION',
  CONTRACT_APPROVED: 'admin.contracts.reasons.CONTRACT_APPROVED',
  DUPLICATE_CODE: 'admin.contracts.reasons.DUPLICATE_CODE',
  LINE_TAKEN: 'admin.contracts.reasons.LINE_TAKEN',
  DUPLICATE_NUMBER: 'admin.contracts.reasons.DUPLICATE_NUMBER',
  NO_PRICED_ITEMS: 'admin.contracts.reasons.NO_PRICED_ITEMS',
};

/** Message of a failed contract call: the 409 `details.reason` when known, else the error code. */
export function contractErrorKey(error: unknown): MessageKey {
  const reason = errorReasonOf(error);
  return (reason ? REASON_MESSAGES[reason] : undefined) ?? `errors.${errorCodeOf(error)}`;
}

/** The stale-version answer asks the user to reload instead of retrying. */
export function isStaleVersion(error: unknown): boolean {
  return errorReasonOf(error) === 'STALE_VERSION';
}
