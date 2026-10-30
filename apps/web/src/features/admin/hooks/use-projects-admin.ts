'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { MessageKey } from '@ftth/i18n';
import { useI18n } from '@/shared/i18n/locale-provider';
import { useAdminProjects, useCreateProject } from '../api/queries';
import { adminErrorKey } from '../model/admin-errors';
import {
  projectSuggestions,
  validateProjectForm,
  type ProjectField,
  type ProjectFormValues,
} from '../model/admin-forms';

/** Project list + create form. Until the admin types, the form shows the suggested values. */
export function useProjectsAdmin() {
  const { locale } = useI18n();
  const router = useRouter();
  const projects = useAdminProjects();
  const create = useCreateProject();
  const items = useMemo(() => projects.data?.items ?? [], [projects.data]);
  const suggestions = useMemo(() => projectSuggestions(items), [items]);
  const [edited, setEdited] = useState<ProjectFormValues | null>(null);
  const [errors, setErrors] = useState<Partial<Record<ProjectField, MessageKey>>>({});
  const values = edited ?? suggestions.initial;

  const onChange = (field: ProjectField, value: string) => {
    setEdited({ ...values, [field]: value });
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const result = validateProjectForm(values);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    create.mutate(result.payload, {
      onSuccess: (created) => router.push(`/${locale}/admin/projects/${created.id}`),
    });
  };

  return {
    loading: projects.isPending,
    listError: projects.error ? adminErrorKey(projects.error) : null,
    items,
    suggestions,
    values,
    errors,
    pending: create.isPending,
    submitError: create.error ? adminErrorKey(create.error) : null,
    onChange,
    onSubmit,
  };
}
