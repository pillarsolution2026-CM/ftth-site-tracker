import { ltr, type MessageKey } from '@ftth/i18n';
import {
  BOX_TYPE_WRITE_REFUSALS,
  boxTypeLabel,
  drawingAtOf,
  type BoxShape,
  type BoxShapeGallery,
  type BoxTypeIssue,
  type BoxTypeState,
  type DesignFeature,
  type SetBoxTypesRequest,
  type WorkOrderItem,
} from '@ftth/shared';
import type { ClientErrorCode } from '@/shared/api/bff-client';

/** 409/422 with a known box-type refusal gets its own message; else the generic one. */
export function boxTypeErrorKey(code: ClientErrorCode, reason: string | null): MessageKey {
  if (
    (code === 'CONFLICT' || code === 'VALIDATION_FAILED') &&
    reason !== null &&
    (BOX_TYPE_WRITE_REFUSALS as readonly string[]).includes(reason)
  ) {
    return `design.boxTypes.error.${reason as (typeof BOX_TYPE_WRITE_REFUSALS)[number]}`;
  }
  return `errors.${code}`;
}

/** A short name for a shape signature, so a card and an issue can be matched by eye. */
export function shapeShortId(shape: string): string {
  return shape === 'none' ? 'none' : (shape.split('-')[1] ?? shape).slice(0, 6);
}

/** DOM id of the card of a shape (the problems page and the checklist jump to it). */
export function shapeCardId(shape: string): string {
  return `box-shape-${shape}`;
}

/** DOM id of the line picker of a shape. */
export function shapePickerId(shape: string): string {
  return `box-type-pick-${shape}`;
}

/** Message key and params of one box-type issue of the checklist / the problems page / a refusal. */
export function boxTypeIssueMessage(issue: BoxTypeIssue): {
  key: MessageKey;
  params: Record<string, string>;
} {
  return {
    key: `design.boxTypes.issue.${issue.code}`,
    params: {
      shape: ltr(issue.shape === null ? '—' : shapeShortId(issue.shape)),
      count: ltr(issue.boxCount ?? '—'),
    },
  };
}

/** The text of a work-order line in the picker: code (LTR) and the description, cut to 80. */
export function lineOptionText(line: Pick<WorkOrderItem, 'code' | 'description'>): string {
  return `${ltr(line.code)} ${boxTypeLabel(line.description)}`;
}

/** shape → work-order line id in force (cleared shapes are not in `active`). */
export function activeByShape(state: BoxTypeState | undefined): Map<string, string> {
  return new Map(
    (state?.active ?? []).flatMap((choice) =>
      choice.workOrderLineId === null ? [] : [[choice.shape, choice.workOrderLineId] as const],
    ),
  );
}

/**
 * The batch for «حفظ»: the shapes whose picker differs from what is in force (an empty pick clears).
 * `draft` holds only what the PM touched; a shape not in it keeps its value.
 */
export function dirtyChoices(
  shapes: readonly BoxShape[],
  active: ReadonlyMap<string, string>,
  draft: ReadonlyMap<string, string>,
): SetBoxTypesRequest['choices'] {
  const out: SetBoxTypesRequest['choices'] = [];
  for (const shape of shapes) {
    const picked = draft.get(shape.shape);
    if (picked === undefined) continue;
    const inForce = active.get(shape.shape) ?? '';
    if (picked !== inForce) out.push({ shape: shape.shape, workOrderLineId: picked || null });
  }
  return out;
}

/**
 * «استخدم اختيارات النسخة السابقة»: the previous version's choices for shapes that are in this
 * gallery and not already set to the same line. Empty when there is nothing to offer.
 */
export function previousChoices(
  state: BoxTypeState | undefined,
  gallery: BoxShapeGallery | null,
  active: ReadonlyMap<string, string>,
): SetBoxTypesRequest['choices'] {
  if (!state?.previousVersion || !gallery) return [];
  const present = new Set(gallery.shapes.map((shape) => shape.shape));
  return state.previousVersion.choices
    .filter(
      (choice) => present.has(choice.shape) && active.get(choice.shape) !== choice.workOrderLineId,
    )
    .map((choice) => ({ shape: choice.shape, workOrderLineId: choice.workOrderLineId }));
}

/** A box's type text on the drawing (ADR-043). */
export interface BoxLabelInput {
  x: number;
  y: number;
  /** built: frozen on the draft; pending: chosen but not built yet; none: no type. */
  kind: 'built' | 'pending' | 'none';
  code: string | null;
  label: string | null;
}

interface ReadingBits {
  shape: string | null;
  boxType: { workOrderLineId: string; code: string | null; label: string | null } | null;
}

function readingOf(feature: DesignFeature): ReadingBits {
  const reading = feature.attrs.reading;
  const record = (reading && typeof reading === 'object' ? reading : {}) as Record<string, unknown>;
  const boxType = record.boxType as ReadingBits['boxType'] | null | undefined;
  return {
    shape: typeof record.shape === 'string' ? record.shape : null,
    boxType:
      boxType && typeof boxType === 'object' && typeof boxType.workOrderLineId === 'string'
        ? boxType
        : null,
  };
}

/**
 * One text per box that has a drawn centre (`attrs.drawingAt`): the type frozen on the draft, or
 * the live choice not built yet (when it differs from the frozen one), or none. `live` is
 * undefined while the live state is unknown: only the frozen type is shown then.
 */
export function boxLabelInputs(
  boxes: readonly DesignFeature[],
  live: ReadonlyMap<string, string> | undefined,
  lines: ReadonlyMap<string, Pick<WorkOrderItem, 'code' | 'description'>>,
): BoxLabelInput[] {
  const out: BoxLabelInput[] = [];
  for (const box of boxes) {
    const at = drawingAtOf(box.attrs);
    if (!at) continue;
    const { shape, boxType } = readingOf(box);
    const base = { x: at.x, y: at.y };
    const liveLine = live && shape !== null ? (live.get(shape) ?? null) : undefined;
    if (liveLine !== undefined && liveLine !== (boxType?.workOrderLineId ?? null)) {
      const line = liveLine === null ? undefined : lines.get(liveLine);
      if (line) {
        out.push({
          ...base,
          kind: 'pending',
          code: line.code,
          label: boxTypeLabel(line.description),
        });
        continue;
      }
      if (liveLine === null && boxType === null) {
        out.push({ ...base, kind: 'none', code: null, label: null });
        continue;
      }
    }
    if (boxType) {
      out.push({ ...base, kind: 'built', code: boxType.code, label: boxType.label });
    } else {
      out.push({ ...base, kind: 'none', code: null, label: null });
    }
  }
  return out;
}

/** Preview path (flat x,y pairs in unit space, y up) as SVG `points` (y flipped). */
export function previewPoints(path: readonly number[]): string {
  const points: string[] = [];
  for (let i = 0; i + 1 < path.length; i += 2) {
    points.push(`${path[i]},${-(path[i + 1] as number)}`);
  }
  return points.join(' ');
}
