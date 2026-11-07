'use client';

import Link from 'next/link';
import { errorCodeOf } from '@/shared/api/bff-client';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import { useAdminProjectContractors } from '../api/queries';
import { useLineActions } from '../hooks/use-line-actions';
import { translateMsg } from '../model/contractor-errors';
import { RegistrationCard } from './registration-card';

const LINK =
  'inline-flex min-h-11 items-center text-(--color-brand) underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)';
const BUTTON_LINK =
  'inline-flex min-h-11 items-center rounded-md border border-transparent bg-(--color-brand) px-4 font-semibold text-(--color-brandContrast) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)';
const NO_AVAILABILITY: never[] = [];

/**
 * Admin: the subcontractors of the project's work order. Their lines come only from uploaded
 * sheets (ADR-036); here the admin edits a quantity, adds a dated price or removes things.
 */
export function ProjectContractorsSection({ projectId }: { projectId: string }) {
  const { t, locale } = useI18n();
  const query = useAdminProjectContractors(projectId);
  const availability = query.data?.availability ?? NO_AVAILABILITY;
  const actions = useLineActions(projectId, availability);
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
          <div>
            <Link
              className={BUTTON_LINK}
              href={`/${locale}/admin/projects/${projectId}/contractors/import`}
            >
              {t('contractors.section.register')}
            </Link>
          </div>
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
                availability={availability}
              />
            ))
          )}
        </>
      )}
    </section>
  );
}
