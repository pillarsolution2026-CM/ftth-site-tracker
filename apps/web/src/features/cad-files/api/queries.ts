import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CadFileStatus } from '@ftth/shared';
import {
  getCadFile,
  getCadLog,
  listCadCurves,
  listCadFiles,
  listCadInserts,
  listCadLayers,
  listCadTexts,
  reprocessCadFile,
  uploadCadFile,
} from './cad-api';
import { CAD_POLL_MS, isInFlight } from '../model/cad-status';

export const cadFilesKey = (projectId: string) => ['cad-files', projectId] as const;
export const cadFileKey = (projectId: string, id: string) => ['cad-file', projectId, id] as const;

const noRetry = { retry: false } as const;

/** Polls every 3 s while any file is waiting for or in the worker. */
export function useCadFiles(projectId: string, enabled = true) {
  return useQuery({
    ...noRetry,
    enabled,
    queryKey: cadFilesKey(projectId),
    queryFn: () => listCadFiles(projectId),
    refetchInterval: (query) =>
      query.state.data?.items.some((file) => isInFlight(file.status)) ? CAD_POLL_MS : false,
  });
}

export function useCadFile(projectId: string, id: string, enabled = true) {
  return useQuery({
    ...noRetry,
    enabled,
    queryKey: cadFileKey(projectId, id),
    queryFn: () => getCadFile(projectId, id),
    refetchInterval: (query) => {
      const status: CadFileStatus | undefined = query.state.data?.status;
      return status && isInFlight(status) ? CAD_POLL_MS : false;
    },
  });
}

export function useCadLog(projectId: string, id: string, enabled: boolean) {
  return useQuery({
    ...noRetry,
    enabled,
    queryKey: [...cadFileKey(projectId, id), 'log'],
    queryFn: () => getCadLog(projectId, id),
  });
}

export function useCadLayers(projectId: string, id: string, enabled: boolean) {
  return useQuery({
    ...noRetry,
    enabled,
    queryKey: [...cadFileKey(projectId, id), 'layers'],
    queryFn: () => listCadLayers(projectId, id),
  });
}

export function useCadInserts(
  projectId: string,
  id: string,
  query: Parameters<typeof listCadInserts>[2],
  enabled: boolean,
) {
  return useQuery({
    ...noRetry,
    enabled,
    queryKey: [...cadFileKey(projectId, id), 'inserts', query],
    queryFn: () => listCadInserts(projectId, id, query),
    placeholderData: keepPreviousData,
  });
}

export function useCadTexts(
  projectId: string,
  id: string,
  query: Parameters<typeof listCadTexts>[2],
  enabled: boolean,
) {
  return useQuery({
    ...noRetry,
    enabled,
    queryKey: [...cadFileKey(projectId, id), 'texts', query],
    queryFn: () => listCadTexts(projectId, id, query),
    placeholderData: keepPreviousData,
  });
}

export function useCadCurves(
  projectId: string,
  id: string,
  query: Parameters<typeof listCadCurves>[2],
  enabled: boolean,
) {
  return useQuery({
    ...noRetry,
    enabled,
    queryKey: [...cadFileKey(projectId, id), 'curves', query],
    queryFn: () => listCadCurves(projectId, id, query),
    placeholderData: keepPreviousData,
  });
}

export function useUploadCadFile(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { file: File; onProgress?: (fraction: number) => void }) =>
      uploadCadFile(projectId, input.file, {
        ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: cadFilesKey(projectId) }),
  });
}

export function useReprocessCadFile(projectId: string, id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => reprocessCadFile(projectId, id),
    onSuccess: async () => {
      // Drop cached extraction pages: the worker replaces all rows.
      await client.invalidateQueries({ queryKey: cadFileKey(projectId, id) });
      await client.invalidateQueries({ queryKey: cadFilesKey(projectId) });
    },
  });
}
