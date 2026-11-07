'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { ContractorImportTarget, ProjectContractorsResponse } from '@ftth/shared';
import { errorCodeOf } from '@/shared/api/bff-client';
import { Card } from '@/shared/ui/card';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { Select } from '@/shared/ui/form-controls';
import { Input } from '@/shared/ui/input';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import { ImportWizardView } from '@/features/work-order-import/components/import-wizard';
import { useImportWizard } from '@/features/work-order-import/hooks/use-import-wizard';
import { useAdminProjectContractors, useContractors } from '../api/queries';
import { translateMsg } from '../model/contractor-errors';
import { validateNewTarget, type NewTargetValues } from '../model/contractor-forms';

const LINK =
  'inline-flex min-h-11 items-center text-(--color-brand) underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)';

function Wizard({
  projectId,
  target,
  title,
  before,
}: {
  projectId: string;
  target: ContractorImportTarget;
  title: string;
  before: React.ReactNode;
}) {
  const wizard = useImportWizard({ kind: 'contractor', projectId, target });
  return <ImportWizardView wizard={wizard} contractor={{ title, before }} />;
}

interface ContractorImportProps {
  projectId: string;
  /** Present: append lines to this registration. Absent: register a contractor from the list. */
  registrationId?: string | undefined;
}

function Loaded({
  projectId,
  data,
  registrationId,
}: ContractorImportProps & { data: ProjectContractorsResponse }) {
  const { t, locale } = useI18n();
  const contractors = useContractors();
  const [values, setValues] = useState<NewTargetValues>({ contractorId: '', registeredOn: '' });
  const registration = registrationId
    ? data.registrations.find((entry) => entry.id === registrationId)
    : undefined;
  const registeredIds = useMemo(
    () => new Set(data.registrations.map((entry) => entry.contractor.id)),
    [data.registrations],
  );

  if (registrationId && !registration) return <ErrorNotice code="NOT_FOUND" />;

  const checked = registration ? null : validateNewTarget(values);
  const target: ContractorImportTarget | null = registration
    ? { kind: 'append', registrationId: registration.id }
    : checked?.ok
      ? checked.target
      : null;
  const title = registration
    ? t('contractors.import.titleAppend', { name: registration.contractor.name })
    : t('contractors.import.title');

  const targetCard = (
    <Card className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">{t('contractors.import.targetTitle')}</h2>
      <p>{t('contractors.import.explain')}</p>
      {registration ? (
        <p>
          <span className="font-semibold">{registration.contractor.name}</span>
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Select
              id="import-contractor"
              label={t('contractors.register.contractor')}
              value={values.contractorId}
              required
              onChange={(event) => setValues({ ...values, contractorId: event.target.value })}
            >
              <option value="">{t('contractors.register.chooseContractor')}</option>
              {(contractors.data?.items ?? []).map((contractor) => {
                const taken = registeredIds.has(contractor.id);
                return (
                  <option key={contractor.id} value={contractor.id} disabled={taken}>
                    {contractor.name}
                    {taken ? ` (${t('contractors.register.alreadyRegistered')})` : ''}
                  </option>
                );
              })}
            </Select>
            <Link className={LINK} href={`/${locale}/admin/contractors`}>
              {t('contractors.register.createContractor')}
            </Link>
          </div>
          <Input
            id="import-registered-on"
            type="date"
            dir="ltr"
            label={t('contractors.register.date')}
            value={values.registeredOn}
            required
            onChange={(event) => setValues({ ...values, registeredOn: event.target.value })}
          />
        </div>
      )}
      {checked && !checked.ok ? (
        <Notice kind="info" live={false}>
          {t('contractors.validation.chooseTarget')}
          {' — '}
          {[checked.errors.contractorId, checked.errors.registeredOn]
            .filter((message) => message !== undefined)
            .map((message) => translateMsg(t, locale, message))
            .join(' · ')}
        </Notice>
      ) : null}
    </Card>
  );

  return (
    <div className="flex max-w-6xl flex-col gap-4">
      <Link className={LINK} href={`/${locale}/admin/projects/${projectId}`}>
        {t('contractors.import.back')}
      </Link>
      {target ? (
        <Wizard
          // A new target starts a new upload: the preview depends on it.
          key={JSON.stringify(target)}
          projectId={projectId}
          target={target}
          title={title}
          before={targetCard}
        />
      ) : (
        <>
          <h1 className="text-xl font-semibold">{title}</h1>
          {targetCard}
        </>
      )}
    </div>
  );
}

/** Admin: upload the sheet of a subcontractor's lines (new registration, or lines appended). */
export function ContractorImport({ projectId, registrationId }: ContractorImportProps) {
  const { t } = useI18n();
  const query = useAdminProjectContractors(projectId);
  if (query.error) return <ErrorNotice code={errorCodeOf(query.error)} />;
  if (!query.data) return <p role="status">{t('common.loading')}</p>;
  if (query.data.workOrderId === null) {
    return <Notice kind="info">{t('contractors.section.noWorkOrder')}</Notice>;
  }
  return <Loaded projectId={projectId} registrationId={registrationId} data={query.data} />;
}
