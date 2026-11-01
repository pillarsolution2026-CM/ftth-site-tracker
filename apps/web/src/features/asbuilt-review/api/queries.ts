import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RejectAsBuiltEditRequest } from '@ftth/shared';
import {
  approveAsBuiltEdit,
  getAsBuiltEdit,
  listAsBuiltEdits,
  listAsBuiltExports,
  rejectAsBuiltEdit,
  requestAsBuiltExport,
} from './asbuilt-api';
import { EXPORT_POLL_MS, isExportRunning, type EditListParams } from '../model/review-model';

/** Everything As-Built of one project lives under this prefix, so one invalidation refreshes it. */
export const asBuiltKey = (projectId: string) => ['asbuilt', projectId] as const;
const exportsKey = (projectId: string) => [...asBuiltKey(projectId), 'exports'] as const;

const noRetry = { retry: false } as const;

export function useAsBuiltEdits(projectId: string, query: EditListParams, enabled: boolean) {
  return useQuery({
    ...noRetry,
    enabled,
    queryKey: [...asBuiltKey(projectId), 'edits', query],
    queryFn: () => listAsBuiltEdits(projectId, query),
    placeholderData: keepPreviousData,
  });
}

export function useAsBuiltEdit(projectId: string, editId: string, enabled: boolean) {
  return useQuery({
    ...noRetry,
    enabled,
    queryKey: [...asBuiltKey(projectId), 'edit', editId],
    queryFn: () => getAsBuiltEdit(projectId, editId),
  });
}

/** After any review attempt (also a refused one) the list and the detail must be re-read. */
function useRefreshAsBuilt(projectId: string) {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: asBuiltKey(projectId) });
}

export function useApproveAsBuiltEdit(projectId: string, editId: string) {
  const refresh = useRefreshAsBuilt(projectId);
  return useMutation({
    mutationFn: () => approveAsBuiltEdit(projectId, editId),
    onSettled: refresh,
  });
}

export function useRejectAsBuiltEdit(projectId: string, editId: string) {
  const refresh = useRefreshAsBuilt(projectId);
  return useMutation({
    mutationFn: (body: RejectAsBuiltEditRequest) => rejectAsBuiltEdit(projectId, editId, body),
    onSettled: refresh,
  });
}

/** Polls every 3 s while any export is queued or processing. */
export function useAsBuiltExports(projectId: string, enabled: boolean) {
  return useQuery({
    ...noRetry,
    enabled,
    queryKey: exportsKey(projectId),
    queryFn: () => listAsBuiltExports(projectId),
    refetchInterval: (query) =>
      query.state.data?.items.some((item) => isExportRunning(item.status)) ? EXPORT_POLL_MS : false,
  });
}

export function useRequestAsBuiltExport(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => requestAsBuiltExport(projectId),
    onSuccess: () => client.invalidateQueries({ queryKey: exportsKey(projectId) }),
  });
}
