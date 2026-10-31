'use client';

import { useState, type ChangeEvent, type FormEvent } from 'react';
import type { ContractItem, ContractItemInput } from '@ftth/shared';
import {
  EMPTY_LINE_FORM,
  findDuplicateLines,
  lineToForm,
  validateLineForm,
  type LineFormErrors,
  type LineFormValues,
  type LineKind,
} from '../model/contract-forms';

interface UseLineFormOptions {
  items: readonly ContractItem[];
  /** The line being edited; omitted when adding. */
  editing?: ContractItem | undefined;
  /** Kind of a new line (an edited line keeps its kind). */
  initialKind: LineKind;
  /** `acceptDuplicateCode` is true only after the admin confirmed keeping the code. */
  onSubmit: (data: ContractItemInput, acceptDuplicateCode: boolean) => void;
}

/**
 * BOQ line form state machine (item or heading): editing → (duplicate code found → asking) →
 * submitted. A duplicate code is never silently accepted.
 */
export function useLineForm({ items, editing, initialKind, onSubmit }: UseLineFormOptions) {
  const [values, setValues] = useState<LineFormValues>(
    editing ? lineToForm(editing) : { ...EMPTY_LINE_FORM, kind: initialKind },
  );
  const [errors, setErrors] = useState<LineFormErrors>({});
  const [pending, setPending] = useState<{
    data: ContractItemInput;
    duplicates: ContractItem[];
  } | null>(null);

  const onChange =
    (field: keyof LineFormValues) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setValues((current) => ({ ...current, [field]: event.target.value }));
      setPending(null);
    };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const result = validateLineForm(values);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    const codeChanged = !editing || editing.code !== result.data.code;
    const duplicates = codeChanged ? findDuplicateLines(items, result.data.code, editing?.id) : [];
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
