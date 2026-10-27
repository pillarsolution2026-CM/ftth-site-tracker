/**
 * Tiny stand-in for the FTTH API used by the Playwright run (no imports on purpose: it is
 * started with plain `node`). Implements the auth endpoints with fixed data.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const PORT = Number(process.env.MOCK_API_PORT ?? 3101);
const EMAIL = 'pm@example.com';
const PASSWORD = 'correct-password';
const ACCESS = 'mock-access-token';
const REFRESH = 'mock-refresh-token-0123456789abcdef0123456789';

const ME = {
  id: 'b3b5c5a2-1f0e-4c5e-8a4b-6d2f9a7e1c10',
  email: EMAIL,
  displayName: 'منى أحمد',
  locale: 'ar',
  isAdmin: false,
  memberships: [
    {
      projectId: '0f8fad5b-d9cb-469f-a165-70867728950e',
      projectName: 'شبكة الألياف - القاهرة الجديدة',
      role: 'pm',
      zoneIds: [],
    },
  ],
};

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
  });
}

const tokens = { accessToken: ACCESS, refreshToken: REFRESH, expiresIn: 900 };

createServer(async (req, res) => {
  const route = `${req.method} ${req.url}`;
  if (route === 'POST /auth/login') {
    const body = await readJson(req);
    if (body.email === EMAIL && body.password === PASSWORD) return send(res, 200, tokens);
    return send(res, 401, { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' });
  }
  if (route === 'POST /auth/refresh') {
    const body = await readJson(req);
    if (body.refreshToken === REFRESH) return send(res, 200, tokens);
    return send(res, 401, { code: 'TOKEN_INVALID', message: 'Invalid refresh token' });
  }
  if (route === 'GET /health') return send(res, 200, { ok: true });
  if (route === 'POST /auth/logout') return send(res, 204);
  if (route === 'GET /auth/me') {
    if (req.headers.authorization === `Bearer ${ACCESS}`) return send(res, 200, ME);
    return send(res, 401, { code: 'TOKEN_EXPIRED', message: 'Access token expired' });
  }
  return send(res, 404, { code: 'NOT_FOUND', message: 'Not found' });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`mock API listening on ${PORT}`);
});
