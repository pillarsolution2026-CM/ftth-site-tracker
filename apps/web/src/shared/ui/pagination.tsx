'use client';

import { useI18n } from '@/shared/i18n/locale-provider';
import { Button } from './button';

interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

export function Pagination({ page, pageSize, total, onPageChange }: PaginationProps) {
  const { t } = useI18n();
  const pages = pageCount(total, pageSize);
  return (
    <nav aria-label={t('common.pagination')} className="mt-3 flex flex-wrap items-center gap-3">
      <Button variant="outline" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
        {t('common.previous')}
      </Button>
      <span aria-live="polite">{t('common.pageOf', { page, pages, total })}</span>
      <Button variant="outline" disabled={page >= pages} onClick={() => onPageChange(page + 1)}>
        {t('common.next')}
      </Button>
    </nav>
  );
}
