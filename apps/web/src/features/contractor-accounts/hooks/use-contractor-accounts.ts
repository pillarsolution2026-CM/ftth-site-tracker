'use client';

import { useState, type FormEvent } from 'react';
import type { MessageKey } from '@ftth/i18n';
import type { ContractorAccount } from '@ftth/shared';
import {
  useContractorAccounts,
  useCreateContractorAccount,
  useSetContractorAccountActive,
} from '../api/queries';
import { accountErrorKey } from '../model/account-errors';
import {
  EMPTY_ACCOUNT_FORM,
  validateAccountForm,
  type AccountField,
  type AccountFormValues,
} from '../model/account-forms';

/**
 * Accounts of one registration's contractor: list, create form and stop / restart. The password
 * lives only in the form state: it is cleared on success and never logged.
 */
export function useContractorAccountsSection(projectId: string, registrationId: string) {
  const accounts = useContractorAccounts(projectId, registrationId);
  const create = useCreateContractorAccount(projectId, registrationId);
  const setActive = useSetContractorAccountActive(projectId, registrationId);
  const [values, setValues] = useState<AccountFormValues>(EMPTY_ACCOUNT_FORM);
  const [errors, setErrors] = useState<Partial<Record<AccountField, MessageKey>>>({});
  const [created, setCreated] = useState(false);

  const onChange = (field: AccountField, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setCreated(false);
    create.reset();
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const result = validateAccountForm(values);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    create.mutate(result.payload, {
      onSuccess: () => {
        setValues(EMPTY_ACCOUNT_FORM);
        setCreated(true);
        // React Query keeps the mutation variables (the password) until reset.
        create.reset();
      },
    });
  };

  const onToggleActive = (account: ContractorAccount, confirmed: boolean) => {
    if (confirmed) setActive.mutate({ userId: account.userId, isActive: !account.isActive });
  };

  return {
    loading: accounts.isPending,
    listError: accounts.error ? accountErrorKey(accounts.error) : null,
    items: accounts.data?.items ?? [],
    values,
    errors,
    pending: create.isPending,
    created,
    submitError: create.error ? accountErrorKey(create.error) : null,
    toggling: setActive.isPending,
    toggleError: setActive.error ? accountErrorKey(setActive.error) : null,
    onChange,
    onSubmit,
    onToggleActive,
  };
}

export type ContractorAccountsModel = ReturnType<typeof useContractorAccountsSection>;
