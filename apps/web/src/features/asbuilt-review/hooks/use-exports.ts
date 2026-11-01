'use client';

import { errorCodeOf, errorReasonOf } from '@/shared/api/bff-client';
import { useProject } from '@/features/projects/hooks/project-access-context';
import { asBuiltExportFileUrl } from '../api/asbuilt-api';
import { useAsBuiltExports, useRequestAsBuiltExport } from '../api/queries';
import { exportErrorKey, isExportRunning } from '../model/review-model';

/** Export panel state: the list (polled while running), the request and the file URLs. */
export function useExports(projectId: string) {
  const { can } = useProject();
  const canExport = can('asbuilt:export');
  const query = useAsBuiltExports(projectId, canExport);
  const request = useRequestAsBuiltExport(projectId);
  const items = query.data?.items ?? null;
  const error = request.error ?? query.error;
  return {
    canExport,
    items,
    running: items?.some((item) => isExportRunning(item.status)) ?? false,
    requesting: request.isPending,
    errorKey: error ? exportErrorKey(errorCodeOf(error), errorReasonOf(error)) : null,
    requestExport: () => request.mutate(),
    fileUrl: (id: string) => asBuiltExportFileUrl(projectId, id),
  };
}
