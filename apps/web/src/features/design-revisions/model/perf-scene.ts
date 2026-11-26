import type { DrawingView, DrawingViewEntity } from '@ftth/shared';

/**
 * A large synthetic drawing for the performance tests (round 2, items 26 / 30): thousands of
 * lines, polylines and circles spread over a square, from a fixed seed so every run is the same.
 */
export function perfView(count: number, side = 10_000): DrawingView {
  let seed = 12345;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const entities: DrawingViewEntity[] = [];
  for (let i = 0; i < count; i++) {
    const x = next() * side;
    const y = next() * side;
    const kind = i % 10;
    const base = { handle: `H${i}`, layer: i % 3, color: null, texts: [] };
    if (kind < 5) {
      entities.push({
        ...base,
        kind: 'LINE',
        paths: [[x, y, x + (next() - 0.5) * 80, y + (next() - 0.5) * 80]],
      });
    } else if (kind < 8) {
      const path: number[] = [x, y];
      let px = x;
      let py = y;
      for (let k = 0; k < 20; k++) {
        px += (next() - 0.4) * 30;
        py += (next() - 0.5) * 30;
        path.push(px, py);
      }
      entities.push({ ...base, kind: 'LWPOLYLINE', paths: [path] });
    } else {
      const r = 3 + next() * 12;
      const path: number[] = [];
      for (let k = 0; k <= 32; k++) {
        const a = (k / 32) * Math.PI * 2;
        path.push(x + r * Math.cos(a), y + r * Math.sin(a));
      }
      entities.push({ ...base, kind: 'CIRCLE', paths: [path] });
    }
  }
  return {
    version: 1,
    cadFileId: '33333333-3333-4333-8333-333333333333',
    extents: { minX: 0, minY: 0, maxX: side, maxY: side },
    layers: [
      { name: 'Route', color: '#ff0000', visible: true },
      { name: 'Sap', color: '#00aa00', visible: true },
      { name: 'CABINET', color: '#0000ff', visible: true },
    ],
    entities,
    truncated: false,
  };
}
