'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { ContractDetail } from '@ftth/shared';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { Notice } from '@/shared/ui/notice';
import { errorCodeOf } from '@/shared/api/bff-client';
import { useI18n } from '@/shared/i18n/locale-provider';
import { ImportWizardView } from '@/features/work-order-import/components/import-wizard';
import { useImportWizard } from '@/features/work-order-import/hooks/use-import-wizard';
import { useContract } from '../api/queries';

function ContractImportWizard({ contract }: { contract: ContractDetail }) {
  const { t, locale } = useI18n();
  const [confirmed, setConfirmed] = useState(false);
  const wizard = useImportWizard({
    kind: 'contract',
    contractId: contract.id,
    expectedVersion: contract.version,
  });
  return (
    <div className="flex max-w-6xl flex-col gap-4">
      <Link
        href={`/${locale}/admin/contracts/${contract.id}`}
        className="inline-flex min-h-11 items-center text-(--color-brand) underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)"
      >
        {t('admin.contracts.import.cancel')}
      </Link>
      <ImportWizardView
        wizard={wizard}
        contractReplace={{
          existingLines: contract.items.length,
          confirmed,
          onConfirm: setConfirmed,
        }}
      />
    </div>
  );
}

/** Import of the BOQ into a draft contract (replaces all lines); an approved BOQ is locked. */
export function ContractImport({ contractId }: { contractId: string }) {
  const { t } = useI18n();
  const query = useContract(contractId);
  if (query.error) {
    return <ErrorNotice code={errorCodeOf(query.error)} />;
  }
  if (!query.data) return <p role="status">{t('common.loading')}</p>;
  if (query.data.status !== 'draft') {
    return <Notice kind="error">{t('admin.contracts.reasons.CONTRACT_APPROVED')}</Notice>;
  }
  return <ContractImportWizard contract={query.data} />;
}
