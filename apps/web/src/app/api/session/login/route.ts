import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { LoginRequestSchema } from '@ftth/shared';
import { apiLogin } from '@/features/auth/api/auth-api.server';
import { setSessionCookies } from '@/features/auth/model/session-cookies';

export async function POST(request: Request) {
  const parsed = LoginRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { code: 'VALIDATION_FAILED', message: 'Invalid login request' },
      { status: 400 },
    );
  }

  const result = await apiLogin(parsed.data);
  if (!result.ok) return NextResponse.json(result.error, { status: result.status });

  setSessionCookies(await cookies(), result.data);
  // Tokens stay in httpOnly cookies; the browser only learns that it succeeded.
  return NextResponse.json({ ok: true });
}
