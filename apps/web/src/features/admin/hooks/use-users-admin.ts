'use client';

import { useState, type FormEvent } from 'react';
import type { MessageKey } from '@ftth/i18n';
import type { AdminUser } from '@ftth/shared';
import { useAdminUsers, useCreateUser, useSetUserActive } from '../api/queries';
import { adminErrorKey } from '../model/admin-errors';
import {
  EMPTY_USER_FORM,
  validateUserForm,
  type UserField,
  type UserFormValues,
} from '../model/admin-forms';

/** User list, create form and (de)activation. The password is cleared from state after creation. */
export function useUsersAdmin() {
  const users = useAdminUsers();
  const create = useCreateUser();
  const setActive = useSetUserActive();
  const [values, setValues] = useState<UserFormValues>(EMPTY_USER_FORM);
  const [errors, setErrors] = useState<Partial<Record<UserField, MessageKey>>>({});
  const [created, setCreated] = useState(false);

  const onChange = (field: UserField, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setCreated(false);
    create.reset();
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const result = validateUserForm(values);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    create.mutate(result.payload, {
      onSuccess: () => {
        setValues(EMPTY_USER_FORM);
        setCreated(true);
        // React Query keeps the mutation variables (the password) until reset.
        create.reset();
      },
    });
  };

  const onToggleActive = (user: AdminUser, confirmed: boolean) => {
    if (confirmed) setActive.mutate({ userId: user.id, active: !user.isActive });
  };

  return {
    loading: users.isPending,
    listError: users.error ? adminErrorKey(users.error) : null,
    items: users.data?.items ?? [],
    values,
    errors,
    pending: create.isPending,
    created,
    submitError: create.error ? adminErrorKey(create.error) : null,
    toggling: setActive.isPending,
    toggleError: setActive.error ? adminErrorKey(setActive.error) : null,
    onChange,
    onSubmit,
    onToggleActive,
  };
}

export type UsersAdminModel = ReturnType<typeof useUsersAdmin>;
