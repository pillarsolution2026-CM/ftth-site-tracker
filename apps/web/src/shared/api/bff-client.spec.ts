import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiClientError, bffJson, bffVoid, errorReasonOf, projectApiPath } from './bff-client';

const schema = z.object({ ok: z.literal(true) });

function mockFetch(...responses: Response[]) {
  const fetchMock = vi.fn();
  for (const response of responses) fetchMock.mockResolvedValueOnce(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('bffJson', () => {
  it('parses the response with the shared schema', async () => {
    mockFetch(Response.json({ ok: true }));
    await expect(bffJson('/api/projects/x', schema)).resolves.toEqual({ ok: true });
  });

  it('rejects a response that does not match the schema', async () => {
    mockFetch(Response.json({ ok: false }));
    await expect(bffJson('/api/projects/x', schema)).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('turns API errors into typed errors with details', async () => {
    mockFetch(
      Response.json(
        { code: 'IMPORT_INVALID', message: 'x', details: { reason: 'FILE_CHANGED' } },
        { status: 422 },
      ),
    );
    const error = await bffJson('/api/projects/x', schema).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({
      code: 'IMPORT_INVALID',
      status: 422,
      details: { reason: 'FILE_CHANGED' },
    });
  });

  it('retries once after TOKEN_EXPIRED (the proxy has refreshed the cookies)', async () => {
    const fetchMock = mockFetch(
      Response.json({ code: 'TOKEN_EXPIRED', message: 'x' }, { status: 401 }),
      Response.json({ ok: true }),
    );
    await expect(bffJson('/api/projects/x', schema)).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry other 401s', async () => {
    const fetchMock = mockFetch(
      Response.json({ code: 'TOKEN_INVALID', message: 'x' }, { status: 401 }),
    );
    await expect(bffJson('/api/projects/x', schema)).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps network failures to NETWORK', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    await expect(bffJson('/api/projects/x', schema)).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('declares JSON on mutations so the proxy CSRF guard accepts them', async () => {
    const fetchMock = mockFetch(Response.json({ ok: true }));
    await bffJson('/api/projects/x', schema, { method: 'POST', body: { a: 1 } });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(init.body).toBe('{"a":1}');
  });
});

describe('bffVoid', () => {
  it('accepts 204 and sends DELETE without a body', async () => {
    const fetchMock = mockFetch(new Response(null, { status: 204 }));
    await expect(bffVoid('/api/projects/x', { method: 'DELETE' })).resolves.toBeUndefined();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });
});

describe('projectApiPath', () => {
  it('encodes the project id', () => {
    expect(projectApiPath('a/b', '/work-orders')).toBe('/api/projects/a%2Fb/work-orders');
  });
});

describe('errorReasonOf', () => {
  it('reads details.reason of an API error', () => {
    const error = new ApiClientError('CONFLICT', 409, { reason: 'VERSION_MISMATCH' });
    expect(errorReasonOf(error)).toBe('VERSION_MISMATCH');
  });

  it('is null without details, with other details or for other errors', () => {
    expect(errorReasonOf(new ApiClientError('CONFLICT', 409))).toBeNull();
    expect(errorReasonOf(new ApiClientError('CONFLICT', 409, { reason: 3 }))).toBeNull();
    expect(errorReasonOf(new Error('x'))).toBeNull();
  });
});
