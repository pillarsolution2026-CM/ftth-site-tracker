import { describe, expect, it } from 'vitest';
import { applyInputs, EMPTY_PREVIEW } from './drawing-preview';
import { buildScene } from './drawing-scene';
import { testView } from './drawing-test-view';
import {
  objectTypes,
  propertyEdits,
  propertyRows,
  VARIES,
  type PropertiesInput,
} from './properties';

const scene = buildScene(
  testView({
    entities: [
      ...testView().entities,
      {
        handle: 'K1',
        layer: 2,
        color: null,
        kind: 'INSERT',
        paths: [[60, 0, 62, 0]],
        texts: [{ x: 61, y: 3, height: 1, rotation: 0, text: 'S1' }],
        insert: { x: 61, y: 1, rotation: 30, scaleX: 2, scaleY: 2, name: 'SAP' },
      },
    ],
  }),
);
// 0 A polyline (Route), 1 B line (Route), 2 A1 insert (old view), 3 T1 text, 4 H1, 5 K1 insert.

const input = (indexes: number[], vertex = 0): PropertiesInput => ({
  scene,
  preview: EMPTY_PREVIEW,
  indexes,
  layers: ['Route', 'Sap'],
  vertex,
});
const row = (rows: ReturnType<typeof propertyRows>, id: string) => rows.find((r) => r.id === id);

describe('AutoCAD Properties palette rows (owner 2026-11-26)', () => {
  it('a line: General then its Geometry, computed values read-only', () => {
    const rows = propertyRows(input([1]));
    expect(rows.map((r) => r.id)).toEqual([
      'color',
      'layer',
      'linetype',
      'ltscale',
      'lineweight',
      'transparency',
      'startX',
      'startY',
      'endX',
      'endY',
      'deltaX',
      'deltaY',
      'length',
      'angle',
    ]);
    expect(row(rows, 'layer')?.value).toBe('Route');
    expect(row(rows, 'length')).toMatchObject({
      value: '50.0000',
      editor: null,
      reason: 'computed',
    });
    expect(row(rows, 'ltscale')).toMatchObject({ editor: null, reason: 'notInView' });
  });

  it('several objects: only General, *VARIES* where they differ; the type list counts', () => {
    const rows = propertyRows(input([1, 3]));
    expect(rows).toHaveLength(6);
    expect(row(rows, 'layer')?.value).toBe(VARIES);
    expect(objectTypes(scene, EMPTY_PREVIEW, [0, 1, 3])).toEqual([
      { name: 'Polyline', count: 1 },
      { name: 'Line', count: 1 },
      { name: 'Text', count: 1 },
    ]);
  });

  it('a block reference: name, position, rotation and attributes; an old view says why', () => {
    const rows = propertyRows(input([5]));
    expect(row(rows, 'name')).toMatchObject({ value: 'SAP', editor: null });
    expect(row(rows, 'positionX')?.value).toBe('61.0000');
    expect(row(rows, 'rotation')?.value).toBe('30.0000');
    expect(row(rows, 'attr:0')).toMatchObject({ value: 'S1', editor: { kind: 'text' } });
    const old = propertyRows(input([2]));
    expect(row(old, 'positionX')).toMatchObject({ value: '—', reason: 'notInView' });
  });

  it('a text: contents editable, height and rotation read-only', () => {
    const rows = propertyRows(input([3]));
    expect(row(rows, 'contents')).toMatchObject({ value: 'F 36 C', editor: { kind: 'text' } });
    expect(row(rows, 'height')).toMatchObject({ reason: 'noCorrection' });
  });
});

describe('Properties cells become corrections', () => {
  it('layer, colour, line weight', () => {
    expect(propertyEdits(input([1, 3]), 'layer', 'Sap')).toEqual([
      { kind: 'move_layer', handle: 'B', toLayer: 'Sap' },
      { kind: 'move_layer', handle: 'T1', toLayer: 'Sap' },
    ]);
    expect(propertyEdits(input([1]), 'layer', 'Hidden')).toBeNull();
    expect(propertyEdits(input([1]), 'color', '#ff0000')).toEqual([
      { kind: 'set_style', handle: 'B', color: '#ff0000', linetype: null, lineweight: null },
    ]);
    expect(propertyEdits(input([1]), 'lineweight', '0.3')?.[0]).toMatchObject({ lineweight: 0.3 });
  });

  it('line ends and polyline vertices are set_curve; Closed closes it', () => {
    expect(propertyEdits(input([1]), 'startX', '40')).toEqual([
      {
        kind: 'set_curve',
        handle: 'B',
        points: [
          [40, 25],
          [100, 25],
        ],
        closed: false,
      },
    ]);
    expect(propertyEdits(input([0], 1), 'vertexY', '5')?.[0]).toMatchObject({
      points: [
        [0, 0],
        [50, 5],
        [50, 25],
      ],
    });
    expect(propertyEdits(input([0]), 'closed', 'yes')?.[0]).toMatchObject({ closed: true });
    expect(propertyEdits(input([1]), 'startX', 'abc')).toBeNull();
  });

  it('text contents and position, block rotation and attribute', () => {
    expect(propertyEdits(input([3]), 'contents', 'F 48 C')).toEqual([
      { kind: 'set_text', handle: 'T1', text: 'F 48 C' },
    ]);
    expect(propertyEdits(input([3]), 'positionX', '35')).toEqual([
      { kind: 'move_item', handle: 'T1', dx: 5, dy: 0 },
    ]);
    expect(propertyEdits(input([5]), 'rotation', '90')).toEqual([
      { kind: 'rotate_item', handle: 'K1', x: 61, y: 1, angle: 60 },
    ]);
    expect(propertyEdits(input([5]), 'attr:0', 'S2')).toEqual([
      { kind: 'set_attribute', handle: 'K1', from: 'S1', to: 'S2' },
    ]);
  });

  it('reads the unsaved edits: a moved text shows its new position', () => {
    const shown = applyInputs(
      scene,
      EMPTY_PREVIEW,
      [{ kind: 'move_item', handle: 'T1', dx: 5, dy: 0 }],
      2.5,
    );
    const rows = propertyRows({ ...input([3]), preview: shown });
    expect(row(rows, 'positionX')?.value).toBe('35.0000');
  });
});
