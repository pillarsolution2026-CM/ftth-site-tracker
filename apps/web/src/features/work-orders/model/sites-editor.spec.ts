import { describe, expect, it } from 'vitest';
import {
  addRow,
  mergeTableNames,
  removeRow,
  renameRow,
  rowsChanged,
  rowsFromSites,
  sitesPayload,
  validateRows,
} from './sites-editor';

const saved = [
  { id: '0b7f3b0e-8f7e-4d3a-9d1c-6c2f1e0a9b11', name: 'موقع أ' },
  { id: '1b7f3b0e-8f7e-4d3a-9d1c-6c2f1e0a9b11', name: 'موقع ب' },
];

describe('sites editor', () => {
  it('builds a payload that keeps ids of saved sites and adds new ones', () => {
    let rows = rowsFromSites(saved);
    rows = renameRow(rows, saved[1]?.id ?? '', 'موقع  ج ');
    rows = addRow(rows, 'موقع د');
    rows = removeRow(rows, saved[0]?.id ?? '');
    expect(sitesPayload(rows, 4)).toEqual({
      expectedVersion: 4,
      sites: [{ id: saved[1]?.id, name: 'موقع ج' }, { name: 'موقع د' }],
    });
    expect(rowsChanged(rows, saved)).toBe(true);
    expect(rowsChanged(rowsFromSites(saved), saved)).toBe(false);
  });

  it('flags empty and repeated names (Arabic letter forms folded)', () => {
    const rows = addRow(addRow(rowsFromSites(saved), 'موقع ا'), '');
    const errors = validateRows(rows);
    expect(Object.values(errors)).toEqual(['sites.repeated', 'validation.required']);
  });

  it('adds table names after the list, skipping those already there and empty rows', () => {
    const start = addRow(rowsFromSites(saved), '');
    const { rows, skipped } = mergeTableNames(start, ['موقع ا', 'موقع هـ', 'موقع هـ']);
    expect(rows.map((row) => row.name)).toEqual(['موقع أ', 'موقع ب', 'موقع هـ']);
    expect(skipped).toBe(2);
  });
});
