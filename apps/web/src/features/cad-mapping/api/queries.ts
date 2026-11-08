import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CadMappingInput } from '@ftth/shared';
import { getMapping, getPlacementDrawing, saveMapping } from './mapping-api';
import { acceptGpsProposal, listGpsProposals, rejectGpsProposal } from './proposals-api';

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

/**
 * Saving a mapping makes a new version, and the placement items are classified by the saved rules
 * (ADR-037): the placement drawing key extends `mappingKey`, so this refetches it too.
 */
export function useSaveMapping(projectId: string, cadFileId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CadMappingInput) => saveMapping(projectId, cadFileId, input),
    onSuccess: () => client.invalidateQueries({ queryKey: mappingKey(projectId, cadFileId) }),
  });
}

export function usePlacementDrawing(projectId: string, cadFileId: string, enabled = true) {
  return useQuery({
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
    queryKey: [...mappingKey(projectId, cadFileId), 'placement-drawing'] as const,
    queryFn: () => getPlacementDrawing(projectId, cadFileId),
  });
}

export const gpsProposalsKey = (projectId: string, cadFileId: string) =>
  ['gps-proposals', projectId, cadFileId] as const;

/** `pending`, or the decided ones (history); both for this CAD file only. */
export function useGpsProposals(
  projectId: string,
  cadFileId: string,
  view: 'pending' | 'history',
  enabled = true,
) {
  return useQuery({
    enabled,
    retry: false,
    queryKey: [...gpsProposalsKey(projectId, cadFileId), view] as const,
    queryFn: async () => {
      if (view === 'pending') {
        return (await listGpsProposals(projectId, { cadFileId, status: 'pending' })).items;
      }
      const all = (await listGpsProposals(projectId, { cadFileId })).items;
      return all
        .filter((proposal) => proposal.status !== 'pending')
        .sort((a, b) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? ''));
    },
  });
}

/** Accepting adds a control point to the mapping: the mapping and placement items go stale too. */
export function useDecideGpsProposal(projectId: string, cadFileId: string) {
  const client = useQueryClient();
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: gpsProposalsKey(projectId, cadFileId) }),
      client.invalidateQueries({ queryKey: mappingKey(projectId, cadFileId) }),
    ]);
  const accept = useMutation({
    mutationFn: (input: { id: string; mappingVersion: number }) =>
      acceptGpsProposal(projectId, input.id, input.mappingVersion),
    onSettled: refresh,
  });
  const reject = useMutation({
    mutationFn: (input: { id: string; reason: string }) =>
      rejectGpsProposal(projectId, input.id, input.reason),
    onSettled: refresh,
  });
  return { accept, reject };
}
