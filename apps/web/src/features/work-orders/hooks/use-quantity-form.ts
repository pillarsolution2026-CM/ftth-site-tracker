'use client';

import { useState, type FormEvent } from 'react';
import type { ContractItemAvailability, WorkOrderItem } from '@ftth/shared';
import type { MessageKey } from '@ftth/i18n';
import { useUpdateItem } from '../api/queries';
import { exceedsAvailable, validateQuantity } from '../model/quantity-form';

/** State of the quantity-only line edit (ADR-028). */
export function useQuantityForm(
  projectId: string,
  workOrderId: string,
  item: WorkOrderItem,
  availability: ContractItemAvailability | undefined,
  onDone: () => void,
) {
  const update = useUpdateItem(projectId, workOrderId);
  const [value, setValue] = useState(item.quantity);
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null);

  const checked = validateQuantity(value);
  const warnExceeds =
    checked.ok &&
    availability !== undefined &&
    exceedsAvailable(checked.quantity, item.quantity, availability.availableQuantity);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = validateQuantity(value);
    if (!result.ok) {
      setErrorKey(result.error);
      return;
    }
    setErrorKey(null);
    update.mutate({ itemId: item.id, body: { quantity: result.quantity } }, { onSuccess: onDone });
  };

  return {
    value,
    setValue,
    errorKey,
    warnExceeds,
    submit,
    pending: update.isPending,
    error: update.error,
  };
}
