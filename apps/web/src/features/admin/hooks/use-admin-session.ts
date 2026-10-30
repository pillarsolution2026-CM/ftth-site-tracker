'use client';

import { useHomeSession } from '@/features/auth/hooks/use-home-session';

/** The signed-in user, gated to platform admins. The API stays the authority (every route re-checks). */
export function useAdminSession() {
  const session = useHomeSession();
  const state = session.failureCode
    ? ('error' as const)
    : session.loading || !session.me
      ? ('loading' as const)
      : session.me.isAdmin
        ? ('ready' as const)
        : ('forbidden' as const);
  return { ...session, state };
}
