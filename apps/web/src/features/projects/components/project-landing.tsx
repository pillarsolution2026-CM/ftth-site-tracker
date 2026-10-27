'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import { useProject } from '../hooks/project-access-context';
import { firstSectionPath } from '../model/project-access';

/** `/projects/:id` goes to the first section the user may read. */
export function ProjectLanding() {
  const { locale, t } = useI18n();
  const router = useRouter();
  const { access } = useProject();
  const target = firstSectionPath(locale, access);

  useEffect(() => {
    if (target) router.replace(target);
  }, [target, router]);

  return target ? (
    <p role="status">{t('common.loading')}</p>
  ) : (
    <Notice kind="warning">{t('project.noSections')}</Notice>
  );
}
