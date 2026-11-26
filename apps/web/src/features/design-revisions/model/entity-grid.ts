import type { DrawingScene } from './drawing-scene';

/**
 * A spatial index of the drawing (round 2, items 26 / 30): the entities' boxes bucketed in a
 * uniform grid, so the pointer's hit test and object snaps look at the few objects near it, not at
 * every object of the drawing. Built once per scene (and cached); entities that moved or changed
 * shape in the preview are not in it — callers add those from the preview.
 */

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** An entity that covers more cells than this is kept in a short list scanned by every query. */
const MAX_CELLS_PER_ENTITY = 16;
const MAX_SIDE_CELLS = 512;

/** What the hit test and the snaps ask of a spatial index. */
export interface SpatialIndex {
  query(box: Box, near?: { at: readonly [number, number]; limit: number }): Int32Array;
}

export class EntityGrid implements SpatialIndex {
  private readonly cells: (number[] | undefined)[];
  private readonly large: number[] = [];
  private readonly stamp: Int32Array;
  private round = 0;
  private readonly cols: number;
  private readonly rows: number;
  private readonly x0: number;
  private readonly y0: number;
  private readonly cw: number;
  private readonly ch: number;

  constructor(private readonly scene: DrawingScene) {
    const count = scene.boxes.length / 4;
    this.stamp = new Int32Array(count);
    const { extents } = scene.view;
    this.x0 = extents.minX;
    this.y0 = extents.minY;
    const side = Math.max(1, Math.min(MAX_SIDE_CELLS, Math.ceil(Math.sqrt(count / 3))));
    this.cols = side;
    this.rows = side;
    this.cw = Math.max((extents.maxX - extents.minX) / side, 1e-9);
    this.ch = Math.max((extents.maxY - extents.minY) / side, 1e-9);
    this.cells = new Array<number[] | undefined>(side * side);
    const b = scene.boxes;
    for (let i = 0; i < count; i++) {
      const o = i * 4;
      const c0 = this.col(b[o] as number);
      const c1 = this.col(b[o + 2] as number);
      const r0 = this.row(b[o + 1] as number);
      const r1 = this.row(b[o + 3] as number);
      if ((c1 - c0 + 1) * (r1 - r0 + 1) > MAX_CELLS_PER_ENTITY) {
        this.large.push(i);
        continue;
      }
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const key = r * this.cols + c;
          const list = this.cells[key];
          if (list) list.push(i);
          else this.cells[key] = [i];
        }
      }
    }
  }

  private col(x: number): number {
    return Math.max(0, Math.min(this.cols - 1, Math.floor((x - this.x0) / this.cw)));
  }

  private row(y: number): number {
    return Math.max(0, Math.min(this.rows - 1, Math.floor((y - this.y0) / this.ch)));
  }

  /**
   * The entities whose box meets `box`, each once, in ascending index order. Candidates only: a
   * cell is wider than the box of a small entity, so the caller still tests the exact box.
   */
  query(box: Box, near?: { at: readonly [number, number]; limit: number }): Int32Array {
    const b = this.scene.boxes;
    const out: number[] = [];
    this.round += 1;
    if (this.round > 2_000_000_000) {
      this.stamp.fill(0);
      this.round = 1;
    }
    const round = this.round;
    const take = (i: number) => {
      if (this.stamp[i] === round) return;
      this.stamp[i] = round;
      const o = i * 4;
      if (
        (b[o] as number) <= box.maxX &&
        (b[o + 2] as number) >= box.minX &&
        (b[o + 1] as number) <= box.maxY &&
        (b[o + 3] as number) >= box.minY
      ) {
        out.push(i);
      }
    };
    const c0 = this.col(box.minX);
    const c1 = this.col(box.maxX);
    const r0 = this.row(box.minY);
    const r1 = this.row(box.maxY);
    const visit = (r: number, c: number) => {
      const list = this.cells[r * this.cols + c];
      if (list) for (const i of list) take(i);
    };
    if (near) {
      // Ring after ring of cells around the point, until enough objects are found: zoomed far out
      // the box is most of the drawing and only the nearest objects matter.
      const cc = Math.max(c0, Math.min(c1, this.col(near.at[0])));
      const cr = Math.max(r0, Math.min(r1, this.row(near.at[1])));
      const reach = Math.max(cc - c0, c1 - cc, cr - r0, r1 - cr);
      for (let k = 0; k <= reach && out.length < near.limit; k++) {
        for (let r = Math.max(r0, cr - k); r <= Math.min(r1, cr + k); r++) {
          const edge = Math.abs(r - cr) === k;
          for (let c = Math.max(c0, cc - k); c <= Math.min(c1, cc + k); c++) {
            if (edge || Math.abs(c - cc) === k) visit(r, c);
          }
        }
      }
    } else {
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) visit(r, c);
    }
    for (const i of this.large) take(i);
    return Int32Array.from(out).sort();
  }
}

const grids = new WeakMap<DrawingScene, SpatialIndex>();

/** Gives a scene its index (a page scene: the file's grid plus one of the page rows, ADR-061). */
export function setEntityGrid(scene: DrawingScene, grid: SpatialIndex): void {
  grids.set(scene, grid);
}

/** The (cached) grid of a scene. */
export function entityGridOf(scene: DrawingScene): SpatialIndex {
  let grid = grids.get(scene);
  if (!grid) {
    grid = new EntityGrid(scene);
    grids.set(scene, grid);
  }
  return grid;
}
