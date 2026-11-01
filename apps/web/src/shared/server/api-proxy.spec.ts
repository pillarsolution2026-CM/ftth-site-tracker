// @vitest-environment node
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TokenPair } from '@ftth/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiProxy, upstreamPath, type SessionStore } from './api-proxy';

const PROJECT = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ORIGIN = 'http://web.test';
const MB = 1024 * 1024;

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  bytes: number;
}

let server: Server;
let apiUrl = '';
let seen: Seen[] = [];
/** Per-test upstream behaviour. */
let upstream: (req: IncomingMessage, res: ServerResponse, seenEntry: Seen) => void | Promise<void>;
let refreshCalls = 0;

beforeEach(async () => {
  seen = [];
  refreshCalls = 0;
  upstream = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  };
  server = createServer((req, res) => {
    const entry: Seen = {
      method: req.method ?? '',
      url: req.url ?? '',
      headers: req.headers,
      bytes: 0,
    };
    if (req.url === '/auth/refresh') {
      refreshCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          accessToken: 'new-access',
          refreshToken: 'r'.repeat(40),
          expiresIn: 900,
        }),
      );
      return;
    }
    seen.push(entry);
    req.on('data', (chunk: Buffer) => (entry.bytes += chunk.length));
    req.on('end', () => void upstream(req, res, entry));
    if (req.method === 'GET' || req.method === 'DELETE') req.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

interface FakeSession extends SessionStore {
  saved: TokenPair[];
  cleared: boolean;
}

function session(
  access: string | undefined,
  refresh = 'refresh-token-' + Math.random(),
): FakeSession {
  const fake: FakeSession = {
    saved: [],
    cleared: false,
    accessToken: () => access,
    refreshToken: () => refresh,
    save: (pair) => fake.saved.push(pair),
    clear: () => (fake.cleared = true),
  };
  return fake;
}

function request(
  method: string,
  path: string,
  init: { headers?: Record<string, string>; body?: BodyInit | null } = {},
): Request {
  const hasBody = init.body !== undefined && init.body !== null;
  return new Request(`${ORIGIN}/api/projects/${path}`, {
    method,
    headers: init.headers ?? {},
    ...(hasBody ? { body: init.body, duplex: 'half' } : {}),
  } as RequestInit);
}

const jsonHeaders = { 'content-type': 'application/json', origin: ORIGIN };

describe('upstreamPath (allow-list)', () => {
  it('allows work-orders and cad-files below a project', () => {
    expect(upstreamPath([PROJECT, 'work-orders'])).toBe(`/projects/${PROJECT}/work-orders`);
    expect(upstreamPath([PROJECT, 'cad-files', 'abc-1', 'layers'])).toBe(
      `/projects/${PROJECT}/cad-files/abc-1/layers`,
    );
  });

  it('allows design revisions, including the PMTiles archive', () => {
    expect(upstreamPath([PROJECT, 'design-revisions', 'abc-1', 'tiles.pmtiles'])).toBe(
      `/projects/${PROJECT}/design-revisions/abc-1/tiles.pmtiles`,
    );
    expect(upstreamPath([PROJECT, 'cad-files', 'abc-1', 'mapping'])).toBe(
      `/projects/${PROJECT}/cad-files/abc-1/mapping`,
    );
  });

  it('allows the read-only contract of the project', () => {
    expect(upstreamPath([PROJECT, 'contract'])).toBe(`/projects/${PROJECT}/contract`);
  });

  it('allows As-Built review and the DXF export file', () => {
    expect(upstreamPath([PROJECT, 'asbuilt', 'edits'])).toBe(`/projects/${PROJECT}/asbuilt/edits`);
    expect(upstreamPath([PROJECT, 'asbuilt', 'exports', 'abc-1', 'file'])).toBe(
      `/projects/${PROJECT}/asbuilt/exports/abc-1/file`,
    );
  });

  it('rejects other resources, bad project ids and traversal', () => {
    expect(upstreamPath([PROJECT, 'members'])).toBeNull();
    expect(upstreamPath([PROJECT])).toBeNull();
    expect(upstreamPath(['not-a-uuid', 'work-orders'])).toBeNull();
    expect(upstreamPath([PROJECT, 'work-orders', '..', 'members'])).toBeNull();
    expect(upstreamPath([PROJECT, 'work-orders', 'a/b'])).toBeNull();
    expect(upstreamPath([PROJECT, 'work-orders', 'a%2Fb'])).toBeNull();
    expect(upstreamPath([PROJECT, 'work-orders', 'x?y=1'])).toBeNull();
  });
});

