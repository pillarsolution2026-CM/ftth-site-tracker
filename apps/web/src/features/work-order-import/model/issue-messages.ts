import type { MessageKey } from '@ftth/i18n';
import type { ImportFileIssue, ImportRowIssue, ImportInvalidDetails } from '@ftth/shared';

export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

type Issue = Pick<ImportRowIssue | ImportFileIssue, 'code' | 'field' | 'params'>;

/** Server-provided params (e.g. `otherRows`) plus the translated field name. */
function paramsOf(issue: Issue, t: Translate): Record<string, string | number> {
  return {
    field: issue.field ? t(`import.fields.${issue.field}`) : '',
    otherRows: '',
    ...issue.params,
  };
}

export function rowIssueText(issue: ImportRowIssue, t: Translate): string {
  return t(`import.issues.${issue.code}`, paramsOf(issue, t));
}

export function fileIssueText(issue: ImportFileIssue, t: Translate): string {
  return t(`import.fileIssues.${issue.code}`, paramsOf(issue, t));
}

export function invalidReasonText(reason: ImportInvalidDetails['reason'], t: Translate): string {
  return t(`import.invalid.${reason}`);
}
