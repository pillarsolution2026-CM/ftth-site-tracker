import {
  CadMappingSchema,
  CadMappingViewSchema,
  type CadMapping,
  type CadMappingInput,
  type CadMappingView,
} from '@ftth/shared';
import { bffJson, projectApiPath } from '@/shared/api/bff-client';

const mappingPath = (projectId: string, cadFileId: string) =>
  projectApiPath(projectId, `/cad-files/${encodeURIComponent(cadFileId)}/mapping`);

export function getMapping(projectId: string, cadFileId: string): Promise<CadMappingView> {
  return bffJson(mappingPath(projectId, cadFileId), CadMappingViewSchema);
}

export function saveMapping(
  projectId: string,
  cadFileId: string,
  input: CadMappingInput,
): Promise<CadMapping> {
  return bffJson(mappingPath(projectId, cadFileId), CadMappingSchema, {
    method: 'PUT',
    body: input,
  });
}
