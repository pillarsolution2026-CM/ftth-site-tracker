import {
  ElementGroupsResponseSchema,
  ReplaceElementGroupsRequestSchema,
  type ElementGroupsResponse,
  type ElementKey,
  type ReplaceElementGroupsRequest,
} from '@ftth/shared';
import { z } from 'zod';
import { bffJson } from '@/shared/api/bff-client';

/** Platform-admin routes (ADR-056) through the admin BFF; only these two paths are proxied. */
const PATH = '/api/admin/element-groups';

export function getElementGroups(): Promise<ElementGroupsResponse> {
  return bffJson(PATH, ElementGroupsResponseSchema);
}

export function replaceElementGroups(
  element: ElementKey,
  body: ReplaceElementGroupsRequest,
): Promise<unknown> {
  return bffJson(`${PATH}/${encodeURIComponent(element)}`, z.unknown(), {
    method: 'PUT',
    body: ReplaceElementGroupsRequestSchema.parse(body),
  });
}
