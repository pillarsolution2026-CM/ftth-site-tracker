'use client';

import type { ReactNode } from 'react';
import type { CadFileSummary, SiteDrawingsResponse } from '@ftth/shared';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { PageHeader } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { errorCodeOf, type ClientErrorCode } from '@/shared/api/bff-client';
import { useProject } from '@/features/projects/hooks/project-access-context';
import { SitePublishPanel } from '@/features/design-revisions/components/site-publish-panel';
import { useWorkOrders } from '@/features/work-orders/api/queries';
import { useCadFiles, useSiteDrawings } from '../api/queries';
import { useCadUpload } from '../hooks/use-cad-upload';
import { useSiteDrawingActions, type SiteDrawingActions } from '../hooks/use-site-drawing-actions';
import { SiteDrawingsView } from './site-drawings-view';
import { CadUploadView, type CadUploadViewProps } from './upload-view';

export { CadUploadView, type CadUploadViewProps };

interface CadFileListViewProps {
  basePath: string;
  revisionsPath: string;
  files: CadFileSummary[] | null;
  data: SiteDrawingsResponse | null;
  errorCode: ClientErrorCode | null;
  /** May upload (cad_files:write). */
  canWrite: boolean;
  /** May link, withdraw and publish (design:write). */
  canManage: boolean;
  upload: CadUploadViewProps;
  actions: SiteDrawingActions;
  renderPublish: (siteId: string) => ReactNode;
}

export function CadFileListView({
  basePath,
  revisionsPath,
  files,
  data,
  errorCode,
  canWrite,
  canManage,
  upload,
  actions,
  renderPublish,
}: CadFileListViewProps) {
  const { t } = useI18n();
  return (
    <div>
      <PageHeader>
        <h1 className="text-xl font-semibold">{t('cad.listTitle')}</h1>
      </PageHeader>
      {canWrite ? <CadUploadView {...upload} /> : null}
      {errorCode ? <ErrorNotice code={errorCode} /> : null}
      {!errorCode && data === null ? <p role="status">{t('common.loading')}</p> : null}
      {data ? (
        <SiteDrawingsView
          data={data}
          files={files ?? []}
          cadFilesPath={basePath}
          revisionsPath={revisionsPath}
          canManage={canManage}
          actions={actions}
          renderPublish={renderPublish}
        />
      ) : null}
    </div>
  );
}

export function CadFileList({ projectId }: { projectId: string }) {
  const { locale } = useI18n();
  const { can } = useProject();
  const canRead = can('cad_files:read');
  const files = useCadFiles(projectId, canRead);
  const drawings = useSiteDrawings(projectId, canRead);
  const workOrders = useWorkOrders(projectId, can('work_orders:read'));
  const upload = useCadUpload(projectId, drawings.data);
  const actions = useSiteDrawingActions(projectId);
  const projectPath = `/${locale}/projects/${projectId}`;
  const orders = workOrders.data?.items ?? [];
  // One work order: link straight to its «المواقع» section; otherwise to the list.
  const workOrderHref =
    orders.length === 1 && orders[0]
      ? `${projectPath}/work-orders/${orders[0].id}#sites-title`
      : `${projectPath}/work-orders`;
  const error = !canRead ? 'FORBIDDEN' : drawings.error ? errorCodeOf(drawings.error) : null;
  return (
    <CadFileListView
      basePath={`${projectPath}/cad-files`}
      revisionsPath={`${projectPath}/design-revisions`}
      files={canRead ? (files.data?.items ?? null) : []}
      data={canRead ? (drawings.data ?? null) : { sites: [], unassigned: [] }}
      errorCode={error}
      canWrite={can('cad_files:write')}
      canManage={can('design:write')}
      upload={{ ...upload, workOrderHref }}
      actions={actions}
      renderPublish={(siteId) => (
        <SitePublishPanel
          projectId={projectId}
          siteId={siteId}
          revisionsPath={`${projectPath}/design-revisions`}
        />
      )}
    />
  );
}
