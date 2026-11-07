'use client';

import { useMemo, useState, type FormEvent } from 'react';
import type { Contractor } from '@ftth/shared';
import { useContractors, useCreateContractor, useUpdateContractor } from '../api/queries';
import { contractorErrorMsg } from '../model/contractor-errors';
import {
  EMPTY_CONTRACTOR_FORM,
  contractorToForm,
  validateContractorForm,
  type ContractorField,
  type ContractorFormErrors,
  type ContractorFormValues,
} from '../model/contractor-forms';

/** Contractor list plus the form that creates or edits one. */
export function useContractorsAdmin() {
  const contractors = useContractors();
  const create = useCreateContractor();
  const update = useUpdateContractor();
  const [values, setValues] = useState<ContractorFormValues>(EMPTY_CONTRACTOR_FORM);
  const [errors, setErrors] = useState<ContractorFormErrors>({});
  const [editing, setEditing] = useState<Contractor | null>(null);
  const [notice, setNotice] = useState<'created' | 'saved' | null>(null);
  const mutation = editing ? update : create;

  const resetForm = () => {
    setValues(EMPTY_CONTRACTOR_FORM);
    setErrors({});
    setEditing(null);
  };

  const onChange = (field: ContractorField, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setNotice(null);
    mutation.reset();
  };

  const onEdit = (contractor: Contractor) => {
    create.reset();
    update.reset();
    setNotice(null);
    setErrors({});
    setValues(contractorToForm(contractor));
    setEditing(contractor);
  };

  const onCancelEdit = () => {
    update.reset();
    resetForm();
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const result = validateContractorForm(values);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    if (editing) {
      update.mutate(
        {
          contractorId: editing.id,
          body: { ...result.payload, expectedVersion: editing.version },
        },
        {
          onSuccess: () => {
            resetForm();
            setNotice('saved');
          },
        },
      );
    } else {
      create.mutate(result.payload, {
        onSuccess: () => {
          resetForm();
          setNotice('created');
        },
      });
    }
  };

  return {
    loading: contractors.isPending,
    listError: contractors.error ? contractorErrorMsg(contractors.error) : null,
    items: useMemo(() => contractors.data?.items ?? [], [contractors.data]),
    values,
    errors,
    editing,
    notice,
    pending: mutation.isPending,
    submitError: mutation.error ? contractorErrorMsg(mutation.error) : null,
    onChange,
    onEdit,
    onCancelEdit,
    onSubmit,
  };
}

export type ContractorsAdminModel = ReturnType<typeof useContractorsAdmin>;
