import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getSupervisorSites, replaceSupervisorSites } from './supervisor-sites-api';

export const supervisorSitesKey = (projectId: string) => ['supervisor-sites', projectId] as const;

export function useSupervisorSites(projectId: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: supervisorSitesKey(projectId),
    queryFn: () => getSupervisorSites(projectId),
    retry: false,
  });
}

export function useReplaceSupervisorSites(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, siteIds }: { userId: string; siteIds: string[] }) =>
      replaceSupervisorSites(projectId, userId, { siteIds }),
    onSuccess: () => client.invalidateQueries({ queryKey: supervisorSitesKey(projectId) }),
  });
}
