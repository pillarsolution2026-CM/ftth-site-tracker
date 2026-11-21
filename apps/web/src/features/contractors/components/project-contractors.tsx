'use client';

import { ErrorNotice } from '@/shared/ui/error-notice';
import { Notice } from '@/shared/ui/notice';
import { PageHeader } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { errorCodeOf } from '@/shared/api/bff-client';
import { useProject } from '@/features/projects/hooks/project-access-context';
import { useProjectContractors } from '../api/queries';
import { RegistrationCard } from './registration-card';

/** Read-only subcontractors of a project, for the PM (`contractors:read`). */
export function ProjectContractors({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const { can } = useProject();
  const allowed = can('contractors:read');
  const query = useProjectContractors(projectId, allowed);

  if (!allowed) return <ErrorNotice code="FORBIDDEN" />;
  if (query.error) return <ErrorNotice code={errorCodeOf(query.error)} />;
  const data = query.data;
  if (!data) return <p role="status">{t('common.loading')}</p>;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader>
        <h1 className="text-xl font-semibold">{t('contractors.section.title')}</h1>
        <span className="text-sm opacity-80">{t('contractors.section.readOnly')}</span>
      </PageHeader>
      {data.workOrderId === null ? (
        <Notice kind="info">{t('contractors.section.noWorkOrder')}</Notice>
      ) : data.registrations.length === 0 ? (
        <p>{t('contractors.section.none')}</p>
      ) : (
        data.registrations.map((registration) => (
          <RegistrationCard
            key={registration.id}
            registration={registration}
            currency={data.currency}
            availability={data.availability}
          />
        ))
      )}
    </div>
  );
}
