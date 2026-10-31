'use client';

import { useMemo, useState } from 'react';
import type { ContractItemAvailability } from '@ftth/shared';
import {
  checkSelection,
  filterItems,
  linePayload,
  type LineCheck,
  type LineSelection,
} from '../model/line-picker';

/** Search text and ticked items of the contract-item picker (create and add-line screens). */
export function useLinePicker(items: readonly ContractItemAvailability[]) {
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<LineSelection[]>([]);

  const rows = useMemo(() => filterItems(items, search), [items, search]);
  const checks = useMemo(() => checkSelection(items, selection), [items, selection]);

  const toggle = (contractItemId: string) =>
    setSelection((current) =>
      current.some((line) => line.contractItemId === contractItemId)
        ? current.filter((line) => line.contractItemId !== contractItemId)
        : [...current, { contractItemId, quantity: '' }],
    );

  const setQuantity = (contractItemId: string, quantity: string) =>
    setSelection((current) =>
      current.map((line) =>
        line.contractItemId === contractItemId ? { ...line, quantity } : line,
      ),
    );

  const checkOf = (contractItemId: string): LineCheck | undefined =>
    checks.find((check) => check.contractItemId === contractItemId);

  return {
    search,
    setSearch,
    rows,
    selection,
    checks,
    checkOf,
    toggle,
    setQuantity,
    clear: () => setSelection([]),
    /** Un-ticks items that were saved already (a partial add). */
    drop: (ids: readonly string[]) =>
      setSelection((current) => current.filter((line) => !ids.includes(line.contractItemId))),
    /** Lines for the API; null while a quantity is missing/invalid or an item is repeated. */
    payload: linePayload(checks),
  };
}

export type LinePicker = ReturnType<typeof useLinePicker>;
