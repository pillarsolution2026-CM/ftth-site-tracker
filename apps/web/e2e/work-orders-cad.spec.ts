import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const BASE = 'http://localhost:3100';

async function login(page: Page, locale = 'en') {
  await page.goto(`/${locale}/login`);
  await page.locator('#email').fill('pm@example.com');
  await page.locator('#password').fill('correct-password');
  await page.locator('form button[type="submit"]').click();
  await expect(page).toHaveURL(new RegExp(`/${locale}$`));
}

async function openProject(page: Page, section: 'Work orders' | 'CAD files') {
  await page.getByRole('link', { name: /القاهرة الجديدة/ }).click();
  await expect(page.getByRole('link', { name: section, exact: true })).toBeVisible();
  await page.getByRole('link', { name: section, exact: true }).click();
}

test.describe.configure({ mode: 'serial' });

test('upload a DXF and watch it go queued, processing, processed; inspect layers and texts', async ({
  page,
}) => {
  await login(page);
  await openProject(page, 'CAD files');
  await expect(page.getByText('No CAD files yet')).toBeVisible();

  await page.locator('#cad-file-input').setInputFiles({
    name: 'route-14.dxf',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nEOF\n'),
  });
  const row = page.getByRole('row', { name: /route-14\.dxf/ });
  await expect(row.getByText('Queued')).toBeVisible();
  await expect(row.getByText('Processing')).toBeVisible({ timeout: 15_000 });
  await expect(row.getByText('Processed')).toBeVisible({ timeout: 15_000 });

  await row.getByRole('link', { name: 'route-14.dxf' }).click();
  await expect(page.getByRole('heading', { name: 'route-14.dxf' })).toBeVisible();
  await expect(page.getByText(/choose the unit on the mapping screen/)).toBeVisible();

  await page.getByRole('tab', { name: 'Layers' }).click();
  const layers = page.getByRole('table', { name: 'Layers' });
  await expect(layers.getByRole('row', { name: /ROUTE-MAIN/ })).toContainText('ACI 1');
  await expect(layers.getByRole('row', { name: /طبقة-النصوص/ })).toBeVisible();
  await page.getByLabel('Search layer name').fill('route');
  await expect(layers.getByRole('row')).toHaveCount(2);

  await page.getByRole('tab', { name: 'Texts' }).click();
  await expect(page.getByText('F 36 C')).toBeVisible();
  await page.getByLabel('Unreadable texts only').check();
  await expect(page.getByRole('table', { name: 'Texts' }).getByRole('row')).toHaveCount(2);
  await expect(page.getByRole('table', { name: 'Texts' }).getByText(/Unreadable/)).toBeVisible();
  await page.getByLabel('Show raw text').check();
  await expect(page.getByText('%%U\\M+ABCD')).toBeVisible();

  await page.getByRole('tab', { name: 'Curves' }).click();
  await expect(page.getByRole('table', { name: 'Curves' }).getByRole('row')).toHaveCount(5);
  await page.getByRole('tab', { name: 'Converter log' }).click();
  await expect(page.getByText('ezdxf: recovered 0 issues')).toBeVisible();
});

test('the proxy streams a 20 MB upload, rejects CSRF and unknown paths', async ({ page }) => {
  await login(page);
  const size = 20 * 1024 * 1024;

  const upload = await page.request.post(`/api/projects/${PROJECT_ID}/cad-files`, {
    headers: { origin: BASE },
    multipart: {
      file: {
        name: 'big.dxf',
        mimeType: 'application/octet-stream',
        buffer: Buffer.alloc(size, 0x41),
      },
    },
  });
  expect(upload.status()).toBe(201);
  expect((await upload.json()).sizeBytes).toBe(size); // the whole file reached the API

  const noOrigin = await page.request.post(`/api/projects/${PROJECT_ID}/work-orders`, {
    data: { number: 'X' },
  });
  expect(noOrigin.status()).toBe(403);

  const crossSite = await page.request.post(`/api/projects/${PROJECT_ID}/work-orders`, {
    headers: { origin: 'https://evil.example' },
    data: { number: 'X' },
  });
  expect(crossSite.status()).toBe(403);

  const other = await page.request.get(`/api/projects/${PROJECT_ID}/members`);
  expect(other.status()).toBe(404);
});

