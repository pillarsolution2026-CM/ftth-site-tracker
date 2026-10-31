import { IMPORT_FILE_ISSUE_CODES, IMPORT_ROW_ISSUE_CODES } from '@ftth/shared';
import { LOCALES, translate } from '@ftth/i18n';
import { describe, expect, it } from 'vitest';
import { fileIssueText, rowIssueText } from './issue-messages';

describe('import issue messages', () => {
  it('has a message in every locale for every issue code', () => {
    for (const locale of LOCALES) {
      const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
        translate(locale, key, params);
      for (const code of IMPORT_ROW_ISSUE_CODES) {
        const text = rowIssueText({ code, severity: 'error', field: 'quantity' }, t);
        expect(text, `${locale}/${code}`).not.toMatch(/^import\./);
        expect(text).not.toMatch(/\{\w+\}/);
      }
      for (const code of IMPORT_FILE_ISSUE_CODES) {
        const text = fileIssueText({ code, field: 'code' }, t);
        expect(text, `${locale}/${code}`).not.toMatch(/^import\./);
        expect(text).not.toMatch(/\{\w+\}/);
      }
    }
  });

  it('fills otherRows for duplicate codes', () => {
    const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
      translate('en', key, params);
    const text = rowIssueText(
      {
        code: 'DUPLICATE_CODE',
        severity: 'warning',
        field: 'code',
        params: { otherRows: '12, 30' },
      },
      t,
    );
    expect(text).toContain('12, 30');
  });

  it('words UNIT_FORM_VARIANT in every locale with the other rows', () => {
    const issue = {
      code: 'UNIT_FORM_VARIANT' as const,
      severity: 'warning' as const,
      field: 'unit' as const,
      params: { otherRows: '192, 193' },
    };
    const text = (locale: (typeof LOCALES)[number]) =>
      rowIssueText(issue, (key, params) => translate(locale, key, params));
    expect(text('ar')).toBe('نفس الوحدة مكتوبة بشكل مختلف في الصفوف 192, 193');
    expect(text('en')).toContain('192, 193');
    expect(text('fr')).toContain('192, 193');
  });

  it('names the decimal limit of each field (ADR-016)', () => {
    const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
      translate('en', key, params);
    const price = rowIssueText(
      { code: 'TOO_MANY_DECIMALS', severity: 'error', field: 'unitPrice', params: { max: 6 } },
      t,
    );
    expect(price).toBe('Unit price has more than 6 decimal places');
    const quantity = rowIssueText(
      { code: 'TOO_MANY_DECIMALS', severity: 'error', field: 'quantity', params: { max: 4 } },
      t,
    );
    expect(quantity).toBe('Quantity has more than 4 decimal places');
  });

  it('shows the unknown work type value', () => {
    const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
      translate('ar', key, params);
    const text = rowIssueText(
      {
        code: 'INVALID_WORK_TYPE',
        severity: 'error',
        field: 'workType',
        params: { value: 'صيانة' },
      },
      t,
    );
    expect(text).toContain('صيانة');
  });
});
