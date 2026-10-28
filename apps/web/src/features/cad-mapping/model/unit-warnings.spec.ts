import { describe, expect, it } from 'vitest';
import { detection } from './mapping-fixtures';
import { unitWarnings } from './unit-warnings';

describe('unitWarnings', () => {
  it('says nothing without a detection result', () => {
    expect(unitWarnings(null, 'm')).toEqual([]);
  });

  it('warns about the file contradicting its own coordinates even before a unit is chosen', () => {
    expect(unitWarnings(detection(), null)).toEqual([
      { kind: 'conflict', declared: 'in', implied: 'm' },
    ]);
  });

  it('adds a warning when the chosen unit differs from the declared one', () => {
    const kinds = unitWarnings(detection(), 'ft').map((warning) => warning.kind);
    expect(kinds).toEqual(['conflict', 'differsDeclared', 'differsImplied']);
  });

  it('metres on the Qalyub drawing differ from the declared inches only', () => {
    expect(unitWarnings(detection(), 'm').map((warning) => warning.kind)).toEqual([
      'conflict',
      'differsDeclared',
    ]);
  });

  it('is quiet when declared, implied and chosen all agree', () => {
    const agreed = detection({ declaredUnit: 'm', unitsConflict: false, insUnits: 6 });
    expect(unitWarnings(agreed, 'm')).toEqual([]);
  });

  it('does not compare against units the file does not give', () => {
    const none = detection({ declaredUnit: null, impliedUnit: null, unitsConflict: false });
    expect(unitWarnings(none, 'cm')).toEqual([]);
  });

  it('flags a unit that differs from the implied one when the file is unitless', () => {
    const unitless = detection({ declaredUnit: null, insUnits: 0, unitsConflict: false });
    expect(unitWarnings(unitless, 'mm')).toEqual([
      { kind: 'differsImplied', chosen: 'mm', implied: 'm' },
    ]);
  });
});
