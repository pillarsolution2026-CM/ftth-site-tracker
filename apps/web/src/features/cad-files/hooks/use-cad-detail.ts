'use client';

import { useState } from 'react';
import { errorCodeOf } from '@/shared/api/bff-client';
import { useProject } from '@/features/projects/hooks/project-access-context';
import { useCadFile, useCadLayers, useCadLog, useReprocessCadFile } from '../api/queries';
import { cadContentUrl } from '../api/cad-api';

export const CAD_TABS = ['overview', 'layers', 'inserts', 'texts', 'curves', 'log'] as const;
export type CadTab = (typeof CAD_TABS)[number];

/** Detail screen state: file (polled while in flight), active tab, layers, log, reprocess. */
export function useCadDetail(projectId: string, cadFileId: string) {
  const { can } = useProject();
  const canRead = can('cad_files:read');
  const file = useCadFile(projectId, cadFileId, canRead);
  const [tab, setTab] = useState<CadTab>('overview');
  const processed = file.data?.status === 'processed';
  const layers = useCadLayers(projectId, cadFileId, canRead && processed);
  const log = useCadLog(projectId, cadFileId, canRead && tab === 'log');
  const reprocess = useReprocessCadFile(projectId, cadFileId);

  return {
    canRead,
    canWrite: can('cad_files:write'),
    file: file.data ?? null,
    loadErrorCode: file.error ? errorCodeOf(file.error) : null,
    processed,
    tab,
    setTab,
    layers: layers.data?.items ?? null,
    layersErrorCode: layers.error ? errorCodeOf(layers.error) : null,
    log,
    reprocess: () => reprocess.mutate(),
    reprocessing: reprocess.isPending,
    reprocessErrorCode: reprocess.error ? errorCodeOf(reprocess.error) : null,
    downloadUrl: cadContentUrl(projectId, cadFileId),
  };
}
