import { describe, expect, it } from 'vitest';
import { joinProblem, type JoinPiece } from './join';

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
