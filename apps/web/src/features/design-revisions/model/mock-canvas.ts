import { vi } from 'vitest';

/** A 2D context whose methods are spies; properties are plain fields. For tests only. */
export function createMockContext() {
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: '',
    lineCap: '',
    font: '',
    textBaseline: '',
    textAlign: '',
    globalAlpha: 1,
    setTransform: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    setLineDash: vi.fn(),
    drawImage: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: text.length * 7 })),
  };
  return ctx;
}

export type MockContext = ReturnType<typeof createMockContext>;

/** Path2D does not exist in jsdom: a stand-in that counts its segments. */
export class FakePath2D {
  segments = 0;
  moveTo() {
    this.segments++;
  }
  lineTo() {
    this.segments++;
  }
}
