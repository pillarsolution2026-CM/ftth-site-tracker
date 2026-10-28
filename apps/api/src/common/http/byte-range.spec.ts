import { describe, expect, it } from 'vitest';
import { parseRangeHeader } from './byte-range.js';

describe('parseRangeHeader', () => {
  it('serves the whole object without a Range header', () => {
    expect(parseRangeHeader(undefined, 100)).toEqual({ kind: 'full' });
  });

  it.each([
    ['bytes=0-9', { start: 0, end: 9 }],
    ['bytes=10-', { start: 10, end: 99 }],
    ['bytes=-10', { start: 90, end: 99 }],
    ['bytes=90-1000', { start: 90, end: 99 }], // end clamped to the last byte
    ['bytes=0-0', { start: 0, end: 0 }],
    ['bytes=-1000', { start: 0, end: 99 }], // suffix longer than the object = all of it
    ['BYTES=5-6', { start: 5, end: 6 }],
    [' bytes=5-6 ', { start: 5, end: 6 }],
  ])('parses %s', (header, range) => {
    expect(parseRangeHeader(header, 100)).toEqual({ kind: 'partial', range });
  });

  it.each(['bytes=100-', 'bytes=100-120', 'bytes=-0', 'bytes=500-'])(
    'reports %s as unsatisfiable',
    (header) => {
      expect(parseRangeHeader(header, 100)).toEqual({ kind: 'unsatisfiable' });
    },
  );

  it('treats any suffix range of an empty object as unsatisfiable', () => {
    expect(parseRangeHeader('bytes=-5', 0)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRangeHeader('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
  });

  it.each(['bytes=5-2', 'bytes=-', 'bytes=0-1,5-6', 'items=0-1', 'bytes=a-b', 'garbage', ''])(
    'ignores the unusable header %j and serves everything',
    (header) => {
      expect(parseRangeHeader(header, 100)).toEqual({ kind: 'full' });
    },
  );
});
