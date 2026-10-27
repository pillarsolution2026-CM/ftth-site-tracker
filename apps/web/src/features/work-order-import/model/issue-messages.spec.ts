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
});
