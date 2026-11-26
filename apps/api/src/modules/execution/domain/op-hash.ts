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
 * Fields added after the first ops were stored hash only when they carry a value: a line without a
 * performer hashes as before ADR-052, a line without dimensions and a payload without `drawingId`
 * as before ADR-056, a payload without `workDate` as before ADR-057. An op applied then and resent
 * now (parsed with those fields as `null`) is still a duplicate; an op resent with different
 * dimensions, drawing or work date hashes differently (OP_ID_REUSED).
 */
function withoutNullNewFields(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const { drawingId, workDate, ...record } = payload as Record<string, unknown>;
  const base: Record<string, unknown> = {
    ...record,
    ...(drawingId === null ? {} : { drawingId }),
    ...(workDate === null ? {} : { workDate }),
  };
  if (!Array.isArray(base.lines)) return base;
  return {
    ...base,
    lines: base.lines.map((line: unknown) => {
      if (line === null || typeof line !== 'object') return line;
      const { performer, dimensions, ...rest } = line as Record<string, unknown>;
      return {
        ...rest,
        ...(performer === null ? {} : { performer }),
        ...(dimensions === null ? {} : { dimensions }),
      };
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
        payload: withoutNullNewFields(op.payload),
      }),
    )
    .digest('hex');
}
