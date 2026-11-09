import type { DrawingView, DrawingViewEntity } from '@ftth/shared';

export const FILE_ID = '33333333-3333-4333-8333-333333333333';

/** A small drawing for tests: two routes, a cabinet insert, a label, a hidden layer. */
export function testView(overrides: Partial<DrawingView> = {}): DrawingView {
  const entity = (e: Partial<DrawingViewEntity> & { handle: string }): DrawingViewEntity => ({
    layer: 0,
    color: null,
    kind: 'LINE',
    paths: [],
    texts: [],
    ...e,
  });
  return {
    version: 1,
    cadFileId: FILE_ID,
    extents: { minX: 0, minY: 0, maxX: 100, maxY: 50 },
    layers: [
      { name: 'Route', color: '#ff0000', visible: true },
      { name: 'Sap', color: '#00aa00', visible: true },
      { name: 'CABINET', color: '#0000ff', visible: true },
      { name: 'Hidden', color: '#888888', visible: false },
    ],
    entities: [
      entity({ handle: 'A', kind: 'LWPOLYLINE', paths: [[0, 0, 50, 0, 50, 25]] }),
      entity({ handle: 'B', kind: 'LINE', paths: [[50, 25, 100, 25]], color: '#123456' }),
      entity({
        handle: 'A1',
        layer: 1,
        kind: 'INSERT',
        paths: [[20, 20, 22, 20, 22, 22, 20, 22, 20, 20]],
      }),
      entity({
        handle: 'T1',
        layer: 1,
        kind: 'TEXT',
        texts: [{ x: 30, y: 30, height: 2.5, rotation: 0, text: 'F 36 C' }],
      }),
      entity({ handle: 'H1', layer: 3, kind: 'LINE', paths: [[0, 40, 100, 40]] }),
    ],
    truncated: false,
    ...overrides,
  };
}

export function entityAt(view: DrawingView, index: number): DrawingViewEntity {
  const found = view.entities[index];
  if (!found) throw new Error(`No entity ${index}`);
  return found;
}
