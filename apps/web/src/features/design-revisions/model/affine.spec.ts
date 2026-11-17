import { describe, expect, it } from 'vitest';
import {
  angleOf,
  applyAffine,
  boxThrough,
  compose,
  IDENTITY,
  invert,
  rotationAbout,
  translation,
} from './affine';

const near = (p: { x: number; y: number }, x: number, y: number) => {
  expect(p.x).toBeCloseTo(x, 9);
  expect(p.y).toBeCloseTo(y, 9);
};

describe('affine moves and turns (ADR-047)', () => {
  it('turns counter-clockwise about a point, which stays put', () => {
    const turn = rotationAbout(1, 0, 90);
    near(applyAffine(turn, 1, 0), 1, 0);
    near(applyAffine(turn, 3, 0), 1, 2);
    expect(angleOf(turn)).toBeCloseTo(90, 9);
  });

  it('composes in order and inverts', () => {
    const both = compose(translation(2, 0), rotationAbout(0, 0, 90));
    near(applyAffine(both, 0, 0), 0, 2);
    const back = applyAffine(invert(both), 0, 2);
    near(back, 0, 0);
    expect(compose(IDENTITY, translation(1, 1))).toEqual(translation(1, 1));
  });

  it('boxes the turned corners', () => {
    const box = boxThrough(rotationAbout(0, 0, 90), { minX: 0, minY: 0, maxX: 2, maxY: 1 });
    expect(box.minX).toBeCloseTo(-1, 9);
    expect(box.maxX).toBeCloseTo(0, 9);
    expect(box.maxY).toBeCloseTo(2, 9);
  });
});
