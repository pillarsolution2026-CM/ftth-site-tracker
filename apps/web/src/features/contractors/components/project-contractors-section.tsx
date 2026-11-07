'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { errorCodeOf } from '@/shared/api/bff-client';
import { Button } from '@/shared/ui/button';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import { useAdminProjectContractors, useContractors } from '../api/queries';
import { useLineActions } from '../hooks/use-line-actions';
import { useRegisterContractorForm } from '../hooks/use-register-contractor';
import { translateMsg } from '../model/contractor-errors';
import { RegisterContractorForm } from './register-contractor-form';
import { RegistrationCard } from './registration-card';

const LINK =
  'inline-flex min-h-11 items-center text-(--color-brand) underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)';
const NO_AVAILABILITY: never[] = [];

/** Admin: the subcontractors of the project's work order, with every write action. */
export function ProjectContractorsSection({ projectId }: { projectId: string }) {
  const { t, locale } = useI18n();
  const query = useAdminProjectContractors(projectId);
  const contractors = useContractors();
  const availability = query.data?.availability ?? NO_AVAILABILITY;
  const register = useRegisterContractorForm(projectId, availability);
  const actions = useLineActions(projectId, availability);
  const registeredIds = useMemo(
    () => new Set(query.data?.registrations.map((entry) => entry.contractor.id)),
    [query.data],
  );
  const data = query.data;

  return (
    <section aria-labelledby="project-contractors-title" className="flex flex-col gap-4">
      <h2 id="project-contractors-title" className="text-lg font-semibold">
        {t('contractors.section.title')}
      </h2>
      {query.error ? (
        <ErrorNotice code={errorCodeOf(query.error)} />
      ) : !data ? (
        <p role="status">{t('common.loading')}</p>
      ) : data.workOrderId === null ? (
        <Notice kind="info">
          <p>{t('contractors.section.noWorkOrder')}</p>
          <Link className={LINK} href={`/${locale}/projects/${projectId}/work-orders`}>
            {t('contractors.section.goToWorkOrders')}
          </Link>
        </Notice>
      ) : (
        <>
          {register.open ? (
            <RegisterContractorForm
              model={register}
              contractors={contractors.data?.items ?? []}
              registeredIds={registeredIds}
              availability={availability}
            />
          ) : (
            <div>
              <Button onClick={register.onOpen}>{t('contractors.section.register')}</Button>
            </div>
          )}
          {actions.actionError && actions.editor === null ? (
            <Notice kind="error">{translateMsg(t, locale, actions.actionError)}</Notice>
          ) : null}
          {data.registrations.length === 0 ? (
            <p>{t('contractors.section.none')}</p>
          ) : (
            data.registrations.map((registration) => (
              <RegistrationCard
                key={registration.id}
                registration={registration}
                currency={data.currency}
                actions={actions}
              />
            ))
          )}
        </>
      )}
    </section>
  );
}
