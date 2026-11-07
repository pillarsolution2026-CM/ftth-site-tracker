'use client';

import { useState, type FormEvent } from 'react';
import type { ContractorLineAvailability } from '@ftth/shared';
import { useRegisterContractor } from '../api/queries';
import { contractorErrorMsg } from '../model/contractor-errors';
import {
  EMPTY_REGISTRATION_FORM,
  validateRegistration,
  type RegistrationErrors,
  type RegistrationFormValues,
} from '../model/contractor-forms';

const NO_ERRORS: RegistrationErrors = { line: {} };

/** The «تسجيل مقاول» form: contractor, date and the chosen lines with quantity and price. */
export function useRegisterContractorForm(
  projectId: string,
  availability: readonly ContractorLineAvailability[],
) {
  const register = useRegisterContractor(projectId);
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<RegistrationFormValues>(EMPTY_REGISTRATION_FORM);
  const [errors, setErrors] = useState<RegistrationErrors>(NO_ERRORS);

  const touch = () => register.reset();

  const onOpen = () => {
    setValues(EMPTY_REGISTRATION_FORM);
    setErrors(NO_ERRORS);
    register.reset();
    setOpen(true);
  };
  const onClose = () => setOpen(false);

  const onField = (field: 'contractorId' | 'registeredOn', value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    touch();
  };

  /** Choosing a line proposes the contract price; the admin may lower it. */
  const onToggleLine = (line: ContractorLineAvailability, selected: boolean) => {
    setValues((current) => ({
      ...current,
      lines: {
        ...current.lines,
        [line.workOrderItemId]: {
          selected,
          quantity: current.lines[line.workOrderItemId]?.quantity ?? '',
          unitPrice: current.lines[line.workOrderItemId]?.unitPrice || line.contractPrice,
        },
      },
    }));
    setErrors((current) => ({ ...current, lines: undefined }));
    touch();
  };

  const onLineChange = (itemId: string, field: 'quantity' | 'unitPrice', value: string) => {
    setValues((current) => {
      const draft = current.lines[itemId] ?? { selected: true, quantity: '', unitPrice: '' };
      return { ...current, lines: { ...current.lines, [itemId]: { ...draft, [field]: value } } };
    });
    setErrors((current) => ({ ...current, line: { ...current.line, [itemId]: {} } }));
    touch();
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const result = validateRegistration(values, availability);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors(NO_ERRORS);
    register.mutate(result.payload, { onSuccess: () => setOpen(false) });
  };

  return {
    open,
    values,
    errors,
    pending: register.isPending,
    submitError: register.error ? contractorErrorMsg(register.error) : null,
    onOpen,
    onClose,
    onField,
    onToggleLine,
    onLineChange,
    onSubmit,
  };
}

export type RegisterContractorModel = ReturnType<typeof useRegisterContractorForm>;
