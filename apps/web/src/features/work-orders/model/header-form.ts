import type { MessageKey } from '@ftth/i18n';
import type { UpdateWorkOrderRequest, WorkOrderDetail } from '@ftth/shared';

export interface HeaderFormValues {
  number: string;
  title: string;
  issuedOn: string;
  notes: string;
}

export type HeaderFormErrors = Partial<Record<keyof HeaderFormValues, MessageKey>>;

export const EMPTY_HEADER_FORM: HeaderFormValues = {
  number: '',
  title: '',
  issuedOn: '',
  notes: '',
};

export function headerToFormValues(
  workOrder: Pick<WorkOrderDetail, 'number' | 'title' | 'issuedOn' | 'notes'>,
): HeaderFormValues {
  return {
    number: workOrder.number,
    title: workOrder.title ?? '',
    issuedOn: workOrder.issuedOn ?? '',
    notes: workOrder.notes ?? '',
  };
}

export function validateHeader(values: HeaderFormValues): HeaderFormErrors {
  const errors: HeaderFormErrors = {};
  const number = values.number.trim();
  if (number === '') errors.number = 'validation.required';
  else if (number.length > 64) errors.number = 'validation.tooLong';
  if (values.title.trim().length > 200) errors.title = 'validation.tooLong';
  if (values.notes.trim().length > 4000) errors.notes = 'validation.tooLong';
  if (values.issuedOn !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(values.issuedOn)) {
    errors.issuedOn = 'validation.date';
  }
  return errors;
}

const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());

export function headerPayload(values: HeaderFormValues) {
  return {
    number: values.number.trim(),
    title: orNull(values.title),
    issuedOn: values.issuedOn === '' ? null : values.issuedOn,
    notes: orNull(values.notes),
  };
}

/** Only the changed fields, plus the version the user was looking at (optimistic concurrency). */
export function headerChanges(
  current: WorkOrderDetail,
  values: HeaderFormValues,
): UpdateWorkOrderRequest | null {
  const next = headerPayload(values);
  const changes: Partial<UpdateWorkOrderRequest> = {};
  if (next.number !== current.number) changes.number = next.number;
  if (next.title !== current.title) changes.title = next.title;
  if (next.issuedOn !== current.issuedOn) changes.issuedOn = next.issuedOn;
  if (next.notes !== current.notes) changes.notes = next.notes;
  return Object.keys(changes).length === 0
    ? null
    : { ...changes, expectedVersion: current.version };
}
