'use client';

import type { ImportInvalidDetails } from '@ftth/shared';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import { fileIssueText, invalidReasonText, rowIssueText } from '../model/issue-messages';

/** Server-side rejection of the commit (IMPORT_INVALID) with everything the server found. */
export function ImportInvalidNotice({ details }: { details: ImportInvalidDetails | null }) {
  const { t } = useI18n();
  if (!details) return <Notice kind="error">{t('errors.IMPORT_INVALID')}</Notice>;
  return (
    <Notice kind="error">
      <p className="font-semibold">{t('errors.IMPORT_INVALID')}</p>
      <p className="mt-1">{invalidReasonText(details.reason, t)}</p>
      {details.fileIssues.length > 0 ? (
        <ul className="mt-2 list-disc ps-5">
          {details.fileIssues.map((issue, index) => (
            <li key={`${issue.code}-${index}`}>{fileIssueText(issue, t)}</li>
          ))}
        </ul>
      ) : null}
      {details.duplicateCodes.length > 0 ? (
        <p className="mt-2">
          {t('import.invalid.duplicateCodes')}{' '}
          {details.duplicateCodes.map((code, index) => (
            <span key={code}>
              {index > 0 ? ', ' : ''}
              <Ltr>{code}</Ltr>
            </span>
          ))}
        </p>
      ) : null}
      {details.rows.length > 0 ? (
        <ul className="mt-2 list-disc ps-5">
          {details.rows.slice(0, 50).map((row) => (
            <li key={row.rowNumber}>
              {t('import.invalid.row', { row: row.rowNumber })}
              {': '}
              {row.issues.map((issue) => rowIssueText(issue, t)).join(' · ')}
            </li>
          ))}
          {details.rows.length > 50 ? (
            <li>{t('import.invalid.moreRows', { count: details.rows.length - 50 })}</li>
          ) : null}
        </ul>
      ) : null}
    </Notice>
  );
}
