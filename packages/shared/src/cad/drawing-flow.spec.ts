import { describe, expect, it } from 'vitest';
import {
  DRAWING_FLOW_ALL_ON,
  DRAWING_FLOW_DEFAULT,
  DrawingFlowSwitchSchema,
  drawingFlowFromEnv,
} from './drawing-flow.js';

describe('drawing-flow switches (ADR-045)', () => {
  it('has all steps on in ALL_ON and all off in the default', () => {
    expect(DRAWING_FLOW_ALL_ON).toEqual({
      installationQuestion: true,
      boxTypes: true,
      readingTotals: true,
    });
    expect(DRAWING_FLOW_DEFAULT).toEqual({
      installationQuestion: false,
      boxTypes: false,
      readingTotals: false,
    });
  });

  it('builds the flow from the env values, each switch on its own', () => {
    expect(
      drawingFlowFromEnv({
        DRAWING_INSTALLATION_QUESTION: 'on',
        DRAWING_BOX_TYPES: 'on',
        DRAWING_READING_TOTALS: 'on',
      }),
    ).toEqual(DRAWING_FLOW_ALL_ON);
    expect(
      drawingFlowFromEnv({
        DRAWING_INSTALLATION_QUESTION: 'off',
        DRAWING_BOX_TYPES: 'off',
        DRAWING_READING_TOTALS: 'off',
      }),
    ).toEqual(DRAWING_FLOW_DEFAULT);
    expect(
      drawingFlowFromEnv({
        DRAWING_INSTALLATION_QUESTION: 'off',
        DRAWING_BOX_TYPES: 'on',
        DRAWING_READING_TOTALS: 'off',
      }),
    ).toEqual({ installationQuestion: false, boxTypes: true, readingTotals: false });
  });

  it('defaults the env switch to off and accepts only on / off', () => {
    expect(DrawingFlowSwitchSchema.parse(undefined)).toBe('off');
    expect(DrawingFlowSwitchSchema.parse('on')).toBe('on');
    for (const bad of ['ON', 'true', '1', '', 'yes']) {
      expect(DrawingFlowSwitchSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('the frozen presets cannot be changed', () => {
    expect(Object.isFrozen(DRAWING_FLOW_ALL_ON)).toBe(true);
    expect(Object.isFrozen(DRAWING_FLOW_DEFAULT)).toBe(true);
  });
});
