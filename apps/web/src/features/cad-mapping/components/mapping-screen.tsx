'use client';

import Link from 'next/link';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { PageHeader } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { useMappingScreen } from '../hooks/use-mapping-screen';
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
        <MappingEditor
          key={screen.reloadCount}
          view={screen.view}
          canWrite={screen.canWrite}
          canBuild={screen.canBuild}
          saving={screen.saving}
          building={screen.building}
          errorKey={screen.errorKey}
          offerReload={screen.offerReload}
          onSave={screen.save}
          onBuild={(version) => void screen.build(version)}
          onReload={() => void screen.reload()}
        />
      )}
    </div>
  );
}
