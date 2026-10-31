'use client';

import { useState } from 'react';
import type { ContractItemAvailability } from '@ftth/shared';
import { useAddItem } from '../api/queries';
import { useLinePicker } from './use-line-picker';

/**
 * Adds the ticked contract items to an existing work order, one call per line (the API adds one
 * line at a time). Stops at the first failure; lines saved before it are un-ticked so a retry
 * does not repeat them.
 */
export function useAddLines(
  projectId: string,
  workOrderId: string,
  items: readonly ContractItemAvailability[],
  onDone: () => void,
) {
  const picker = useLinePicker(items);
  const add = useAddItem(projectId, workOrderId);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const lines = picker.payload;
    if (!lines) return;
    setError(null);
    setSaving(true);
    const saved: string[] = [];
    try {
      for (const line of lines) {
        await add.mutateAsync(line);
        saved.push(line.contractItemId);
      }
      onDone();
    } catch (caught) {
      picker.drop(saved);
      setError(caught);
    } finally {
      setSaving(false);
    }
  };

  return { picker, submit, saving, error };
}
