import { InMemoryTokenStorage } from '../../../shared/storage/token-storage';
import { ApiError, createAuthApi } from './api-client';

const OLD = { accessToken: 'old-access', refreshToken: 'r'.repeat(40), expiresIn: 900 };
const NEW = { accessToken: 'new-access', refreshToken: 'n'.repeat(40), expiresIn: 900 };
const ME = {
  id: '3f0c1c1e-6d1f-4a39-8a3e-7a0c2f1b9d11',
  email: 'sup@example.com',
  displayName: 'Mona',
  locale: 'ar',
  isAdmin: false,
  memberships: [],
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
const expired = () => json(401, { code: 'TOKEN_EXPIRED', message: 'expired' });

function setup(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const storage = new InMemoryTokenStorage(OLD);
  const fetchFn = jest.fn((url: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init ?? {})),
  );
  const api = createAuthApi({
    baseUrl: 'http://api.test',
    storage,
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  return { api, storage, fetchFn };
}

describe('auth api client', () => {
  it('refreshes once on TOKEN_EXPIRED, stores the rotated pair and retries', async () => {
    const { api, storage, fetchFn } = setup((url, init) => {
      if (url.endsWith('/auth/refresh')) return json(200, NEW);
      const auth = (init.headers as Record<string, string>).Authorization;
      return auth === 'Bearer new-access' ? json(200, ME) : expired();
    });

    const me = await api.me();

    expect(me.displayName).toBe('Mona');
    expect(await storage.read()).toEqual(NEW);
    const urls = fetchFn.mock.calls.map(([url]) => String(url));
    expect(urls).toEqual([
      'http://api.test/auth/me',
      'http://api.test/auth/refresh',
      'http://api.test/auth/me',
    ]);
    const refreshBody = JSON.parse(String(fetchFn.mock.calls[1]?.[1]?.body));
    expect(refreshBody).toEqual({ refreshToken: OLD.refreshToken });
  });

  it('does not refresh a second time when the retry is still 401', async () => {
    const { api, fetchFn } = setup((url) =>
      url.endsWith('/auth/refresh') ? json(200, NEW) : expired(),
    );

    await expect(api.me()).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
    expect(
      fetchFn.mock.calls.filter(([url]) => String(url).endsWith('/auth/refresh')),
    ).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('clears the session when the refresh token is rejected', async () => {
    const { api, storage } = setup((url) =>
      url.endsWith('/auth/refresh')
        ? json(401, { code: 'REFRESH_TOKEN_REUSED', message: 'reused' })
        : expired(),
    );

    await expect(api.me()).rejects.toMatchObject({ code: 'REFRESH_TOKEN_REUSED' });
    expect(await storage.read()).toBeNull();
  });

  it('shares one refresh between concurrent requests', async () => {
    const { api, fetchFn } = setup((url, init) => {
      if (url.endsWith('/auth/refresh')) return json(200, NEW);
      const auth = (init.headers as Record<string, string>).Authorization;
      return auth === 'Bearer new-access' ? json(200, ME) : expired();
    });

    await Promise.all([api.me(), api.me()]);

    expect(
      fetchFn.mock.calls.filter(([url]) => String(url).endsWith('/auth/refresh')),
    ).toHaveLength(1);
  });

  it('does not refresh for other 401 codes', async () => {
    const { api, fetchFn } = setup(() => json(401, { code: 'TOKEN_INVALID', message: 'bad' }));

    await expect(api.me()).rejects.toBeInstanceOf(ApiError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('login stores the token pair and maps INVALID_CREDENTIALS', async () => {
    const ok = setup(() => json(200, NEW));
    await ok.api.login({ email: 'a@b.com', password: 'password123' });
    expect(await ok.storage.read()).toEqual(NEW);

    const bad = setup(() => json(401, { code: 'INVALID_CREDENTIALS', message: 'no' }));
    await expect(
      bad.api.login({ email: 'a@b.com', password: 'password123' }),
    ).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
  });

  it('reports NETWORK when fetch fails', async () => {
    const storage = new InMemoryTokenStorage();
    const api = createAuthApi({
      baseUrl: 'http://api.test',
      storage,
      fetchFn: (() => Promise.reject(new TypeError('offline'))) as unknown as typeof fetch,
    });
    await expect(api.login({ email: 'a@b.com', password: 'password123' })).rejects.toMatchObject({
      code: 'NETWORK',
    });
  });

  it('exposes the access token and refreshes the session for the sync client', async () => {
    const { api, storage } = setup((url) =>
      url.endsWith('/auth/refresh') ? json(200, NEW) : json(500, {}),
    );
    expect(await api.accessToken()).toBe('old-access');
    expect(await api.refreshSession()).toBe(true);
    expect(await api.accessToken()).toBe('new-access');
    expect(await storage.read()).toEqual(NEW);
  });

  it('reports a refused refresh as the end of the session', async () => {
    const { api } = setup(() => json(401, { code: 'REFRESH_TOKEN_REUSED', message: 'x' }));
    expect(await api.refreshSession()).toBe(false);
    expect(await api.accessToken()).toBeNull();
  });

  it('logout clears local tokens even when the server call fails', async () => {
    const { api, storage } = setup(() => json(500, { code: 'INTERNAL', message: 'x' }));
    await api.logout();
    expect(await storage.read()).toBeNull();
  });
});
