import { createHmac, timingSafeEqual } from 'node:crypto';
import { TILE_SOURCE_DESIGN_FEATURES, tileSignaturePayload } from '@ftth/shared';

/** base64url(HMAC_SHA256(secret, tileSignaturePayload(...))) without padding (ADR-021). */
export function signTile(
  secret: string,
  projectId: string,
  revisionId: string,
  exp: number,
): string {
  return createHmac('sha256', secret)
    .update(tileSignaturePayload(TILE_SOURCE_DESIGN_FEATURES, projectId, revisionId, exp))
    .digest('base64url');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS = /^\d{1,12}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes in base64url, no padding
const TILE_PATH = new RegExp(`^/${TILE_SOURCE_DESIGN_FEATURES}/\\d{1,2}/\\d{1,8}/\\d{1,8}$`);

/** Exactly one value for `name`, or null when it is missing or repeated. */
function single(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? (values[0] ?? null) : null;
}

/**
 * Checks the `X-Forwarded-Uri` Caddy sends from `forward_auth`: path `/design_features/z/x/y` and
 * the query `p`, `r`, `exp`, `sig`. Pure and free of I/O: no database access (it runs per tile).
 * Returns false for a wrong path, malformed or repeated parameters, an expired URL, or a signature
 * that does not match (compared in constant time).
 */
export function verifyTileUri(secret: string, forwardedUri: string, nowSeconds: number): boolean {
  const queryStart = forwardedUri.indexOf('?');
  if (queryStart < 0) return false;
  if (!TILE_PATH.test(forwardedUri.slice(0, queryStart))) return false;

  const params = new URLSearchParams(forwardedUri.slice(queryStart + 1));
  const projectId = single(params, 'p');
  const revisionId = single(params, 'r');
  const expText = single(params, 'exp');
  const signature = single(params, 'sig');
  if (!projectId || !revisionId || !expText || !signature) return false;
  if (!UUID.test(projectId) || !UUID.test(revisionId) || !DIGITS.test(expText)) return false;
  if (!SIGNATURE.test(signature)) return false;

  const exp = Number(expText);
  if (exp <= nowSeconds) return false;

  const expected = Buffer.from(signTile(secret, projectId, revisionId, exp));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
