import { ltr, type MessageKey } from '@ftth/i18n';
import {
  blocksPublishing,
  type DrawingProblemCode,
  type DrawingProblemItem,
  type DrawingProblemView,
} from '@ftth/shared';

export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

/**
 * The sentence that says what is wrong at ONE place, from the values the checks stored on it
 * (ADR-041 `params`: expected box count vs written, slack in metres, the missing role …). null
 * when the place has none (problems stored before ADR-041, or codes with nothing to add). Numbers
 * and codes are isolated so they stay left-to-right inside Arabic text.
 */
export function placeDetail(
  code: DrawingProblemCode,
  item: Pick<DrawingProblemItem, 'params'>,
  t: Translate,
): string | null {
  const p = item.params;
  if (!p) return null;
  switch (code) {
    case 'LABEL_MISSING':
      if (p.role === 'cabinet_info' && p.field === 'box_count') {
        return p.suggested !== undefined
          ? t('design.problems.detail.LABEL_MISSING_BOX_COUNT', { suggested: ltr(p.suggested) })
          : t('design.problems.detail.LABEL_MISSING_BOX_COUNT_NO_SUGGESTION');
      }
      return p.role === undefined
        ? null
        : t('design.problems.detail.LABEL_MISSING', { role: t(`mapping.meaning.role.${p.role}`) });
    case 'LABEL_TYPE_MISMATCH':
      return p.expected !== undefined && p.found !== undefined
        ? t('design.problems.detail.LABEL_TYPE_MISMATCH', {
            expected: ltr(p.expected),
            found: ltr(p.found),
          })
        : null;
    case 'HANDHOLE_TYPE_UNKNOWN':
      return p.found !== undefined
        ? t('design.problems.detail.HANDHOLE_TYPE_UNKNOWN', { found: ltr(p.found) })
        : null;
    case 'BOX_NUMBER_DUPLICATE':
      return p.boxNumber !== undefined && p.cabinet !== undefined
        ? t(
            p.found !== undefined
              ? 'design.problems.detail.BOX_NUMBER_DUPLICATE_FORMS'
              : 'design.problems.detail.BOX_NUMBER_DUPLICATE',
            {
              found: ltr(p.found ?? ''),
              number: ltr(p.boxNumber),
              cabinet: ltr(p.cabinet),
            },
          )
        : null;
    case 'BOX_CABINET_UNKNOWN':
    case 'CABINET_NAME_DUPLICATE':
      return p.cabinet !== undefined
        ? t(`design.problems.detail.${code}`, { cabinet: ltr(p.cabinet) })
        : null;
    case 'CONNECTOR_SIZE_MISSING':
      return t('design.problems.detail.CONNECTOR_SIZE_MISSING');
    case 'CABINET_BOX_COUNT_MISMATCH':
      return p.expected !== undefined && p.found !== undefined
        ? t('design.problems.detail.CABINET_BOX_COUNT_MISMATCH', {
            cabinet: ltr(p.cabinet ?? ''),
            written: ltr(p.expected),
            drawn: ltr(p.found),
          })
        : null;
    case 'SPARE_CORES_MISMATCH':
      return p.expected !== undefined && p.found !== undefined
        ? t('design.problems.detail.SPARE_CORES_MISMATCH', {
            expected: ltr(p.expected),
            found: ltr(p.found),
            mainCores: ltr(p.mainCores ?? ''),
          })
        : null;
    case 'CABLE_SLACK_TOO_SHORT':
    case 'CABLE_SLACK_TOO_LONG':
      return p.cableLengthM !== undefined && p.bundleLengthM !== undefined && p.slackM !== undefined
        ? t(`design.problems.detail.${code}`, {
            cable: ltr(p.cableLengthM),
            bundle: ltr(p.bundleLengthM),
            slack: ltr(p.slackM),
          })
        : null;
    default:
      return null;
  }
}

/** Codes whose `suggestedLayer` is where to TYPE the missing text, not where to move the item. */
export const TYPE_ON_LAYER_CODES: readonly DrawingProblemCode[] = [
  'LABEL_MISSING',
  'HANDHOLE_TYPE_MISSING',
];

/** Blocking problems apart from warnings (ADR-041); order kept. */
export function splitProblems(problems: readonly DrawingProblemView[]): {
  blocking: DrawingProblemView[];
  warnings: DrawingProblemView[];
} {
  return {
    blocking: problems.filter((p) => blocksPublishing(p.code)),
    warnings: problems.filter((p) => !blocksPublishing(p.code)),
  };
}
