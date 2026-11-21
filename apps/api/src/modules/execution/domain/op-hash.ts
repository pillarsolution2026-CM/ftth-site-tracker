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

/**
 * A line without a performer hashes as before ADR-052, when the field did not exist: an op
 * applied then and resent now (its lines parsed with `performer: null`) is still a duplicate.
 */
function withoutNullPerformers(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.lines)) return payload;
  return {
    ...record,
    lines: record.lines.map((line: unknown) => {
      if (line === null || typeof line !== 'object') return line;
      const { performer, ...rest } = line as Record<string, unknown>;
      return performer === null ? rest : line;
    }),
  };
}

/** Fingerprint of an operation: a resend must match it exactly to count as the same operation. */
export function operationHash(op: { kind: string; capturedAt: string; payload: unknown }): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        kind: op.kind,
        capturedAt: op.capturedAt,
        payload: withoutNullPerformers(op.payload),
      }),
    )
    .digest('hex');
}
