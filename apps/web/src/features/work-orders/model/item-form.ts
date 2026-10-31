import {
  Decimal4StringSchema,
  Decimal6StringSchema,
  ITEM_TEXT_LIMITS,
  WorkTypeSchema,
  type WorkOrderItemInput,
} from '@ftth/shared';
import type { MessageKey } from '@ftth/i18n';
import { normalizeDecimalInput } from '@/shared/lib/decimal';

/** Fields of a contract BOQ line (the contract line form reuses this validation). */
export interface ItemFormValues {
  code: string;
  description: string;
  unit: string;
  quantity: string;
  unitPrice: string;
  /** '' until the user picks one of WORK_TYPES (required, ADR-016). */
  workType: string;
}

export type ItemFormErrors = Partial<Record<keyof ItemFormValues, MessageKey>>;

const LIMITS: Record<'code' | 'description' | 'unit', number> = ITEM_TEXT_LIMITS;

/** Quantities keep 4 decimals, unit prices 6 (ADR-016). */
const DECIMAL_SCHEMAS = {
  quantity: Decimal4StringSchema,
  unitPrice: Decimal6StringSchema,
} as const;

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
    else if (!DECIMAL_SCHEMAS[field].safeParse(value).success) {
      errors[field] = field === 'unitPrice' ? 'validation.priceDecimal' : 'validation.decimal';
    }
    return value;
  };
  const quantity = decimal('quantity');
  const unitPrice = decimal('unitPrice');

  const workType = WorkTypeSchema.safeParse(values.workType);
  if (!workType.success) errors.workType = 'validation.required';

  return Object.keys(errors).length > 0 || !workType.success
    ? { ok: false, errors }
    : {
        ok: true,
        data: { code, description, unit, quantity, unitPrice, workType: workType.data },
      };
}