describe('createApiProxy', () => {
  it('forwards the Bearer token from the cookie, the query string and no cookies', async () => {
    const proxy = createApiProxy({ apiUrl, session: session('access-1') });
    const response = await proxy(
      request('GET', `${PROJECT}/cad-files?x=1`, { headers: { cookie: 'ftth_at=secret' } }),
      [PROJECT, 'cad-files'],
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(seen[0]?.headers.authorization).toBe('Bearer access-1');
    expect(seen[0]?.headers.cookie).toBeUndefined();
    expect(seen[0]?.url).toBe(`/projects/${PROJECT}/cad-files?x=1`);
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('refreshes before the call when the access cookie is gone, and stores the new pair', async () => {
    const store = session(undefined);
    const proxy = createApiProxy({ apiUrl, session: store });
    const response = await proxy(request('GET', `${PROJECT}/work-orders`), [
      PROJECT,
      'work-orders',
    ]);
    expect(response.status).toBe(200);
    expect(refreshCalls).toBe(1);
    expect(store.saved[0]?.accessToken).toBe('new-access');
    expect(seen[0]?.headers.authorization).toBe('Bearer new-access');
  });

  it('shares one refresh between concurrent requests with the same refresh token', async () => {
    const shared = 'shared-refresh-token-' + 'x'.repeat(20);
    const a = createApiProxy({ apiUrl, session: session(undefined, shared) });
    const b = createApiProxy({ apiUrl, session: session(undefined, shared) });
    const [one, two] = await Promise.all([
      a(request('GET', `${PROJECT}/work-orders`), [PROJECT, 'work-orders']),
      b(request('GET', `${PROJECT}/work-orders`), [PROJECT, 'work-orders']),
    ]);
    expect([one.status, two.status]).toEqual([200, 200]);
    expect(refreshCalls).toBe(1);
  });

  it('refreshes once on TOKEN_EXPIRED and retries a GET', async () => {
    upstream = (req, res) => {
      if (req.headers.authorization === 'Bearer stale') {
        res
          .writeHead(401, { 'content-type': 'application/json' })
          .end('{"code":"TOKEN_EXPIRED","message":"expired"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    };
    const store = session('stale');
    const proxy = createApiProxy({ apiUrl, session: store });
    const response = await proxy(request('GET', `${PROJECT}/work-orders`), [
      PROJECT,
      'work-orders',
    ]);
    expect(response.status).toBe(200);
    expect(refreshCalls).toBe(1);
    expect(seen.map((entry) => entry.headers.authorization)).toEqual([
      'Bearer stale',
      'Bearer new-access',
    ]);
    expect(store.saved).toHaveLength(1);
  });

  it('does not retry forever when the refreshed token is also rejected', async () => {
    upstream = (_req, res) => {
      res
        .writeHead(401, { 'content-type': 'application/json' })
        .end('{"code":"TOKEN_EXPIRED","message":"expired"}');
    };
    const proxy = createApiProxy({ apiUrl, session: session('stale') });
    const response = await proxy(request('GET', `${PROJECT}/work-orders`), [
      PROJECT,
      'work-orders',
    ]);
    expect(response.status).toBe(401);
    expect(refreshCalls).toBe(1);
    expect(seen).toHaveLength(2);
  });

  it('answers 401 and clears nothing sensitive when there is no session at all', async () => {
    const store: SessionStore = {
      accessToken: () => undefined,
      refreshToken: () => undefined,
      save: () => undefined,
      clear: () => undefined,
    };
    const proxy = createApiProxy({ apiUrl, session: store });
    const response = await proxy(request('GET', `${PROJECT}/work-orders`), [
      PROJECT,
      'work-orders',
    ]);
    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('rejects mutations without same-origin JSON or multipart (CSRF)', async () => {
    const proxy = createApiProxy({ apiUrl, session: session('access-1') });
    const path = [PROJECT, 'work-orders'];
    const cases: Record<string, string>[] = [
      { 'content-type': 'application/json' },
      { 'content-type': 'application/json', origin: 'https://evil.example' },
      { 'content-type': 'text/plain', origin: ORIGIN },
      { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
      { origin: ORIGIN },
    ];
    for (const headers of cases) {
      const response = await proxy(
        request('POST', `${PROJECT}/work-orders`, { headers, body: '{}' }),
        path,
      );
      expect(response.status).toBe(403);
    }
    const deleteResponse = await proxy(
      request('DELETE', `${PROJECT}/work-orders/x`, {
        headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      }),
      [PROJECT, 'work-orders', 'x'],
    );
    expect(deleteResponse.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('refuses paths outside the allow-list and unsupported methods', async () => {
    const proxy = createApiProxy({ apiUrl, session: session('access-1') });
    const members = await proxy(request('GET', `${PROJECT}/members`), [PROJECT, 'members']);
    expect(members.status).toBe(404);
    const options = await proxy(request('OPTIONS', `${PROJECT}/work-orders`), [
      PROJECT,
      'work-orders',
    ]);
    expect(options.status).toBe(405);
    expect(seen).toHaveLength(0);
  });

  it('passes JSON mutations and upstream error bodies through', async () => {
    upstream = (_req, res) => {
      res
        .writeHead(409, { 'content-type': 'application/json' })
        .end('{"code":"CONFLICT","message":"taken"}');
    };
    const proxy = createApiProxy({ apiUrl, session: session('access-1') });
    const response = await proxy(
      request('POST', `${PROJECT}/work-orders`, {
        headers: jsonHeaders,
        body: '{"number":"WO-1"}',
      }),
      [PROJECT, 'work-orders'],
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: 'CONFLICT', message: 'taken' });
    expect(seen[0]?.bytes).toBe('{"number":"WO-1"}'.length);
  });

  it('forwards PUT with a JSON body (mapping save)', async () => {
    const proxy = createApiProxy({ apiUrl, session: session('access-1') });
    const response = await proxy(
      request('PUT', `${PROJECT}/cad-files/m1/mapping`, {
        headers: jsonHeaders,
        body: '{"version":null}',
      }),
      [PROJECT, 'cad-files', 'm1', 'mapping'],
    );
    expect(response.status).toBe(200);
    expect(seen[0]?.method).toBe('PUT');
    expect(seen[0]?.bytes).toBe('{"version":null}'.length);
  });

  it('forwards Range and passes a 206 with Content-Range and Accept-Ranges for tiles.pmtiles', async () => {
    const archive = Buffer.from('0123456789');
    upstream = (req, res) => {
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
      if (!range) {
        res.writeHead(200, { 'content-type': 'application/vnd.pmtiles', 'accept-ranges': 'bytes' });
        res.end(archive);
        return;
      }
      const [from, to] = [Number(range[1]), Number(range[2])];
      const part = archive.subarray(from, to + 1);
      res
        .writeHead(206, {
          'content-type': 'application/vnd.pmtiles',
          'content-range': `bytes ${from}-${to}/${archive.length}`,
          'accept-ranges': 'bytes',
          'content-length': String(part.length),
        })
        .end(part);
    };
    const proxy = createApiProxy({ apiUrl, session: session('access-1') });
    const segments = [PROJECT, 'design-revisions', 'r1', 'tiles.pmtiles'];
    const response = await proxy(
      request('GET', `${PROJECT}/design-revisions/r1/tiles.pmtiles`, {
        headers: { range: 'bytes=2-5' },
      }),
      segments,
    );
    expect(seen[0]?.headers.range).toBe('bytes=2-5');
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('2345');

    const whole = await proxy(
      request('GET', `${PROJECT}/design-revisions/r1/tiles.pmtiles`),
      segments,
    );
    expect(whole.status).toBe(200);
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect(seen[1]?.headers.range).toBeUndefined();
  });

  it('passes 204 without a body', async () => {
    upstream = (_req, res) => void res.writeHead(204).end();
    const proxy = createApiProxy({ apiUrl, session: session('access-1') });
    const response = await proxy(
      request('DELETE', `${PROJECT}/work-orders/x`, { headers: jsonHeaders }),
      [PROJECT, 'work-orders', 'x'],
    );
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it('streams a 20 MB multipart upload without truncating it', async () => {
    const boundary = '----ftth';
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.dxf"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const chunk = Buffer.alloc(MB, 0x61);
    const total = head.length + 20 * chunk.length + tail.length;
    let produced = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced === 0) controller.enqueue(head);
        else if (produced <= 20) controller.enqueue(chunk);
        else {
          controller.enqueue(tail);
          controller.close();
        }
        produced += 1;
      },
    });
    const proxy = createApiProxy({ apiUrl, session: session('access-1') });
    const response = await proxy(
      request('POST', `${PROJECT}/cad-files`, {
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, origin: ORIGIN },
        body,
      }),
      [PROJECT, 'cad-files'],
    );
    expect(response.status).toBe(200);
    expect(seen[0]?.bytes).toBe(total);
    expect(seen[0]?.headers['content-type']).toBe(`multipart/form-data; boundary=${boundary}`);
  });

  it('streams downloads chunk by chunk and keeps Content-Disposition', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    upstream = async (_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': "attachment; filename*=UTF-8''%D9%85%D8%AE%D8%B7%D8%B7.dxf",
      });
      res.write(Buffer.alloc(MB, 1));
      await gate; // the rest is only sent after the client got the first chunk
      for (let i = 0; i < 19; i += 1) res.write(Buffer.alloc(MB, 2));
      res.end();
    };
    const proxy = createApiProxy({ apiUrl, session: session('access-1') });
    const response = await proxy(request('GET', `${PROJECT}/cad-files/f1/content`), [
      PROJECT,
      'cad-files',
      'f1',
      'content',
    ]);
    expect(response.headers.get('content-disposition')).toContain("filename*=UTF-8''");
    expect(response.headers.get('content-type')).toBe('application/octet-stream');

    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read(); // would hang if the proxy buffered the whole file
    expect(first.value?.length).toBeGreaterThan(0);
    release();
    let received = first.value?.length ?? 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      received += next.value.length;
    }
    expect(received).toBe(20 * MB);
  });
});
