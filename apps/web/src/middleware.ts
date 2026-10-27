import { NextResponse, type NextRequest } from 'next/server';
import { DEFAULT_LOCALE, isLocale } from '@ftth/i18n';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '@/features/auth/model/session-cookies';

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const segments = pathname.split('/').filter(Boolean);
  const [first, second] = segments;

  // `/` and any path without a locale prefix go to the default locale.
  if (!isLocale(first)) {
    const url = request.nextUrl.clone();
    url.pathname = `/${DEFAULT_LOCALE}${pathname === '/' ? '' : pathname}`;
    return NextResponse.redirect(url);
  }

  // A refresh cookie alone is enough: `/api/session/me` renews the access token on demand.
  const hasSession = request.cookies.has(ACCESS_COOKIE) || request.cookies.has(REFRESH_COOKIE);
  if (second !== 'login' && !hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = `/${first}/login`;
    url.search = '';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Skip route handlers, Next internals and files with an extension.
  matcher: ['/((?!api|_next|.*\\..*).*)'],
};
