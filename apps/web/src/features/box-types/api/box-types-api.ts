import {
  BoxTypeStateSchema,
  DesignFeaturePageSchema,
  type DesignFeature,
  BoxTypesReportSchema,
  type BoxTypeState,
  type BoxTypesReport,
  type SetBoxTypesRequest,
} from '@ftth/shared';
import { bffJson, projectApiPath } from '@/shared/api/bff-client';

const filePath = (projectId: string, cadFileId: string) =>
  projectApiPath(projectId, `/cad-files/${encodeURIComponent(cadFileId)}/box-types`);

/** The live choices of a Secondary CAD file (ADR-043): what the next build freezes. */
export function getBoxTypeState(projectId: string, cadFileId: string): Promise<BoxTypeState> {
  return bffJson(filePath(projectId, cadFileId), BoxTypeStateSchema);
}

/** One or many choices in one transaction; a null line clears the shape. */
export function setBoxTypes(
  projectId: string,
  cadFileId: string,
  body: SetBoxTypesRequest,
): Promise<BoxTypeState> {
  return bffJson(filePath(projectId, cadFileId), BoxTypeStateSchema, { method: 'POST', body });
}

/** The gallery, the frozen choices and the check of one revision. */
export function getBoxTypesReport(projectId: string, revisionId: string): Promise<BoxTypesReport> {
  return bffJson(
    projectApiPath(projectId, `/design-revisions/${encodeURIComponent(revisionId)}/box-types`),
    BoxTypesReportSchema,
  );
}

const MAX_BOX_PAGES = 10;

/** Every box feature of a revision (pages of 500), for the type texts on the drawing. */
export async function listAllBoxes(
  projectId: string,
  revisionId: string,
): Promise<DesignFeature[]> {
  const base = projectApiPath(
    projectId,
    `/design-revisions/${encodeURIComponent(revisionId)}/features`,
  );
  const boxes: DesignFeature[] = [];
  for (let page = 1; page <= MAX_BOX_PAGES; page += 1) {
    const result = await bffJson(
      `${base}?featureType=box&page=${page}&pageSize=500`,
      DesignFeaturePageSchema,
    );
    boxes.push(...result.items);
    if (boxes.length >= result.total || result.items.length === 0) break;
  }
  return boxes;
}
