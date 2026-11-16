import { z } from 'zod';

/**
 * Drawing-flow switches (ADR-045, owner 2026-11-16). The owner dropped three steps of the drawing
 * upload flow: no quantity takeoff from the drawing and no comparison with the work-order BOQ; the
 * element → BOQ line link is chosen by the supervisor when recording work. The steps are switched
 * OFF, not deleted, so they can come back by turning the switch on:
 * - `installationQuestion`: the General's «سحب ولا حفر» question and trench marks (ADR-042 part D);
 * - `boxTypes`: a work-order line per box shape on the Secondary (ADR-043 part E). A Secondary
 *   mapped without text roles (`READING_ROLES_MISSING`) still blocks publishing: that is a reading
 *   error, not a box-type choice;
 * - `readingTotals`: the drawing totals («ما قرأته الرسمة», `counts.reading`) shown to the PM.
 */
export interface DrawingFlow {
  installationQuestion: boolean;
  boxTypes: boolean;
  readingTotals: boolean;
}

/** Everything on: the behaviour before ADR-045. */
export const DRAWING_FLOW_ALL_ON: Readonly<DrawingFlow> = Object.freeze({
  installationQuestion: true,
  boxTypes: true,
  readingTotals: true,
});

/** The owner's choice (ADR-045): all three steps off. */
export const DRAWING_FLOW_DEFAULT: Readonly<DrawingFlow> = Object.freeze({
  installationQuestion: false,
  boxTypes: false,
  readingTotals: false,
});

/** `on` / `off` env value; anything else fails the startup config check. */
export const DrawingFlowSwitchSchema = z.enum(['on', 'off']).default('off');

/** The switches from the API env (`DRAWING_INSTALLATION_QUESTION`, `DRAWING_BOX_TYPES`, …). */
export function drawingFlowFromEnv(env: {
  DRAWING_INSTALLATION_QUESTION: 'on' | 'off';
  DRAWING_BOX_TYPES: 'on' | 'off';
  DRAWING_READING_TOTALS: 'on' | 'off';
}): DrawingFlow {
  return {
    installationQuestion: env.DRAWING_INSTALLATION_QUESTION === 'on',
    boxTypes: env.DRAWING_BOX_TYPES === 'on',
    readingTotals: env.DRAWING_READING_TOTALS === 'on',
  };
}
