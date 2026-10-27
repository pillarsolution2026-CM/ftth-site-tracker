export interface CsrfCheckInput {
  contentType: string | null;
  origin: string | null;
  /** Origin derived from the request's own URL. */
  requestOrigin: string;
  /** Optional override for reverse-proxy deployments (APP_ORIGIN). */
  appOrigin?: string | undefined;
}

function normalize(origin: string): string | null {
  try {
    return new URL(origin).origin;
  } catch {
    return null;
  }
}

/**
 * Login-CSRF guard for cookie-setting JSON endpoints: the body must be declared
 * as application/json (which a cross-site HTML form cannot send) and the Origin
 * header must be present and match our own origin.
 */
export function isSameOriginJsonRequest(input: CsrfCheckInput): boolean {
  return isSameOriginRequest(input, ['application/json']);
}

/** Same check for other body types a cross-site HTML form cannot send without preflight. */
export function isSameOriginRequest(input: CsrfCheckInput, mediaTypes: readonly string[]): boolean {
  const mediaType = input.contentType?.split(';')[0]?.trim().toLowerCase();
  if (!mediaType || !mediaTypes.includes(mediaType)) return false;
  if (!input.origin) return false;
  const origin = normalize(input.origin);
  if (!origin || input.origin === 'null') return false;
  const expected = normalize(input.appOrigin?.trim() ? input.appOrigin : input.requestOrigin);
  return expected !== null && origin === expected;
}

export function isTrustedSessionRequest(request: Request): boolean {
  return isSameOriginJsonRequest({
    contentType: request.headers.get('content-type'),
    origin: request.headers.get('origin'),
    requestOrigin: new URL(request.url).origin,
    appOrigin: process.env.APP_ORIGIN,
  });
}

/**
 * Guard for mutating requests through the BFF proxy: JSON or multipart upload, same origin.
 * (A plain HTML form can post multipart cross-site, which is why the Origin header must match.)
 */
export function isTrustedProxyMutation(request: Request): boolean {
  return isSameOriginRequest(
    {
      contentType: request.headers.get('content-type'),
      origin: request.headers.get('origin'),
      requestOrigin: new URL(request.url).origin,
      appOrigin: process.env.APP_ORIGIN,
    },
    ['application/json', 'multipart/form-data'],
  );
}
