import type { MessageKey } from '@ftth/i18n';
import type { AsBuiltState, OwnEdit } from './asbuilt-state';

export type OwnEditRowStatus = 'queued' | 'pending' | 'approved' | 'rejected';

export interface OwnEditRow extends Omit<OwnEdit, 'status'> {
  /** `queued` = only on this phone, `pending` = on the server awaiting review. */
  status: OwnEditRowStatus;
}

/** The user's own edits for the list: newest first, with a sync refusal shown as rejected. */
export function ownEditRows(state: AsBuiltState): OwnEditRow[] {
  return state.ownEdits.map((edit) => ({
    ...edit,
    status:
      edit.syncRejection !== null
        ? 'rejected'
        : edit.status === 'pending' && !edit.sent
          ? 'queued'
          : edit.status,
  }));
}

const ASBUILT_REJECTIONS = ['FEATURE_ID_REUSED', 'GEOMETRY_KIND_MISMATCH', 'GEOMETRY_INVALID'];

/** Message for a push refusal: the As-Built codes live under `asbuilt`, the rest under `field`. */
export function rejectionKey(code: string): MessageKey {
  return (
    ASBUILT_REJECTIONS.includes(code)
      ? `asbuilt.rejections.${code}`
      : `field.pending.rejections.${code}`
  ) as MessageKey;
}
