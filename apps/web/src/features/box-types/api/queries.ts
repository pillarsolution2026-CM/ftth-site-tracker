import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { type SetBoxTypesRequest, type WorkOrderItem } from '@ftth/shared';
import { getWorkOrder, listWorkOrders } from '@/features/work-orders/api/work-orders-api';
import { getBoxTypeState, getBoxTypesReport, listAllBoxes, setBoxTypes } from './box-types-api';

const noRetry = { retry: false } as const;

export const boxTypeStateKey = (projectId: string, cadFileId: string) =>
  ['box-type-state', projectId, cadFileId] as const;
export const boxTypesReportKey = (projectId: string, revisionId: string) =>
  ['box-types-report', projectId, revisionId] as const;
const readinessKey = (projectId: string, revisionId: string) =>
  ['design-revision', projectId, revisionId, 'publish-readiness'] as const;

export function useBoxTypeState(projectId: string, cadFileId: string, enabled: boolean) {
  return useQuery({
    ...noRetry,
    enabled,
    queryKey: boxTypeStateKey(projectId, cadFileId),
    queryFn: () => getBoxTypeState(projectId, cadFileId),
  });
}

export function useBoxTypesReport(projectId: string, revisionId: string, enabled: boolean) {
  return useQuery({
    ...noRetry,
    enabled,
    queryKey: boxTypesReportKey(projectId, revisionId),
    queryFn: () => getBoxTypesReport(projectId, revisionId),
  });
}

/** Saving changes the live state, what the revision reports (`changedSinceBuild`) and the checklist. */
export function useSetBoxTypes(projectId: string, cadFileId: string, revisionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: SetBoxTypesRequest) => setBoxTypes(projectId, cadFileId, body),
    onSuccess: (state) => {
      client.setQueryData(boxTypeStateKey(projectId, cadFileId), state);
      return Promise.all([
        client.invalidateQueries({ queryKey: boxTypesReportKey(projectId, revisionId) }),
        client.invalidateQueries({ queryKey: readinessKey(projectId, revisionId) }),
      ]);
    },
  });
}

/**
 * The lines of the project's work order (the type list, owner decision 2026-11-12): the existing
 * work-order read, list then detail. Needs `work_orders:read`.
 */
export function useWorkOrderLines(projectId: string, enabled: boolean) {
  const list = useQuery({
    ...noRetry,
    enabled,
    queryKey: ['work-orders', projectId],
    queryFn: () => listWorkOrders(projectId),
  });
  const details = useQueries({
    queries: (list.data?.items ?? []).map((summary) => ({
      ...noRetry,
      queryKey: ['work-order', projectId, summary.id],
      queryFn: () => getWorkOrder(projectId, summary.id),
    })),
  });
  const lines: WorkOrderItem[] = details.flatMap((query) => query.data?.items ?? []);
  return {
    loading: enabled && (list.isLoading || details.some((query) => query.isLoading)),
    failed: list.isError || details.some((query) => query.isError),
    hasWorkOrder: (list.data?.items.length ?? 0) > 0,
    lines,
  };
}

/** Every box feature of a revision (pages of 500), for the type texts on the drawing. */
export function useAllBoxes(projectId: string, revisionId: string, enabled: boolean) {
  return useQuery({
    ...noRetry,
    enabled,
    queryKey: ['design-revision', projectId, revisionId, 'all-boxes'],
    queryFn: () => listAllBoxes(projectId, revisionId),
  });
}
