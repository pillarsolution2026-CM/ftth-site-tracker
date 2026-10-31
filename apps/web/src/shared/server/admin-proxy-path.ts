/** Admin resources the BFF exposes under `/api/admin/...` (the API enforces platform-admin). */
const ADMIN_RESOURCES = new Set(['projects', 'users', 'contracts']);
const SAFE_SEGMENT = /^[A-Za-z0-9._~-]{1,128}$/;

/** `[resource, ...rest]` → `/admin/resource/...`, or null when it is not allowed. */
export function adminUpstreamPath(segments: readonly string[]): string | null {
  const [resource] = segments;
  if (!resource || !ADMIN_RESOURCES.has(resource)) return null;
  // "." and ".." match the safe pattern but would climb out of the prefix.
  if (
    !segments.every((segment) => SAFE_SEGMENT.test(segment) && segment !== '.' && segment !== '..')
  ) {
    return null;
  }
  return `/admin/${segments.map(encodeURIComponent).join('/')}`;
}
