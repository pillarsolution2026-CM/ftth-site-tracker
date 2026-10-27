'use client';

import { useI18n } from '@/shared/i18n/locale-provider';
import type { ClientErrorCode } from '@/shared/api/bff-client';
import { Notice } from './notice';

/** Translated API/network error. */
export function ErrorNotice({ code, className }: { code: ClientErrorCode; className?: string }) {
  const { t } = useI18n();
  return (
    <Notice kind="error" {...(className ? { className } : {})}>
      {t(`errors.${code}`)}
    </Notice>
  );
}