test('Arabic is right-to-left with the sidebar and navigation', async ({ page }) => {
  await login(page, 'ar');
  await page.getByRole('link', { name: /القاهرة الجديدة/ }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('link', { name: 'أوامر التكليف', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'ملفات الكاد', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/ar\/projects\/.+\/work-orders$/);
});

test('mapping to a published design revision: unit, save, build, review, publish', async ({
  page,
}) => {
  await login(page);
  await openProject(page, 'CAD files');

  await page.locator('#cad-file-input').setInputFiles({
    name: 'mapping-1.dxf',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nEOF\n'),
  });
  const row = page.getByRole('row', { name: /mapping-1\.dxf/ });
  await expect(row.getByText('Processed')).toBeVisible({ timeout: 20_000 });
  await row.getByRole('link', { name: 'mapping-1.dxf' }).click();

  // The mapping link exists once the file is processed.
  await page.getByRole('link', { name: 'Mapping', exact: true }).click();
  await expect(page).toHaveURL(/\/cad-files\/[^/]+\/mapping$/);
  await expect(page.getByRole('heading', { name: 'CAD mapping', exact: true })).toBeVisible();

  // The drawing unit has no default; the file contradicts its own coordinates (inches vs UTM metres).
  const unit = page.getByLabel('Drawing unit', { exact: true });
  await expect(unit).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Save mapping' })).toBeDisabled();
  await expect(page.getByText(/The file declares/)).toBeVisible();
  await expect(page.getByLabel('EPSG code', { exact: true })).toHaveValue('32636');

  await unit.selectOption('m');
  await expect(page.getByText(/differs from the unit declared by the file/)).toBeVisible();
  await page.getByLabel('Becomes: ROUTE-MAIN').selectOption('route');
  await expect(page.getByRole('button', { name: 'Build revision' })).toBeDisabled();
  await page.getByRole('button', { name: 'Save mapping' }).click();
  await expect(page.getByText('Mapping saved (version 1)')).toBeVisible();

  await page.getByRole('button', { name: 'Build revision' }).click();
  await expect(page).toHaveURL(/\/design-revisions\/[^/]+$/);
  await expect(page.getByText('Refreshing automatically every 3 seconds')).toBeVisible();

  // Draft: counts, units warning, text review in "needs review", diff.
  await expect(page.getByText('Network features')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Lengths use the unit chosen by the project manager/)).toBeVisible();
  const counts = page.getByRole('region', { name: 'Network features' });
  await expect(counts).toContainText('361.5');
  await expect(page.getByLabel('Status', { exact: true })).toHaveValue('review');
  const links = page.getByRole('table', { name: 'Text review' });
  await expect(links.getByRole('row')).toHaveCount(4); // header + 3 in review
  await expect(links.getByText('%%U\\M+ABCD')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Changes' }).getByRole('row')).toHaveCount(6);

  await links.getByRole('button', { name: 'Confirm: F 36 C' }).click();
  await expect(links.getByRole('row')).toHaveCount(3);

  // Publish is refused while links are still in review: acknowledge the counts, then publish.
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('2');
  await expect(dialog).toContainText('text links still need review');
  const publishAnyway = dialog.getByRole('button', { name: 'Publish anyway' });
  await expect(publishAnyway).toBeDisabled();
  await dialog.getByLabel(/I understand/).check();
  await publishAnyway.click();

  await expect(page.getByRole('heading', { name: /Design revision\s+#1/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toHaveCount(0);

  await page.getByRole('link', { name: 'Design revisions', exact: true }).first().click();
  await expect(page.getByRole('table', { name: 'Design revisions' })).toContainText('Published');
});
