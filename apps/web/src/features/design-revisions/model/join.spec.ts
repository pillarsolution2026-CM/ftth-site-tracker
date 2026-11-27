import { describe, expect, it } from 'vitest';
import { chainPoints, joinProblem, type JoinPiece } from './join';

const piece = (handle: string, points: [number, number][], layer = 'Route'): JoinPiece => ({
  handle,
  layer,
  points,
  closed: false,
});

describe('joinProblem (the worker rule, checked on the page)', () => {
  it('two lines whose ends are on the same point join', () => {
    expect(
      joinProblem(
        [
          piece('A', [
            [0, 0],
            [10, 0],
          ]),
          piece('B', [
            [10, 0],
            [10, 10],
          ]),
        ],
        0.05,
      ),
    ).toBeNull();
  });

  it('ends that stay apart do not join (the case of a vertex not put exactly on the other)', () => {
    expect(
      joinProblem(
        [
          piece('A', [
            [0, 0],
            [10, 0],
          ]),
          piece('B', [
            [10.2, 0],
            [10, 10],
          ]),
        ],
        0.05,
      ),
    ).toBe('chain');
  });

  it('ends within the tolerance join; a chain may start at either end', () => {
    expect(
      joinProblem(
        [
          piece('A', [
            [10, 0],
            [20, 0],
          ]),
          piece('B', [
            [0, 0],
            [10.04, 0],
          ]),
        ],
        0.05,
      ),
    ).toBeNull();
  });

  it('lines on different layers do not join', () => {
    expect(
      joinProblem(
        [
          piece('A', [
            [0, 0],
            [10, 0],
          ]),
          piece(
            'B',
            [
              [10, 0],
              [10, 10],
            ],
            'Other',
          ),
        ],
        0.05,
      ),
    ).toBe('layers');
  });

  it('three ends meeting at one point are not one chain', () => {
    expect(
      joinProblem(
        [
          piece('A', [
            [0, 0],
            [10, 0],
          ]),
          piece('B', [
            [10, 0],
            [10, 10],
          ]),
          piece('C', [
            [10, 0],
            [20, 0],
          ]),
        ],
        0.05,
      ),
    ).toBe('chain');
  });
});

describe('chainPoints (the joined polyline)', () => {
  it('chains from the smallest handle, flipping pieces, each shared vertex once', () => {
    expect(
      chainPoints([
        piece('C', [
          [20, 10],
          [10, 10],
        ]),
        piece('A', [
          [0, 0],
          [10, 0],
        ]),
        piece('B', [
          [10, 0],
          [10, 10],
        ]),
      ]),
    ).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
      [20, 10],
    ]);
  });

  it('grows at the front too, and keeps a near (not equal) vertex', () => {
    expect(
      chainPoints([
        piece('B', [
          [10, 0],
          [20, 0],
        ]),
        piece('C', [
          [0, 0],
          [10.01, 0],
        ]),
      ]),
    ).toEqual([
      [0, 0],
      [10.01, 0],
      [10, 0],
      [20, 0],
    ]);
  });
});
