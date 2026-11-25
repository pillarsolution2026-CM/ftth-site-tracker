import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ElementKey } from '@ftth/shared';
import { getElementGroups, replaceElementGroups } from './element-groups-api';

export const elementGroupsKey = ['element-groups'] as const;

export function useElementGroupsQuery(enabled = true) {
  return useQuery({
    queryKey: elementGroupsKey,
    queryFn: getElementGroups,
    enabled,
    retry: false,
  });
}

export function useReplaceElementGroups() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { element: ElementKey; mains: string[]; expectedVersion: number }) =>
      replaceElementGroups(input.element, {
        mains: input.mains,
        expectedVersion: input.expectedVersion,
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: elementGroupsKey }),
  });
}
