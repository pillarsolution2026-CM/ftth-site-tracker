'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import { useAdminSession } from '../hooks/use-admin-session';

const LINK =
  'flex min-h-11 items-center rounded-md px-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus) ';

/** Gate + navigation for the admin screens. Non-admins see a notice, never the screens. */
export function AdminLayout({ children }: { children: ReactNode }) {
  const { t, locale } = useI18n();
  const pathname = usePathname();
  const session = useAdminSession();

  if (session.state === 'error') {
    return <Notice kind="error">{t(`errors.${session.failureCode ?? 'INTERNAL'}`)}</Notice>;
  }
  if (session.state === 'loading') return <p role="status">{t('common.loading')}</p>;
  if (session.state === 'forbidden') return <Notice kind="error">{t('admin.forbidden')}</Notice>;

  const items = [
    { href: `/${locale}`, label: t('home.projects'), exact: true },
    { href: `/${locale}/admin/projects`, label: t('admin.projects'), exact: false },
    { href: `/${locale}/admin/users`, label: t('admin.users.title'), exact: false },
  ];
  return (
    <div className="flex w-full flex-col gap-4">
      <nav aria-label={t('admin.title')}>
        <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
          {items.map((item) => {
            const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={
                    LINK +
                    (active
                      ? 'bg-(--color-brand) font-semibold text-(--color-brandContrast)'
                      : 'text-(--color-brand) underline')
                  }
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      {children}
    </div>
  );
}
