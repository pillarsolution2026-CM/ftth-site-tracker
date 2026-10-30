import { describe, expect, it } from 'vitest';
import { createHttpTransport } from './http-transport.js';
import { TransportError } from './ports.js';

const PROJECT = '00000000-0000-4000-8000-000000000001';
const PHOTO = '00000000-0000-4000-8000-000000000002';

function transport(respond: (url: string, init: RequestInit) => Promise<Response>, token = 't') {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = createHttpTransport({
    baseUrl: 'https://api.example/',
    projectId: PROJECT,
    getAccessToken: async () => token,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return respond(url, init);
    },
  });
  return { client, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('createHttpTransport', () => {
  it('sends the bearer token and parses push results', async () => {
    const { client, calls } = transport(async () =>
      json(200, { serverTime: '2026-10-30T10:00:00Z', results: [] }),
    );
    const response = await client.push({ deviceId: PHOTO, ops: [] });
    expect(response.results).toEqual([]);
    expect(calls[0]?.url).toBe(`https://api.example/projects/${PROJECT}/sync/push`);
    expect(new Headers(calls[0]?.init.headers).get('Authorization')).toBe('Bearer t');
    expect(calls[0]?.init.method).toBe('POST');
  });

  it('sends chunks as octet-stream with the Upload-Offset header', async () => {
    const status = { photoId: PHOTO, sizeBytes: 10, receivedBytes: 4, state: 'receiving' };
    const { client, calls } = transport(async () => json(200, status));
    expect(await client.putPhotoChunk(PHOTO, 0, new Uint8Array(4))).toEqual(status);
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('Content-Type')).toBe('application/octet-stream');
    expect(headers.get('Upload-Offset')).toBe('0');
    expect(calls[0]?.url).toMatch(/\/sync\/photos\/.+\/content$/);
    expect(await client.photoStatus(PHOTO)).toEqual(status);
  });

  it('encodes the pull cursor and parses pages', async () => {
    const { client, calls } = transport(async () =>
      json(200, { serverTime: '2026-10-30T10:00:00Z', cursor: '5', hasMore: false, updates: [] }),
    );
    expect((await client.changes('3', 100)).cursor).toBe('5');
    expect(calls[0]?.url).toMatch(/changes\?cursor=3&limit=100$/);
  });

  it('maps API errors to http TransportErrors with code and details', async () => {
    const { client } = transport(async () =>
      json(409, { code: 'CONFLICT', message: 'offset', details: { receivedBytes: 4 } }),
    );
    const error = await client.photoStatus(PHOTO).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({
      kind: 'http',
      status: 409,
      code: 'CONFLICT',
      details: { receivedBytes: 4 },
    });
  });

  it('maps a failed fetch to a network error and a non-JSON error body to a bare http error', async () => {
    const offline = transport(async () => {
      throw new TypeError('Network request failed');
    });
    await expect(offline.client.photoStatus(PHOTO)).rejects.toMatchObject({ kind: 'network' });
    const html = transport(async () => new Response('<html>', { status: 502 }));
    await expect(html.client.photoStatus(PHOTO)).rejects.toMatchObject({
      kind: 'http',
      status: 502,
      code: null,
    });
  });

  it('refuses a 200 response that does not match the contract', async () => {
    const { client } = transport(async () => json(200, { nope: true }));
    await expect(client.photoStatus(PHOTO)).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('omits the Authorization header without a token', async () => {
    const { client, calls } = transport(
      async () => json(200, { serverTime: '2026-10-30T10:00:00Z', results: [] }),
      '',
    );
    await client.push({ deviceId: PHOTO, ops: [] });
    expect(new Headers(calls[0]?.init.headers).has('Authorization')).toBe(false);
  });
});
