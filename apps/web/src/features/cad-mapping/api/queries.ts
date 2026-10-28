import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CadMappingInput } from '@ftth/shared';
import { getMapping, saveMapping } from './mapping-api';

export const mappingKey = (projectId: string, cadFileId: string) =>
  ['cad-mapping', projectId, cadFileId] as const;

export function useMapping(projectId: string, cadFileId: string, enabled = true) {
  return useQuery({
    enabled,
    retry: false,
    queryKey: mappingKey(projectId, cadFileId),
    queryFn: () => getMapping(projectId, cadFileId),
  });
}

export function useSaveMapping(projectId: string, cadFileId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CadMappingInput) => saveMapping(projectId, cadFileId, input),
    onSuccess: () => client.invalidateQueries({ queryKey: mappingKey(projectId, cadFileId) }),
  });
}
