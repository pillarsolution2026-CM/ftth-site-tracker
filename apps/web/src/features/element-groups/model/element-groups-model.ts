import type { MessageKey } from '@ftth/i18n';
import { GROUP_NAME_MAX } from '@ftth/shared';
import { ApiClientError, errorCodeOf, errorReasonOf } from '@/shared/api/bff-client';

/** Add a main group at the end; blank, too long or already present names are ignored. */
export function addMain(mains: readonly string[], name: string): string[] {
  const clean = name.trim();
  if (clean === '' || clean.length > GROUP_NAME_MAX || mains.includes(clean)) return [...mains];
  return [...mains, clean];
}

export function removeMain(mains: readonly string[], index: number): string[] {
  return mains.filter((_, i) => i !== index);
}

/** Swap with the neighbour (-1 up, +1 down); out of range leaves the list as is. */
export function moveMain(mains: readonly string[], index: number, delta: -1 | 1): string[] {
  const target = index + delta;
  if (index < 0 || index >= mains.length || target < 0 || target >= mains.length) {
    return [...mains];
  }
  const next = [...mains];
  const a = next[index] as string;
  next[index] = next[target] as string;
  next[target] = a;
  return next;
}

export function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** True for a version conflict (409): the admin must reload. */
export function isStaleVersion(error: unknown): boolean {
  return (
    (error instanceof ApiClientError && error.status === 409) ||
    errorReasonOf(error) === 'STALE_VERSION'
  );
}

export function elementGroupsErrorKey(error: unknown): MessageKey {
  return isStaleVersion(error) ? 'elementGroups.stale' : `errors.${errorCodeOf(error)}`;
}
