import { ApiErrorSchema, OfflineBundleSchema, type OfflineBundle } from '@ftth/shared';
import { TransportError } from '@ftth/sync';

/** Downloads the offline bundle (`GET /projects/:projectId/sync/bootstrap`). */
export async function fetchOfflineBundle(input: {
  baseUrl: string;
  projectId: string;
  accessToken: string | null;
  fetchFn?: typeof fetch;
}): Promise<OfflineBundle> {
  const doFetch = input.fetchFn ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${input.baseUrl}/projects/${input.projectId}/sync/bootstrap`, {
      headers: input.accessToken ? { Authorization: `Bearer ${input.accessToken}` } : {},
    });
  } catch {
    throw new TransportError('network');
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = ApiErrorSchema.safeParse(body);
    throw new TransportError('http', response.status, error.success ? error.data.code : null);
  }
  return OfflineBundleSchema.parse(body);
}
