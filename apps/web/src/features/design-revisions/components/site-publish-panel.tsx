'use client';

import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import { useSitePublish } from '../hooks/use-site-publish';
import { PublishChecklist } from './publish-checklist';

/** The checklist and the single «نشر الموقع» button of one site, under its drawings. */
export function SitePublishPanel({
  projectId,
  siteId,
  revisionsPath,
}: {
  projectId: string;
  siteId: string;
  /** `/…/design-revisions`: where a draft of the site opens. */
  revisionsPath: string;
}) {
  const { t } = useI18n();
  const state = useSitePublish(projectId, siteId, true);
  return (
    <div className="mt-3 flex flex-col gap-3">
      {state.message ? (
        <Notice kind="error">{t(state.message.key, state.message.params)}</Notice>
      ) : null}
      <PublishChecklist
        readiness={state.readiness}
        loading={state.loading}
        failed={state.failed}
        acknowledged={state.acknowledged}
        publishing={state.publishing}
        allowed={state.allowed}
        mappingHref={null}
        revisionHref={(id) => `${revisionsPath}/${id}`}
        onAcknowledgedChange={state.setAcknowledged}
        onPublish={state.publish}
      />
    </div>
  );
}
