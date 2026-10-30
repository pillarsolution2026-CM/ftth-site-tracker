import { addQuantities, compareQuantities, fromUnits, stepQuantity, toUnits } from './quantity';

describe('quantity', () => {
  it('adds exactly without floating point', () => {
    expect(addQuantities('0.1', '0.2')).toBe('0.3');
    expect(addQuantities('12.5', '0.0001', '7')).toBe('19.5001');
    expect(addQuantities()).toBe('0');
  });

  it('steps by whole units and never goes below zero', () => {
    expect(stepQuantity('0', 1)).toBe('1');
    expect(stepQuantity('1.25', 10)).toBe('11.25');
    expect(stepQuantity('3', -10)).toBe('0');
  });

  it('compares and round-trips', () => {
    expect(compareQuantities('100', '100.0001')).toBe(-1);
    expect(compareQuantities('100.0000', '100')).toBe(0);
    expect(compareQuantities('2', '1.9999')).toBe(1);
    expect(fromUnits(toUnits('7.5000'))).toBe('7.5');
    expect(fromUnits(-5n)).toBe('-0.0005');
    expect(() => toUnits('1.23456')).toThrow(RangeError);
  });
});
