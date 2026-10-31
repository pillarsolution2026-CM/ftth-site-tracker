'use client';

import { Card } from '@/shared/ui/card';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { Notice } from '@/shared/ui/notice';
import { PageHeader } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { errorCodeOf } from '@/shared/api/bff-client';
import { useProject } from '@/features/projects/hooks/project-access-context';
import { useProjectContract } from '../api/queries';
import { BoqTable } from './boq-table';
import { ContractSummaryFields } from './contract-summary';

/**
 * Read-only contract and BOQ of a project, for the PM (`contract:read`). Contract PDFs are not
 * listed: their download is an admin endpoint.
 */
export function ProjectContract({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const { can } = useProject();
  const allowed = can('contract:read');
  const query = useProjectContract(projectId, allowed);

  if (!allowed) return <ErrorNotice code="FORBIDDEN" />;
  if (query.error) {
    return errorCodeOf(query.error) === 'NOT_FOUND' ? (
      <Notice kind="info">{t('contract.noContract')}</Notice>
    ) : (
      <ErrorNotice code={errorCodeOf(query.error)} />
    );
  }
  const contract = query.data;
  if (!contract) return <p role="status">{t('common.loading')}</p>;
  return (
    <div>
      <PageHeader>
        <h1 className="text-xl font-semibold">{t('contract.title')}</h1>
        <span className="text-sm opacity-80">{t('contract.readOnly')}</span>
      </PageHeader>
      <Card>
        <ContractSummaryFields contract={contract} />
      </Card>
      <section aria-labelledby="boq-title" className="mt-8">
        <h2 id="boq-title" className="mb-3 text-lg font-semibold">
          {t('admin.contracts.boq.title')}
        </h2>
        {contract.duplicateCodes.length > 0 ? (
          <Notice kind="warning" className="mb-3">
            <p className="font-semibold">{t('items.duplicatesPresent')}</p>
            <ul className="mt-1 list-disc ps-5">
              {contract.duplicateCodes.map((entry) => (
                <li key={entry.code}>
                  {t('items.duplicateLine', { code: entry.code, lines: entry.lineNos.join(', ') })}
                </li>
              ))}
            </ul>
          </Notice>
        ) : null}
        {contract.items.length === 0 ? (
          <p>{t('admin.contracts.boq.empty')}</p>
        ) : (
          <BoqTable contract={contract} />
        )}
      </section>
    </div>
  );
}
