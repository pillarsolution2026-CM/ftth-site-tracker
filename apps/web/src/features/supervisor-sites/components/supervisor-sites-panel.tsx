'use client';

import { Button } from '@/shared/ui/button';
import { Card } from '@/shared/ui/card';
import { Checkbox } from '@/shared/ui/form-controls';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import {
  useSupervisorSitesPanel,
  type SupervisorSitesPanelModel,
} from '../hooks/use-supervisor-sites-panel';

function SupervisorCard({ model, userId }: { model: SupervisorSitesPanelModel; userId: string }) {
  const { t } = useI18n();
  const supervisor = model.supervisors.find((s) => s.userId === userId);
  if (!supervisor) return null;
  const selected = model.selectedOf(userId);
  const status = model.statusOf(userId);
  const dirty = model.isDirty(userId);
  return (
    <Card>
      <form
        aria-label={supervisor.displayName}
        onSubmit={(event) => {
          event.preventDefault();
          void model.save(userId);
        }}
      >
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h3 className="font-semibold">{supervisor.displayName}</h3>
            <Ltr className="text-sm opacity-80">{supervisor.email}</Ltr>
            {supervisor.isActive ? null : (
              <div className="text-sm">
                <span aria-hidden="true">⊘ </span>
                {t('admin.users.inactive')}
              </div>
            )}
          </div>
          <span className="text-sm opacity-80">
            {t('supervisorSites.count', { count: String(selected.length) })}
          </span>
        </div>
        {model.groups.map((group) => (
          <fieldset key={group.workOrderId} className="mb-3">
            <legend className="mb-1 text-sm font-semibold">
              {t('supervisorSites.workOrder')} <Ltr>{group.workOrderNumber}</Ltr>
            </legend>
            <div className="flex flex-wrap gap-x-6">
              {group.sites.map((site) => (
                <Checkbox
                  key={site.siteId}
                  id={`ss-${userId}-${site.siteId}`}
                  label={site.name}
                  checked={selected.includes(site.siteId)}
                  onChange={() => model.toggle(userId, site.siteId)}
                />
              ))}
            </div>
          </fieldset>
        ))}
        {status?.kind === 'error' ? <Notice kind="error">{t(status.message)}</Notice> : null}
        {status?.kind === 'saved' ? (
          <Notice kind="success">{t('supervisorSites.saved')}</Notice>
        ) : null}
        <div className="mt-2">
          <Button type="submit" disabled={!dirty || model.isSaving(userId)}>
            {model.isSaving(userId) ? t('common.saving') : t('supervisorSites.save')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** Presentational: supervisors of the project x its sites (grouped by work order). */
export function SupervisorSitesView({ model }: { model: SupervisorSitesPanelModel }) {
  const { t } = useI18n();
  return (
    <section aria-labelledby="supervisor-sites-title" className="flex flex-col gap-4">
      <h2 id="supervisor-sites-title" className="text-lg font-semibold">
        {t('supervisorSites.title')}
      </h2>
      {model.loadError ? (
        <ErrorNotice code={model.loadError} />
      ) : model.loading ? (
        <p role="status">{t('common.loading')}</p>
      ) : model.supervisors.length === 0 ? (
        <p>{t('supervisorSites.noSupervisors')}</p>
      ) : model.siteCount === 0 ? (
        <p>{t('supervisorSites.noSites')}</p>
      ) : (
        model.supervisors.map((s) => (
          <SupervisorCard key={s.userId} model={model} userId={s.userId} />
        ))
      )}
      <Notice kind="info" live={false}>
        {t('supervisorSites.note')}
      </Notice>
    </section>
  );
}

export function SupervisorSitesPanel({ projectId }: { projectId: string }) {
  return <SupervisorSitesView model={useSupervisorSitesPanel(projectId)} />;
}
