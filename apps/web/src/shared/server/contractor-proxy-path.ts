/** The one contractor-portal call the BFF exposes: `/api/contractor/me` → `/contractor/me`. */
export function contractorUpstreamPath(segments: readonly string[]): string | null {
  return segments.length === 1 && segments[0] === 'me' ? '/contractor/me' : null;
}
