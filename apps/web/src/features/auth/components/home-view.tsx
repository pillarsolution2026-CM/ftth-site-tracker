'use client';

import type { ErrorCode, MeResponse } from '@ftth/shared';
import { Button } from '@/shared/ui/button';
import { Card } from '@/shared/ui/card';
import { useI18n } from '@/shared/i18n/locale-provider';
import { useHomeSession } from '../hooks/use-home-session';

interface HomeViewProps {
  me: MeResponse | null;
  loading: boolean;
  failureCode: ErrorCode | null;
  loggingOut: boolean;
  onLogout: () => void;
}

/** Presentational home: greeting, role per project, logout. */
export function HomeView({ me, loading, failureCode, loggingOut, onLogout }: HomeViewProps) {
  const { t } = useI18n();

  if (failureCode) {
    return (
      <p role="alert" className="flex items-center gap-2">
        <span aria-hidden="true">⚠</span>
        <span>{t(`errors.${failureCode}`)}</span>
      </p>
    );
  }
  if (loading || !me) return <p role="status">{t('common.loading')}</p>;

  return (
    <Card className="w-full max-w-2xl">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">{t('auth.welcome', { name: me.displayName })}</h1>
        <Button variant="outline" onClick={onLogout} disabled={loggingOut}>
          {t('common.logout')}
        </Button>
      </div>

      <h2 className="mt-6 mb-2 text-lg font-semibold">{t('home.projects')}</h2>
      {me.isAdmin ? <p className="mb-2 text-sm">{t('roles.admin')}</p> : null}
      {me.memberships.length === 0 ? (
        <p>{t('home.noProjects')}</p>
      ) : (
        <ul className="divide-y divide-(--color-border)">
          {me.memberships.map((membership) => (
            <li
              key={membership.projectId}
              className="flex min-h-11 items-center justify-between gap-4 py-2"
            >
              <span>{membership.projectName}</span>
              <span className="rounded-md border border-(--color-border) px-2 py-1 text-sm">
                {t(`roles.${membership.role}`)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Container: wires the session hook into the view. */
export function Home() {
  return <HomeView {...useHomeSession()} />;
}
