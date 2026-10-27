'use client';

import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/shared/ui/card';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import { errorCodeOf } from '@/shared/api/bff-client';
import { useProject } from '@/features/projects/hooks/project-access-context';
import { useCreateWorkOrder } from '../api/queries';
import { useHeaderForm } from '../hooks/use-header-form';
import { EMPTY_HEADER_FORM, headerPayload } from '../model/header-form';
import { HeaderFormView } from './header-form';

export function CreateWorkOrder({ projectId }: { projectId: string }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { can } = useProject();
  const form = useHeaderForm(EMPTY_HEADER_FORM);
  const create = useCreateWorkOrder(projectId);

  if (!can('work_orders:write')) return <Notice kind="error">{t('errors.FORBIDDEN')}</Notice>;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!form.validate()) return;
    create.mutate(
      { ...headerPayload(form.values), items: [], acceptedDuplicateCodes: [] },
      {
        onSuccess: (created) =>
          router.push(`/${locale}/projects/${projectId}/work-orders/${created.id}`),
      },
    );
  };

  const code = create.error ? errorCodeOf(create.error) : null;
  return (
    <Card className="max-w-2xl">
      <h1 className="mb-4 text-xl font-semibold">{t('workOrders.new')}</h1>
      <HeaderFormView
        idPrefix="wo-create"
        values={form.values}
        errors={
          code === 'CONFLICT' ? { ...form.errors, number: 'workOrders.numberTaken' } : form.errors
        }
        pending={create.isPending}
        submitLabel={t('workOrders.create')}
        errorCode={code === 'CONFLICT' ? null : code}
        conflict={false}
        onChange={form.onChange}
        onSubmit={onSubmit}
      />
    </Card>
  );
}
