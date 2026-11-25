import type { MessageKey } from '@ftth/i18n';
import type { ExecutionUpdate, LineDimensions } from '@ftth/shared';

/**
 * What to show as the element of an update (ADR-056): a «التخطيط» update has no feature
 * (`featureId = null`, `drawingId` set), so it shows «التخطيط»; any other shows its feature type.
 */
export function updateElementLabelKey(
  update: Pick<ExecutionUpdate, 'featureId' | 'featureType'>,
): MessageKey {
  if (update.featureId === null || update.featureType === null) return 'qc.planning';
  return `featureType.${update.featureType}`;
}

export function isPlanningUpdate(update: Pick<ExecutionUpdate, 'featureId'>): boolean {
  return update.featureId === null;
}

/** «L × W × D» as plain text (numbers only; the caller wraps it LTR). */
export function dimensionsText(dimensions: LineDimensions): string {
  return `${dimensions.lengthM} × ${dimensions.widthM} × ${dimensions.depthM}`;
}
