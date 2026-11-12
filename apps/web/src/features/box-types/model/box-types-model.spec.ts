import type { BoxShape, BoxShapeGallery, BoxTypeState, DesignFeature } from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import {
  activeByShape,
  boxLabelInputs,
  boxTypeErrorKey,
  boxTypeIssueMessage,
  dirtyChoices,
  lineOptionText,
  previewPoints,
  previousChoices,
  shapeShortId,
} from './box-types-model';

const A = `v1-${'a'.repeat(64)}`;
const B = `v1-${'b'.repeat(64)}`;
const LINE_1 = '11111111-1111-4111-8111-111111111111';
const LINE_2 = '22222222-2222-4222-8222-222222222222';
const FILE = '33333333-3333-4333-8333-333333333333';
const USER = { id: '44444444-4444-4444-8444-444444444444', name: 'Mona' };

function shape(signature: string, count = 5): BoxShape {
  return {
    shape: signature,
    source: 'block',
    count,
    blockNames: ['box c'],
    sampleHandles: ['H1'],
    preview: null,
  };
}

function state(
  active: Record<string, string>,
  previous: Record<string, string> | null = null,
): BoxTypeState {
  return {
    cadFileId: FILE,
    drawingKind: 'secondary',
    applies: true,
    active: Object.entries(active).map(([key, line], index) => ({
      id: `55555555-5555-4555-8555-55555555555${index}`,
      cadFileId: FILE,
      shape: key,
      workOrderLineId: line,
      createdBy: USER,
      createdAt: '2026-11-12T10:00:00.000Z',
    })),
    history: [],
    previousVersion: previous
      ? {
          cadFileId: FILE,
          choices: Object.entries(previous).map(([key, line]) => ({
            shape: key,
            workOrderLineId: line,
          })),
        }
      : null,
  };
}

function box(attrs: Record<string, unknown>): DesignFeature {
  return {
    id: '66666666-6666-4666-8666-666666666666',
    revisionId: '77777777-7777-4777-8777-777777777777',
    featureType: 'box',
    code: '1-1',
    layer: 'BOX',
    blockName: 'box c',
    sourceKind: 'insert',
    sourceHandle: 'H1',
    lengthM: null,
    anchor: { x: 0, y: 0 },
    attrs,
  } as DesignFeature;
}

describe('box types model', () => {
  it('maps refusals to their own message and the rest to the generic one', () => {
    expect(boxTypeErrorKey('CONFLICT', 'NOT_BUILT')).toBe('design.boxTypes.error.NOT_BUILT');
    expect(boxTypeErrorKey('VALIDATION_FAILED', 'LINE_NOT_IN_WORK_ORDER')).toBe(
      'design.boxTypes.error.LINE_NOT_IN_WORK_ORDER',
    );
    expect(boxTypeErrorKey('CONFLICT', 'SOMETHING')).toBe('errors.CONFLICT');
    expect(boxTypeErrorKey('FORBIDDEN', null)).toBe('errors.FORBIDDEN');
  });

  it('names a shape by a short id and isolates it in issue messages', () => {
    expect(shapeShortId(A)).toBe('aaaaaa');
    expect(shapeShortId('none')).toBe('none');
    const message = boxTypeIssueMessage({
      code: 'BOX_TYPE_UNSET',
      shape: A,
      boxCount: 197,
      workOrderLineId: null,
    });
    expect(message.key).toBe('design.boxTypes.issue.BOX_TYPE_UNSET');
    expect(message.params.shape).toContain('aaaaaa');
    expect(message.params.count).toContain('197');
  });

  it('writes the line as code then the description cut to 80 characters', () => {
    const text = lineOptionText({ code: 'BX-8', description: 'x'.repeat(200) });
    expect(text).toContain('BX-8');
    expect(text.endsWith('…')).toBe(true);
    expect(text.length).toBeLessThan(100);
  });

  it('batches only the shapes whose picker differs, and an empty pick clears', () => {
    const shapes = [shape(A), shape(B)];
    const active = activeByShape(state({ [A]: LINE_1 }));
    expect(dirtyChoices(shapes, active, new Map())).toEqual([]);
    expect(dirtyChoices(shapes, active, new Map([[A, LINE_1]]))).toEqual([]);
    expect(
      dirtyChoices(
        shapes,
        active,
        new Map([
          [A, ''],
          [B, LINE_2],
        ]),
      ),
    ).toEqual([
      { shape: A, workOrderLineId: null },
      { shape: B, workOrderLineId: LINE_2 },
    ]);
    // Picking nothing for a shape that has nothing is not a change.
    expect(dirtyChoices(shapes, active, new Map([[B, '']]))).toEqual([]);
  });

  it('offers the previous version’s choices for shapes in the gallery that differ', () => {
    const gallery = { version: 1, boxCount: 10, shapeCount: 2, shapes: [shape(A), shape(B)] };
    const full = { ...gallery, boxesWithoutShape: 0 } satisfies BoxShapeGallery;
    const previous = state({}, { [A]: LINE_1, [`v1-${'c'.repeat(64)}`]: LINE_2 });
    expect(previousChoices(previous, full, new Map())).toEqual([
      { shape: A, workOrderLineId: LINE_1 },
    ]);
    expect(previousChoices(previous, full, new Map([[A, LINE_1]]))).toEqual([]);
    expect(previousChoices(state({}), full, new Map())).toEqual([]);
    expect(previousChoices(previous, null, new Map())).toEqual([]);
  });

  it('labels boxes: built, not built yet, and no type', () => {
    const lines = new Map([[LINE_2, { code: 'BX-4', description: 'Box 4 ways' }]]);
    const frozen = box({
      drawingAt: { x: 1, y: 2 },
      reading: {
        shape: A,
        boxType: { workOrderLineId: LINE_1, code: 'BX-8', label: 'Box 8 ways' },
      },
    });
    const unbuilt = box({ drawingAt: { x: 3, y: 4 }, reading: { shape: B, boxType: null } });
    const bare = box({ drawingAt: { x: 5, y: 6 }, reading: { shape: `v1-${'d'.repeat(64)}` } });
    const unplaced = box({ reading: { shape: A } });
    const live = new Map([
      [A, LINE_1],
      [B, LINE_2],
    ]);
    expect(boxLabelInputs([frozen, unbuilt, bare, unplaced], live, lines)).toEqual([
      { x: 1, y: 2, kind: 'built', code: 'BX-8', label: 'Box 8 ways' },
      { x: 3, y: 4, kind: 'pending', code: 'BX-4', label: 'Box 4 ways' },
      { x: 5, y: 6, kind: 'none', code: null, label: null },
    ]);
    // Without the live state only what the draft froze is shown.
    expect(boxLabelInputs([frozen, unbuilt], undefined, lines).map((l) => l.kind)).toEqual([
      'built',
      'none',
    ]);
  });

  it('flips the y axis of a preview path for SVG', () => {
    expect(previewPoints([0.5, 0.25, -0.5, -0.25])).toBe('0.5,-0.25 -0.5,0.25');
  });
});
