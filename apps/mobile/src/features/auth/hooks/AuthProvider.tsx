import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { LoginRequest, MeResponse } from '@ftth/shared';
import type { AuthApi } from '../api/api-client';

export type AuthStatus = 'loading' | 'signedOut' | 'signedIn';

interface AuthContextValue {
  status: AuthStatus;
  me: MeResponse | null;
  login: (credentials: LoginRequest) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ api, children }: { api: AuthApi; children: ReactNode }) {
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
      } catch {
        if (!active) return;
        setMe(null);
        setStatus('signedOut');
      }
    })();
    return () => {
      active = false;
    };
  }, [api]);

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
    await api.logout();
    setMe(null);
    setStatus('signedOut');
  }, [api]);

  const value = useMemo(() => ({ status, me, login, logout }), [status, me, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
