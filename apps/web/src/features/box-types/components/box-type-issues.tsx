'use client';

import { ltr } from '@ftth/i18n';
import type { BoxShapeGallery, BoxTypeIssue } from '@ftth/shared';
import { Button } from '@/shared/ui/button';
import { useI18n } from '@/shared/i18n/locale-provider';
import { boxTypeIssueMessage, shapePickerId } from '../model/box-types-model';

/** Jump to the picker of a shape in «أنواع البوكسات» (same page). */
export function focusShapePicker(shape: string) {
  const picker = document.getElementById(shapePickerId(shape));
  if (!picker) return;
  picker.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  picker.focus();
}

/**
 * The issues of the box-type check (ADR-043), each with an icon and a sentence; one about a shape
 * has «اختر البند» (opens the picker of that shape) and «اعرض على الرسمة» (a sample box).
 */
export function BoxTypeIssueList({
  issues,
  issueCount,
  gallery,
  onShowHandle,
  className = '',
}: {
  issues: readonly BoxTypeIssue[];
  issueCount: number;
  gallery: BoxShapeGallery | null;
  /** Zoom the drawing viewer to a box; omitted when there is no viewer. */
  onShowHandle?: ((handle: string) => void) | undefined;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <ul className={`flex w-full flex-col gap-2 text-sm ${className}`}>
      {issues.map((issue, index) => {
        const message = boxTypeIssueMessage(issue);
        const sample = issue.shape
          ? gallery?.shapes.find((shape) => shape.shape === issue.shape)?.sampleHandles[0]
          : undefined;
        const canChoose =
          issue.shape !== null && gallery?.shapes.some((s) => s.shape === issue.shape);
        return (
          <li
            key={`${issue.code}-${issue.shape ?? ''}-${index}`}
            className="flex flex-wrap items-center gap-2"
          >
            <span aria-hidden="true">⚠</span>
            <span>{t(message.key, message.params)}</span>
            {canChoose && issue.shape ? (
              <Button variant="outline" onClick={() => focusShapePicker(issue.shape as string)}>
                {t('design.boxTypes.choose')}
              </Button>
            ) : null}
            {sample && onShowHandle ? (
              <Button variant="outline" onClick={() => onShowHandle(sample)}>
                {t('design.boxTypes.showOnDrawing')}
              </Button>
            ) : null}
          </li>
        );
      })}
      {issueCount > issues.length ? (
        <li>
          …{' '}
          {t('design.boxTypes.moreIssues', {
            count: ltr(issueCount - issues.length),
          })}
        </li>
      ) : null}
    </ul>
  );
}
