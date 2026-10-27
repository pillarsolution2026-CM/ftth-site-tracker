import { Decimal4StringSchema, type WorkOrderItem, type WorkOrderItemInput } from '@ftth/shared';
import type { MessageKey } from '@ftth/i18n';
import { normalizeDecimalInput } from '@/shared/lib/decimal';

export interface ItemFormValues {
  code: string;
  description: string;
  unit: string;
  quantity: string;
  unitPrice: string;
}

export type ItemFormErrors = Partial<Record<keyof ItemFormValues, MessageKey>>;

export const EMPTY_ITEM_FORM: ItemFormValues = {
  code: '',
  description: '',
  unit: '',
  quantity: '',
  unitPrice: '',
};

const LIMITS: Record<'code' | 'description' | 'unit', number> = {
  code: 64,
  description: 2000,
  unit: 32,
};

export function itemToFormValues(item: WorkOrderItem): ItemFormValues {
  return {
    code: item.code,
    description: item.description,
    unit: item.unit,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
  };
}

export type ItemValidation =
  { ok: true; data: WorkOrderItemInput } | { ok: false; errors: ItemFormErrors };

/** Amounts stay strings end to end; typed Arabic digits are normalised, never parsed as numbers. */
export function validateItemForm(values: ItemFormValues): ItemValidation {
  const errors: ItemFormErrors = {};
  const text = (field: 'code' | 'description' | 'unit'): string => {
    const value = values[field].trim();
    if (value === '') errors[field] = 'validation.required';
    else if (value.length > LIMITS[field]) errors[field] = 'validation.tooLong';
    return value;
  };
  const code = text('code');
  const description = text('description');
  const unit = text('unit');

  const decimal = (field: 'quantity' | 'unitPrice'): string => {
    const value = normalizeDecimalInput(values[field]);
    if (value === '') errors[field] = 'validation.required';
    else if (!Decimal4StringSchema.safeParse(value).success) errors[field] = 'validation.decimal';
    return value;
  };
  const quantity = decimal('quantity');
  const unitPrice = decimal('unitPrice');

  return Object.keys(errors).length > 0
    ? { ok: false, errors }
    : { ok: true, data: { code, description, unit, quantity, unitPrice } };
}

/** An existing line that already uses this code (the line being edited is ignored). */
export function findDuplicateCode(
  items: readonly WorkOrderItem[],
  code: string,
  ignoreItemId?: string,
): WorkOrderItem[] {
  return items.filter((item) => item.code === code && item.id !== ignoreItemId);
}
