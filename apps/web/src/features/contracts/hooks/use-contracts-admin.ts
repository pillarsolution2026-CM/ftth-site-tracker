'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/shared/i18n/locale-provider';
import { useContracts, useCreateContract } from '../api/queries';
import {
  EMPTY_CONTRACT_FORM,
  contractErrorKey,
  validateCreateContract,
  type ContractField,
  type ContractFormErrors,
  type ContractFormValues,
} from '../model/contract-forms';

/** Contract list + create form (an empty draft; the BOQ comes on the detail page). */
export function useContractsAdmin() {
  const { locale } = useI18n();
  const router = useRouter();
  const contracts = useContracts();
  const create = useCreateContract();
  const [values, setValues] = useState<ContractFormValues>(EMPTY_CONTRACT_FORM);
  const [errors, setErrors] = useState<ContractFormErrors>({});

  const onChange = (field: ContractField, value: string) => {
    setValues((current) => ({
      ...current,
      [field]: field === 'currency' ? value.toUpperCase() : value,
    }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    create.reset();
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const result = validateCreateContract(values);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    create.mutate(result.payload, {
      onSuccess: (created) => router.push(`/${locale}/admin/contracts/${created.id}`),
    });
  };

  return {
    loading: contracts.isPending,
    listError: contracts.error ? contractErrorKey(contracts.error) : null,
    items: useMemo(() => contracts.data?.items ?? [], [contracts.data]),
    values,
    errors,
    pending: create.isPending,
    submitError: create.error ? contractErrorKey(create.error) : null,
    onChange,
    onSubmit,
  };
}

export type ContractsAdminModel = ReturnType<typeof useContractsAdmin>;
