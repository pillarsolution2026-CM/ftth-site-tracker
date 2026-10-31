'use client';

import { useMemo, useState, type FormEvent } from 'react';
import type { MessageKey } from '@ftth/i18n';
import type { Assignment, Project } from '@ftth/shared';
import {
  useAdminAssignments,
  useAdminProjects,
  useAdminUsers,
  useAdminZones,
  useCreateAssignment,
  useCreateZone,
  useRemoveAssignment,
  useUpdateProject,
} from '../api/queries';
import { adminErrorKey } from '../model/admin-errors';
import {
  EMPTY_ASSIGNMENT_FORM,
  validateAssignmentForm,
  type AssignmentField,
  type AssignmentFormValues,
  type ProjectField,
  type ProjectFormValues,
} from '../model/admin-forms';

function toForm(project: Project): ProjectFormValues {
  return {
    name: project.name,
    contractId: project.contractId ?? '',
    crsEpsg: String(project.crsEpsg),
    locale: project.locale,
  };
}

/** Edit form for name and locale (the CRS, the contract, the client and the currency are fixed). */
function useEditProject(projectId: string, project: Project | undefined) {
  const update = useUpdateProject(projectId);
  const [edited, setEdited] = useState<ProjectFormValues | null>(null);
  const [errors, setErrors] = useState<Partial<Record<ProjectField, MessageKey>>>({});
  const values = edited ?? (project ? toForm(project) : null);

  const onChange = (field: ProjectField, value: string) => {
    if (!values || field === 'crsEpsg' || field === 'contractId') return;
    setEdited({ ...values, [field]: value });
    setErrors((current) => ({ ...current, [field]: undefined }));
    update.reset();
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!values) return;
    const name = values.name.trim();
    if (!name) {
      setErrors({ name: 'validation.required' });
      return;
    }
    update.mutate(
      { name, locale: values.locale as Project['locale'] },
      { onSuccess: () => setEdited(null) },
    );
  };

  return {
    values,
    errors,
    pending: update.isPending,
    saved: update.isSuccess,
    error: update.error ? adminErrorKey(update.error) : null,
    onChange,
    onSubmit,
  };
}

function useZonesPanel(projectId: string) {
  const zones = useAdminZones(projectId);
  const create = useCreateZone(projectId);
  const [name, setName] = useState('');
  const [error, setError] = useState<MessageKey | null>(null);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError('validation.required');
      return;
    }
    create.mutate({ name: name.trim() }, { onSuccess: () => setName('') });
  };

  return {
    loading: zones.isPending,
    items: zones.data?.items ?? [],
    name,
    error: error ?? (create.error ? adminErrorKey(create.error) : null),
    pending: create.isPending,
    onNameChange: (value: string) => {
      setName(value);
      setError(null);
      create.reset();
    },
    onSubmit,
  };
}

function useAssignmentsPanel(projectId: string) {
  const assignments = useAdminAssignments(projectId);
  const users = useAdminUsers();
  const create = useCreateAssignment(projectId);
  const remove = useRemoveAssignment(projectId);
  const [values, setValues] = useState<AssignmentFormValues>(EMPTY_ASSIGNMENT_FORM);
  const [errors, setErrors] = useState<Partial<Record<AssignmentField, MessageKey>>>({});

  // Admins see every project already; deactivated users cannot be assigned.
  const assignableUsers = useMemo(
    () => (users.data?.items ?? []).filter((user) => !user.isAdmin && user.isActive),
    [users.data],
  );

  const onChange = <K extends AssignmentField>(field: K, value: AssignmentFormValues[K]) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    create.reset();
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const result = validateAssignmentForm(values);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    create.mutate(result.payload, {
      onSuccess: () => setValues({ ...EMPTY_ASSIGNMENT_FORM, role: values.role }),
    });
  };

  const onRemove = (assignment: Assignment, confirmed: boolean) => {
    if (confirmed) remove.mutate(assignment.id);
  };

  return {
    loading: assignments.isPending || users.isPending,
    items: assignments.data?.items ?? [],
    users: assignableUsers,
    values,
    errors,
    pending: create.isPending,
    error:
      (create.error ? adminErrorKey(create.error) : null) ??
      (remove.error ? adminErrorKey(remove.error) : null),
    removing: remove.isPending,
    onChange,
    onSubmit,
    onRemove,
  };
}

export function useProjectAdmin(projectId: string) {
  const projects = useAdminProjects();
  const project = projects.data?.items.find((item) => item.id === projectId);
  return {
    state: projects.isPending
      ? ('loading' as const)
      : projects.error
        ? ('error' as const)
        : project
          ? ('ready' as const)
          : ('notFound' as const),
    loadError: projects.error ? adminErrorKey(projects.error) : null,
    project,
    edit: useEditProject(projectId, project),
    zones: useZonesPanel(projectId),
    assignments: useAssignmentsPanel(projectId),
  };
}

export type ProjectAdminModel = ReturnType<typeof useProjectAdmin>;
