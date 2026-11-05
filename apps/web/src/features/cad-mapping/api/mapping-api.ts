import {
  CadMappingSchema,
  CadMappingViewSchema,
  PlacementDrawingSchema,
  type CadMapping,
  type CadMappingInput,
  type CadMappingView,
  type PlacementDrawing,
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

/** Items and route lines in drawing units for the placement screen (ADR-035). */
export function getPlacementDrawing(
  projectId: string,
  cadFileId: string,
): Promise<PlacementDrawing> {
  return bffJson(`${mappingPath(projectId, cadFileId)}/placement-drawing`, PlacementDrawingSchema);
}
