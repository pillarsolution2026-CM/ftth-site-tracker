import { z } from 'zod';

/**
 * ADR-040: every work order has exactly one General (رئيسي: handholes, joints, the feeder cable to
 * every cabinet) and one Secondary (ثانوي: from each cabinet to the building boxes). A CAD file
 * gets its kind at upload; the kind never changes.
 */
export const DRAWING_KINDS = ['general', 'secondary'] as const;
export const DrawingKindSchema = z.enum(DRAWING_KINDS);
export type DrawingKind = z.infer<typeof DrawingKindSchema>;

/** The other drawing of the pair. */
export function otherDrawingKind(kind: DrawingKind): DrawingKind {
  return kind === 'general' ? 'secondary' : 'general';
}
