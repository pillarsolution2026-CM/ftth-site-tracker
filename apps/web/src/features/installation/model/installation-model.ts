import { ltr, type MessageKey } from '@ftth/i18n';
import {
  INSTALLATION_WRITE_REFUSALS,
  TrenchLengthSchema,
  installationChangedSince,
  metresToMm,
  mmToMetres,
  type FrozenInstallation,
  type InstallationIssue,
  type InstallationState,
  type TrenchMark,
} from '@ftth/shared';
import type { ClientErrorCode } from '@/shared/api/bff-client';

/** 409/422 with a known installation refusal gets its own message; else the generic one. */
export function installationErrorKey(code: ClientErrorCode, reason: string | null): MessageKey {
  if (
    (code === 'CONFLICT' || code === 'VALIDATION_FAILED') &&
    reason !== null &&
    (INSTALLATION_WRITE_REFUSALS as readonly string[]).includes(reason)
  ) {
    return `design.installation.error.${reason as (typeof INSTALLATION_WRITE_REFUSALS)[number]}`;
  }
  return `errors.${code}`;
}

const EASTERN_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Digits typed with an Arabic keyboard and a decimal comma / Arabic separator are accepted. */
export function normaliseLengthText(text: string): string {
  return text
    .trim()
    .replace(/[٠-٩]/g, (digit) => String(EASTERN_DIGITS.indexOf(digit)))
    .replace(/[,٫]/g, '.');
}

export type TrenchLengthResult = { ok: true; metres: string } | { ok: false };

/** The typed trench length as the contract wants it (metres, > 0, 3 decimals), or not ok. */
export function parseTrenchLength(text: string): TrenchLengthResult {
  const parsed = TrenchLengthSchema.safeParse(normaliseLengthText(text));
  return parsed.success ? { ok: true, metres: parsed.data } : { ok: false };
}

export const activeMarks = (state: InstallationState | undefined): TrenchMark[] =>
  (state?.marks ?? []).filter((mark) => mark.withdrawnAt === null);

/** Σ marked metres per route handle (exact, millimetres in bigint), only marks in force. */
export function markedByRoute(marks: readonly TrenchMark[]): Map<string, string> {
  const sums = new Map<string, bigint>();
  for (const mark of marks) {
    if (mark.withdrawnAt !== null) continue;
    sums.set(mark.routeHandle, (sums.get(mark.routeHandle) ?? 0n) + metresToMm(mark.lengthM));
  }
  return new Map([...sums].map(([handle, mm]) => [handle, mmToMetres(mm)]));
}

/** The live answer and marks differ from what the draft froze: the PM must rebuild. */
export function needsRebuild(
  frozen: FrozenInstallation | null,
  state: InstallationState | undefined,
): boolean {
  if (!state || !state.asked) return false;
  return installationChangedSince(frozen, {
    answerId: state.answer?.id ?? null,
    activeMarkIds: activeMarks(state).map((mark) => mark.id),
  });
}

/** Message key and params of one installation issue of the checklist / refusal. */
export function issueMessage(issue: InstallationIssue): {
  key: MessageKey;
  params: Record<string, string>;
} {
  return {
    key: `design.installation.issue.${issue.code}`,
    params: {
      route: ltr(issue.routeHandle ?? '—'),
      marked: ltr(issue.markedM ?? '—'),
      length: ltr(issue.routeLengthM ?? '—'),
    },
  };
}
