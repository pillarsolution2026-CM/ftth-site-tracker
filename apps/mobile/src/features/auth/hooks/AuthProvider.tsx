import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { LoginRequest, MeResponse } from '@ftth/shared';
import { ApiError, type AuthApi } from '../api/api-client';

export type AuthStatus = 'loading' | 'signedOut' | 'signedIn';

interface AuthContextValue {
  status: AuthStatus;
  me: MeResponse | null;
  login: (credentials: LoginRequest) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface AuthProviderProps {
  api: AuthApi;
  children: ReactNode;
  /** Wipes data kept for the signed-in user (contractor cache, ADR-053): logout, ended session. */
  onSignedOut?: () => Promise<void>;
  /**
   * The profile kept from the last online session, used only when /auth/me cannot be reached
   * (phone offline) so a contractor can still read the saved answer.
   */
  offlineMe?: () => Promise<MeResponse | null>;
}

async function quietly(task: (() => Promise<unknown>) | undefined): Promise<void> {
  try {
    await task?.();
  } catch {
    // A failed wipe must not block signing out.
  }
}

export function AuthProvider({ api, children, onSignedOut, offlineMe }: AuthProviderProps) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [me, setMe] = useState<MeResponse | null>(null);

  // Restore the session on launch: stored tokens + a successful /auth/me.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        if (!(await api.hasSession())) throw new Error('no session');
        const profile = await api.me();
        if (!active) return;
        setMe(profile);
        setStatus('signedIn');
      } catch (error) {
        const offline = error instanceof ApiError && error.code === 'NETWORK';
        const kept = offline ? await offlineMe?.().catch(() => null) : null;
        if (!active) return;
        if (kept?.contractor) {
          setMe(kept);
          setStatus('signedIn');
          return;
        }
        // No stored session, or the server ended it (401/403): nothing may stay readable.
        if (!offline) await quietly(onSignedOut);
        if (!active) return;
        setMe(null);
        setStatus('signedOut');
      }
    })();
    return () => {
      active = false;
    };
  }, [api, onSignedOut, offlineMe]);

  const login = useCallback(
    async (credentials: LoginRequest) => {
      await api.login(credentials);
      const profile = await api.me();
      setMe(profile);
      setStatus('signedIn');
    },
    [api],
  );

  const logout = useCallback(async () => {
    await quietly(onSignedOut);
    await api.logout();
    setMe(null);
    setStatus('signedOut');
  }, [api, onSignedOut]);

  const value = useMemo(() => ({ status, me, login, logout }), [status, me, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
