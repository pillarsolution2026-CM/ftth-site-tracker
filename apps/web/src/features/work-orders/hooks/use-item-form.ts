'use client';

import { useState, type ChangeEvent, type FormEvent } from 'react';
import type { WorkOrderItem, WorkOrderItemInput } from '@ftth/shared';
import {
  EMPTY_ITEM_FORM,
  findDuplicateCode,
  itemToFormValues,
  validateItemForm,
  type ItemFormErrors,
  type ItemFormValues,
} from '../model/item-form';

interface UseItemFormOptions {
  items: readonly WorkOrderItem[];
  /** The line being edited; omitted when adding. */
  editing?: WorkOrderItem | undefined;
  /** `acceptDuplicateCode` is true only after the user confirmed keeping the code as a separate line. */
  onSubmit: (data: WorkOrderItemInput, acceptDuplicateCode: boolean) => void;
}

/**
 * Item form state machine: editing → (duplicate code found → asking) → submitted.
 * A duplicate code is never merged or silently accepted: the user must confirm explicitly.
 */
export function useItemForm({ items, editing, onSubmit }: UseItemFormOptions) {
  const [values, setValues] = useState<ItemFormValues>(
    editing ? itemToFormValues(editing) : EMPTY_ITEM_FORM,
  );
  const [errors, setErrors] = useState<ItemFormErrors>({});
  const [pending, setPending] = useState<{
    data: WorkOrderItemInput;
    duplicates: WorkOrderItem[];
  } | null>(null);

  const onChange =
    (field: keyof ItemFormValues) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setValues((current) => ({ ...current, [field]: event.target.value }));
      setPending(null);
    };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const result = validateItemForm(values);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    const codeChanged = !editing || editing.code !== result.data.code;
    const duplicates = codeChanged ? findDuplicateCode(items, result.data.code, editing?.id) : [];
    if (duplicates.length > 0) {
      setPending({ data: result.data, duplicates });
      return;
    }
    onSubmit(result.data, false);
  };

  const confirmDuplicate = () => {
    if (!pending) return;
    onSubmit(pending.data, true);
    setPending(null);
  };

  return {
    values,
    errors,
    duplicateLines: pending ? pending.duplicates.map((item) => item.lineNo) : null,
    duplicateCode: pending?.data.code ?? null,
    onChange,
    submit,
    confirmDuplicate,
    cancelDuplicate: () => setPending(null),
  };
}
