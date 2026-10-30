import { createHash } from 'node:crypto';

/** JSON with object keys sorted at every level, so equal values always hash the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Fingerprint of an operation: a resend must match it exactly to count as the same operation. */
export function operationHash(op: { kind: string; capturedAt: string; payload: unknown }): string {
  return createHash('sha256')
    .update(canonicalJson({ kind: op.kind, capturedAt: op.capturedAt, payload: op.payload }))
    .digest('hex');
}
