import type { MessageKey } from '@ftth/i18n';
import { errorCodeOf, errorReasonOf } from '@/shared/api/bff-client';

/** EMAIL_TAKEN in words; every other failure shows the generic text of its error code. */
export function accountErrorKey(error: unknown): MessageKey {
  return errorReasonOf(error) === 'EMAIL_TAKEN'
    ? 'contractorAccounts.emailTaken'
    : `errors.${errorCodeOf(error)}`;
}
