import type { MessageKey } from '@ftth/i18n';
import {
  QUANTITY_MAX_DECIMALS,
  UNIT_PRICE_MAX_DECIMALS,
  type ImportFileIssue,
  type ImportInvalidDetails,
  type ImportRowIssue,
  type WorkType,
  WORK_TYPES,
} from '@ftth/shared';

export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

function isWorkType(value: string): value is WorkType {
  return (WORK_TYPES as readonly string[]).includes(value);
}

type Issue = Pick<ImportRowIssue | ImportFileIssue, 'code' | 'field' | 'params'>;

/** Server-provided params (e.g. `otherRows`, `max`) plus the translated field name. */
function paramsOf(issue: Issue, t: Translate): Record<string, string | number> {
  return {
    field: issue.field ? t(`import.fields.${issue.field}`) : '',
    otherRows: '',
    value: '',
    contractValue: '',
    availableQuantity: '',
    contractQuantity: '',
    reservedQuantity: '',
    workOrderValue: '',
    workOrderQuantity: '',
    contractPrice: '',
    otherScopesPrice: '',
    maxAllowedPrice: '',
    code: '',
    scope: '',
    // The server always sends `max` with TOO_MANY_DECIMALS; this only covers older responses.
    max: issue.field === 'unitPrice' ? UNIT_PRICE_MAX_DECIMALS : QUANTITY_MAX_DECIMALS,
    ...issue.params,
    // A whole line has no scope text: say so instead of leaving a gap.
    ...(issue.code === 'QUANTITY_EXCEEDS_WORK_ORDER' ||
    issue.code === 'LINE_ALREADY_ASSIGNED' ||
    issue.code === 'CODE_SCOPE_REPEATED'
      ? { scope: String(issue.params?.scope ?? '') || t('contractors.scope.whole') }
      : {}),
    // The contract's work type arrives as its code ('civil'): show it in the user's language.
    ...(issue.code === 'CONTRACT_MISMATCH' &&
    issue.field === 'workType' &&
    typeof issue.params?.contractValue === 'string' &&
    isWorkType(issue.params.contractValue)
      ? { contractValue: t(`items.workTypes.${issue.params.contractValue}`) }
      : {}),
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
