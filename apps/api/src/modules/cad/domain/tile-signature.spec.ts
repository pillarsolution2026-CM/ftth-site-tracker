import { describe, expect, it } from 'vitest';
import { signTile, verifyTileUri } from './tile-signature.js';

const SECRET = 'unit-test-tile-secret-unit-test-tile-secret';
const P = '11111111-1111-4111-8111-111111111111';
const R = '22222222-2222-4222-8222-222222222222';
const NOW = 1_800_000_000;

const uri = (
  overrides: { path?: string; p?: string; r?: string; exp?: number; sig?: string } = {},
) => {
  const exp = overrides.exp ?? NOW + 3600;
  const sig = overrides.sig ?? signTile(SECRET, P, R, exp);
  return `${overrides.path ?? '/design_features/14/9640/6290'}?p=${overrides.p ?? P}&r=${overrides.r ?? R}&exp=${exp}&sig=${sig}`;
};

describe('tile signature', () => {
  it('produces a deterministic base64url signature without padding', () => {
    const sig = signTile(SECRET, P, R, NOW);
    expect(sig).toBe(signTile(SECRET, P, R, NOW));
    expect(sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(signTile(SECRET, P, R, NOW + 1)).not.toBe(sig);
    expect(signTile('another-secret-another-secret-another', P, R, NOW)).not.toBe(sig);
  });

  it('accepts a good, unexpired URL', () => {
    expect(verifyTileUri(SECRET, uri(), NOW)).toBe(true);
  });

  it('rejects an expired URL (also exactly at the expiry second)', () => {
    expect(verifyTileUri(SECRET, uri({ exp: NOW - 1 }), NOW)).toBe(false);
    expect(verifyTileUri(SECRET, uri({ exp: NOW }), NOW)).toBe(false);
  });

  it('rejects a tampered project, revision, expiry or signature', () => {
    const other = '33333333-3333-4333-8333-333333333333';
    const good = signTile(SECRET, P, R, NOW + 3600);
    expect(verifyTileUri(SECRET, uri({ p: other, sig: good }), NOW)).toBe(false);
    expect(verifyTileUri(SECRET, uri({ r: other, sig: good }), NOW)).toBe(false);
    // Extending the lifetime without re-signing.
    expect(verifyTileUri(SECRET, uri({ exp: NOW + 999_999, sig: good }), NOW)).toBe(false);
    expect(
      verifyTileUri(
        SECRET,
        uri({ sig: `${good.slice(0, -1)}${good.endsWith('A') ? 'B' : 'A'}` }),
        NOW,
      ),
    ).toBe(false);
    expect(verifyTileUri(SECRET, uri({ sig: 'short' }), NOW)).toBe(false);
  });

  it('rejects a signature made with another secret', () => {
    expect(verifyTileUri('a-different-secret-a-different-secret', uri(), NOW)).toBe(false);
  });

  it.each([
    '/other_source/14/1/2',
    '/design_features/14/1',
    '/design_features/14/1/2/3',
    '/design_features/a/1/2',
    '/design_features/14/1/-2',
    '/prefix/design_features/14/1/2',
    '/design_features/14/1/2/',
    '',
  ])('rejects the wrong path %j', (path) => {
    expect(verifyTileUri(SECRET, uri({ path }), NOW)).toBe(false);
  });

  it('rejects missing, repeated and malformed parameters', () => {
    const good = uri();
    expect(verifyTileUri(SECRET, good.split('?')[0] ?? '', NOW)).toBe(false);
    expect(verifyTileUri(SECRET, good.replace(/&sig=.*/, ''), NOW)).toBe(false);
    expect(verifyTileUri(SECRET, `${good}&p=${P}`, NOW)).toBe(false);
    expect(verifyTileUri(SECRET, good.replace(`p=${P}`, 'p=not-a-uuid'), NOW)).toBe(false);
    expect(verifyTileUri(SECRET, uri().replace(/exp=\d+/, 'exp=1e10'), NOW)).toBe(false);
    expect(verifyTileUri(SECRET, uri().replace(/exp=\d+/, 'exp=-5'), NOW)).toBe(false);
  });
});
