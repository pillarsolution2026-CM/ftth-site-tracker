import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { listUpdates } from './updates-api';
import type { listQuery } from '../model/update-list-model';

export const updatesKey = (projectId: string) => ['execution-updates', projectId] as const;

export function useUpdates(
  projectId: string,
  query: ReturnType<typeof listQuery>,
  enabled: boolean,
) {
  return useQuery({
    retry: false,
    enabled,
    queryKey: [...updatesKey(projectId), query],
    queryFn: () => listUpdates(projectId, query),
    placeholderData: keepPreviousData,
  });
}
