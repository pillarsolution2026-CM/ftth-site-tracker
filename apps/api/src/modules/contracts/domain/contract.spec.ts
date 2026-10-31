import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Decimal } from '../../work-orders/domain/decimal.js';
import { Contract, type LineValues } from './contract.js';

const ids = { next: () => randomUUID() };
const now = new Date('2026-10-31T10:00:00Z');

const item = (code: string, quantity = '2', unitPrice = '10.5'): LineValues => ({
  kind: 'item',
  code,
  description: `بند ${code}`,
  unit: 'م.ط',
  quantity: Decimal.parse(quantity),
  unitPrice: Decimal.parse(unitPrice),
  workType: 'civil',
});
const heading = (code: string, description: string | null = null): LineValues => ({
  kind: 'heading',
  code,
  description,
});

function contractWith(...values: LineValues[]): Contract {
  let contract = Contract.create(
    { number: 'C-1', name: 'n', client: 'c', currency: 'EGP', createdById: null },
    ids,
    now,
  );
  for (const value of values) {
    const line = contract.buildLine(value, { acceptDuplicateCode: true }, ids, now);
    contract = new Contract(contract.header, [...contract.lines, line]);
  }
  return contract;
}

const approved = (contract: Contract): Contract =>
  new Contract({ ...contract.header, status: 'approved', approvedAt: now }, contract.lines);

describe('Contract', () => {
  it('starts as an empty draft at version 1', () => {
    const contract = contractWith();
    expect(contract.header).toMatchObject({ status: 'draft', version: 1, currency: 'EGP' });
    expect(contract.lines).toEqual([]);
    expect(contract.total.toString()).toBe('0');
  });

  it('totals priced items only and keeps the exact product', () => {
    const contract = contractWith(
      heading('1', 'مدني'),
      item('1-1', '3', '0.1'),
      item('1-2', '0', '99'),
      item('1-3', '1.5', '2.000001'),
    );
    expect(contract.total.toString()).toBe('3.3000015');
    expect(contract.items.map((line) => line.code)).toEqual(['1-1', '1-2', '1-3']);
  });

  it('numbers lines max + 1 and refuses a taken line number', () => {
    const contract = contractWith(item('A'), item('B'));
    expect(contract.nextLineNo()).toBe(3);
    expect(() =>
      contract.buildLine(item('C'), { lineNo: 2, acceptDuplicateCode: false }, ids, now),
    ).toThrow(expect.objectContaining({ details: { reason: 'LINE_TAKEN', lineNo: 2 } }));
    expect(
      contract.buildLine(item('C'), { lineNo: 9, acceptDuplicateCode: false }, ids, now).lineNo,
    ).toBe(9);
  });

  it('refuses a duplicate code unless accepted, headings included', () => {
    const contract = contractWith(heading('2'), item('2-1'));
    expect(() => contract.buildLine(item('2'), { acceptDuplicateCode: false }, ids, now)).toThrow(
      expect.objectContaining({ details: { reason: 'DUPLICATE_CODE', codes: ['2'] } }),
    );
    const line = contract.buildLine(item('2'), { acceptDuplicateCode: true }, ids, now);
    const next = new Contract(contract.header, [...contract.lines, line]);
    expect(next.duplicateCodes()).toEqual([{ code: '2', lineNos: [1, 3] }]);
  });

  it('turns an empty heading title into null and clears priced fields on a heading', () => {
    const contract = contractWith(heading('2-12', '   '));
    expect(contract.lines[0]).toMatchObject({
      kind: 'heading',
      description: null,
      unit: null,
      quantity: null,
      unitPrice: null,
      workType: null,
    });
  });

  it('lets a line change kind and checks the code against the other lines only', () => {
    const contract = contractWith(item('A'), item('B'));
    const [first] = contract.lines;
    const same = contract.changeLine(first?.id ?? '', heading('A', 'section'), false, now);
    expect(same.after).toMatchObject({ kind: 'heading', lineNo: 1, code: 'A', unit: null });
    expect(() => contract.changeLine(first?.id ?? '', item('B'), false, now)).toThrow(
      expect.objectContaining({ details: expect.objectContaining({ reason: 'DUPLICATE_CODE' }) }),
    );
  });

  it('checks the version', () => {
    const contract = contractWith();
    expect(() => contract.assertVersion(1)).not.toThrow();
    expect(() => contract.assertVersion(2)).toThrow(
      expect.objectContaining({ details: { reason: 'STALE_VERSION', currentVersion: 1 } }),
    );
  });

  it('needs at least one priced item to be approved; headings do not count', () => {
    expect(() => contractWith().assertApprovable()).toThrow(
      expect.objectContaining({ details: { reason: 'NO_PRICED_ITEMS' } }),
    );
    expect(() => contractWith(heading('1')).assertApprovable()).toThrow(
      expect.objectContaining({ details: { reason: 'NO_PRICED_ITEMS' } }),
    );
    expect(() =>
      contractWith(heading('1'), item('1-1', '0', '0')).assertApprovable(),
    ).not.toThrow();
  });

  it('locks every BOQ change once approved', () => {
    const contract = approved(contractWith(item('A')));
    const [line] = contract.lines;
    const locked = expect.objectContaining({ details: { reason: 'CONTRACT_APPROVED' } });
    expect(() => contract.buildLine(item('B'), { acceptDuplicateCode: false }, ids, now)).toThrow(
      locked,
    );
    expect(() => contract.changeLine(line?.id ?? '', item('A', '9'), false, now)).toThrow(locked);
    expect(() => contract.buildImportedLines([], ids, now)).toThrow(locked);
    expect(() => contract.assertApprovable()).toThrow(locked);
  });

  it('builds imported lines numbered from 1 with their sheet rows', () => {
    const contract = contractWith(item('OLD'));
    const lines = contract.buildImportedLines(
      [
        { ...heading('1', 'مدني'), sourceRow: 4 },
        { ...item('1-1'), sourceRow: 5 },
      ],
      ids,
      now,
    );
    expect(lines.map((l) => [l.lineNo, l.kind, l.source, l.sourceRow])).toEqual([
      [1, 'heading', 'import', 4],
      [2, 'item', 'import', 5],
    ]);
  });
});
