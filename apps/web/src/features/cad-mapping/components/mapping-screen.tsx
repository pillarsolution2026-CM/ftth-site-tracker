'use client';

import Link from 'next/link';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { PageHeader } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { useCadFile } from '@/features/cad-files/api/queries';
import { Notice } from '@/shared/ui/notice';
import { usePlacementDrawing } from '../api/queries';
import { gpsProposalPhotoUrl } from '../api/proposals-api';
import { useGpsProposalsPanel } from '../hooks/use-gps-proposals';
import { useMappingScreen } from '../hooks/use-mapping-screen';
import { GpsProposalsPanel } from './gps-proposals-panel';
import { MappingEditor } from './mapping-editor';

export function MappingScreen({
  projectId,
  cadFileId,
  filePath,
}: {
  projectId: string;
  cadFileId: string;
  filePath: string;
}) {
  const { t } = useI18n();
  const screen = useMappingScreen(projectId, cadFileId);
  const drawing = usePlacementDrawing(
    projectId,
    cadFileId,
    screen.canRead && screen.view?.fileStatus === 'processed',
  );

  const cadFile = useCadFile(projectId, cadFileId, screen.canRead);
  const superseded = cadFile.data?.supersededAt != null;

  const proposals = useGpsProposalsPanel({
    projectId,
    cadFileId,
    enabled: screen.canWrite && screen.view !== null,
    mappingVersion: screen.view?.mapping?.version ?? null,
    onReload: screen.reload,
  });

  return (
    <div>
      <PageHeader>
        <h1 className="text-xl font-semibold">{t('mapping.title')}</h1>
        <Link
          href={filePath}
          className="inline-flex min-h-11 items-center text-(--color-brand) underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)"
        >
          {t('mapping.backToFile')}
        </Link>
      </PageHeader>
      {!screen.canRead ? (
        <ErrorNotice code="FORBIDDEN" />
      ) : screen.loadErrorCode ? (
        <ErrorNotice code={screen.loadErrorCode} />
      ) : !screen.view ? (
        <p role="status">{t('common.loading')}</p>
      ) : (
        <>
          {superseded ? (
            <Notice kind="info" className="mb-4">
              {t('mapping.supersededNotice')}
            </Notice>
          ) : null}
          {screen.canWrite ? (
            <div className="mb-6">
              <GpsProposalsPanel
                {...proposals}
                photoUrl={(id) => gpsProposalPhotoUrl(projectId, id)}
                onToggleHistory={proposals.toggleHistory}
                onAccept={(id) => void proposals.accept(id)}
                onReject={proposals.reject}
                onReload={() => void proposals.reload()}
              />
            </div>
          ) : null}
          <MappingEditor
            key={screen.reloadCount}
            view={screen.view}
            drawing={drawing.data ?? null}
            canWrite={screen.canWrite}
            canBuild={screen.canBuild && !superseded}
            saving={screen.saving}
            building={screen.building}
            errorKey={screen.errorKey}
            offerReload={screen.offerReload}
            onSave={screen.save}
            onBuild={(version) => void screen.build(version)}
            onReload={() => void screen.reload()}
          />
        </>
      )}
    </div>
  );
}
