import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, locale: 'en' | 'ar') {
  await page.goto(`/${locale}/login`);
  await page.locator('#email').fill('pm@example.com');
  await page.locator('#password').fill('correct-password');
  await page.locator('form button[type="submit"]').click();
  await expect(page).toHaveURL(new RegExp(`/${locale}$`));
}

async function openAsBuilt(page: Page, linkName: string) {
  await page.getByRole('link', { name: /القاهرة الجديدة/ }).click();
  await page.getByRole('link', { name: linkName, exact: true }).click();
  await expect(page).toHaveURL(/\/asbuilt$/);
}

test.describe.configure({ mode: 'serial' });

test('review: open a pending edit, see design dashed under the proposal, approve it (LTR)', async ({
  page,
}) => {
  await login(page, 'en');
  await openAsBuilt(page, 'As-Built');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByLabel('Status')).toHaveValue('pending');

  const table = page.getByRole('table', { name: 'As-Built review' });
  const row = table.getByRole('row', { name: /122\.066/ });
  await expect(row.getByText('122.066 m')).toBeVisible();
  await expect(row.getByText('Awaiting review')).toBeVisible();
  // Flags are text + icon in the list.
  await expect(table.getByRole('row', { name: /Outdated base/ })).toBeVisible();
  await row.getByRole('link').click();

  await expect(page.getByRole('heading', { name: 'As-Built edit' })).toBeVisible();
  const drawing = page.getByTestId('comparison-drawing');
  await expect(drawing.locator('[data-layer="design"] path')).toHaveAttribute(
    'stroke-dasharray',
    /.+/,
  );
  await expect(drawing.locator('[data-layer="proposed"] path')).toBeVisible();
  await expect(drawing.locator('[data-layer="proposed"] path')).not.toHaveAttribute(
    'stroke-dasharray',
    /.+/,
  );
  await expect(page.getByText('Design (dashed line)')).toBeVisible();
  await expect(page.getByText('Proposed by the supervisor (solid thick line)')).toBeVisible();
  await expect(page.getByTestId('design-length')).toHaveText('120.000 m');
  await expect(page.getByTestId('proposed-length')).toHaveText('122.066 m');
  await expect(page.getByTestId('length-difference')).toContainText('+2.066 m');

  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.locator('[data-status="approved"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toBeDisabled();

  // The approved edit left the pending list.
  await page.getByRole('link', { name: 'Back to the list' }).click();
  await expect(
    page.getByRole('table', { name: 'As-Built review' }).getByRole('row', { name: /122\.066/ }),
  ).toHaveCount(0);
  await page.getByLabel('Status').selectOption('approved');
  await expect(
    page.getByRole('table', { name: 'As-Built review' }).getByRole('row', { name: /122\.066/ }),
  ).toContainText('Approved');
});

test('review in Arabic (RTL): reject needs a reason; stale and own edits are refused clearly', async ({
  page,
}) => {
  await login(page, 'ar');
  await openAsBuilt(page, 'المنفَّذ فعليًا (As-Built)');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

  const table = page.getByRole('table', { name: 'مراجعة المنفَّذ فعليًا' });
  await table
    .getByRole('row', { name: /نقل نقطة/ })
    .getByRole('link')
    .click();
  // Coordinates and lengths stay LTR; the map itself is never mirrored.
  await expect(page.getByTestId('comparison-drawing')).toHaveAttribute('direction', 'ltr');
  await expect(
    page.getByText('مراجعة تصميم لم تعد آخر مراجعة منشورة', { exact: false }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'رفض', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByRole('button', { name: 'رفض التعديل' }).click();
  await expect(dialog.getByText('السبب مطلوب')).toBeVisible();
  await dialog.getByLabel('السبب').fill('الصندوق في موقع خاطئ');
  await dialog.getByRole('button', { name: 'رفض التعديل' }).click();
  await expect(page.locator('[data-status="rejected"]')).toBeVisible();
  await expect(page.getByText('الصندوق في موقع خاطئ')).toBeVisible();

  // Stale base: approve is disabled and explained.
  await page.getByRole('link', { name: 'العودة إلى القائمة' }).click();
  await page
    .getByRole('table', { name: 'مراجعة المنفَّذ فعليًا' })
    .getByRole('row', { name: /أساس قديم/ })
    .getByRole('link')
    .click();
  await expect(page.getByRole('button', { name: 'اعتماد' })).toBeDisabled();
  await expect(
    page.getByText('لا يمكن اعتماده لأن تعديلًا آخر لهذا العنصر اعتُمد بعد رسمه'),
  ).toBeVisible();
  await expect(
    page.getByTestId('comparison-drawing').locator('[data-layer="current"] path'),
  ).toBeVisible();

  // An edit recorded by the same user cannot be reviewed by them.
  await page.getByRole('link', { name: 'العودة إلى القائمة' }).click();
  await page
    .getByRole('table', { name: 'مراجعة المنفَّذ فعليًا' })
    .getByRole('row', { name: /إضافة رمز/ })
    .getByRole('link')
    .click();
  await page.getByRole('button', { name: 'اعتماد' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'لا يمكنك مراجعة تعديل سجّلته بنفسك' }),
  ).toBeVisible();
});

test('export: request a DXF, watch it finish, download it through the BFF', async ({ page }) => {
  await login(page, 'en');
  await openAsBuilt(page, 'As-Built');

  await page.getByRole('button', { name: 'Export As-Built DXF' }).click();
  const exports = page.getByRole('table', { name: 'As-Built DXF exports' });
  await expect(exports.getByText('Queued')).toBeVisible();
  await expect(exports.getByText('Done')).toBeVisible({ timeout: 20_000 });
  await expect(exports.getByText('24 design, 2 edited, 1 added')).toBeVisible();

  const link = exports.getByRole('link', { name: 'Download DXF' });
  const href = await link.getAttribute('href');
  expect(href).toMatch(/^\/api\/projects\/[0-9a-f-]+\/asbuilt\/exports\/[0-9a-f-]+\/file$/);
  const download = await page.request.get(href ?? '');
  expect(download.status()).toBe(200);
  expect(download.headers()['content-type']).toContain('application/dxf');
  expect(download.headers()['content-disposition']).toContain('attachment');
  expect(download.headers()['x-content-type-options']).toBe('nosniff');
});
