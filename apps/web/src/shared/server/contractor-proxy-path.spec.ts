import { describe, expect, it } from 'vitest';
import { contractorUpstreamPath } from './contractor-proxy-path';

describe('contractorUpstreamPath', () => {
  it('exposes only /contractor/me', () => {
    expect(contractorUpstreamPath(['me'])).toBe('/contractor/me');
    expect(contractorUpstreamPath([])).toBeNull();
    expect(contractorUpstreamPath(['me', 'x'])).toBeNull();
    expect(contractorUpstreamPath(['..'])).toBeNull();
    expect(contractorUpstreamPath(['other'])).toBeNull();
  });
});
