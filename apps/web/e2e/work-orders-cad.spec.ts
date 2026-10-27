import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const BASE = 'http://localhost:3100';

// The mock API reads this stand-in for an .xlsx: the zip magic followed by JSON (see mock-api.ts).
function xlsxFixture(): Buffer {
  const sheets = [
    {
      name: 'BOQ',
      header: ['Code', 'Description', 'Unit', 'Quantity', 'Unit price'],
      rows: [
        ['A-1', 'Trench 40x60', 'm', '10', '2.5'],
        ['D-7', 'Duct 24/7', 'm', '5', '1.2'],
        ['D-7', 'Duct 24/7 (second line)', 'm', '3', '1.2'],
        ['E-5', 'Row without a quantity', 'm', '', '4'],
      ],
    },
  ];
  return Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from(JSON.stringify({ sheets })),
  ]);
}

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

test('create a work order by hand, add items with a duplicate code, attach a PDF', async ({
  page,
}) => {
  await login(page);
  await openProject(page, 'Work orders');
  await expect(page.getByText('No work orders yet')).toBeVisible();

  await page.getByRole('link', { name: 'New work order' }).click();
  await page.getByLabel('Number', { exact: true }).fill('WO-100');
  await page.getByLabel('Title').fill('Cairo zone 1');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: /Work order\s+WO-100/ })).toBeVisible();

  await page.getByRole('button', { name: 'Add item' }).click();
  await page.getByLabel('Code').fill('A-1');
  await page.getByLabel('Description').fill('Trench');
  await page.getByLabel('Unit', { exact: true }).fill('m');
  await page.getByLabel('Quantity').fill('10');
  await page.getByLabel('Unit price').fill('2.5');
  await page.getByRole('button', { name: 'Save' }).click();
  const table = page.getByRole('table', { name: 'Items' });
  await expect(table.getByRole('row', { name: /A-1/ })).toContainText('25.00');

  // Same code again: nothing is saved until the user chooses to keep it as a separate line.
  await page.getByRole('button', { name: 'Add item' }).click();
  await page.getByLabel('Code').fill('A-1');
  await page.getByLabel('Description').fill('Trench (second)');
  await page.getByLabel('Unit', { exact: true }).fill('m');
  await page.getByLabel('Quantity').fill('1');
  await page.getByLabel('Unit price').fill('1');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Code A-1 already exists on lines 1')).toBeVisible();
  await expect(table.getByRole('row')).toHaveCount(2);
  await page.getByRole('button', { name: 'Keep as a separate line' }).click();
  await expect(table.getByRole('row')).toHaveCount(3);
  await expect(page.getByText('Repeated code').first()).toBeVisible();
  await expect(page.getByText('26.00')).toBeVisible(); // total: 25 + 1, exact

  // PDF attachment: upload, download through the proxy, delete.
  await page.locator('#attachment-file').setInputFiles({
    name: 'scan.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 test'),
  });
  const link = page.getByRole('link', { name: 'scan.pdf' });
  await expect(link).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  expect(download.suggestedFilename()).toBe('scan.pdf');
  await page.getByRole('button', { name: 'Delete scan.pdf' }).click();
  await page
    .getByRole('group', { name: 'Delete this attachment?' })
    .getByRole('button', { name: 'Delete' })
    .click();
  await expect(page.getByRole('link', { name: 'scan.pdf' })).toHaveCount(0);
});

test('import an xlsx with a duplicate code and a bad row, then commit', async ({ page }) => {
  await login(page);
  await openProject(page, 'Work orders');
  await page.getByRole('link', { name: 'Import from Excel' }).click();

  await page.locator('#import-file').setInputFiles({
    name: 'wo.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: xlsxFixture(),
  });
  await expect(page.getByRole('heading', { name: '2. Sheet and columns' })).toBeVisible();
  await expect(page.locator('#map-code')).toHaveValue('0');
  await expect(page.locator('#map-unitPrice')).toHaveValue('4');
  await expect(page.getByText('Missing value: Quantity')).toBeVisible();
  await expect(page.getByText('This code is repeated in rows 4').first()).toBeVisible();

  const create = page.getByRole('button', { name: 'Create the work order' });
  await expect(create).toBeDisabled();
  await page.getByLabel('Number', { exact: true }).fill('WO-200');
  await expect(create).toBeDisabled(); // error row and repeated code still open

  await page.getByLabel('Exclude rows with errors').check();
  await page.getByLabel('Keep all as separate lines').check();
  await expect(create).toBeEnabled();
  await expect(page.getByTestId('import-total')).toHaveText('34.60');
  await create.click();

  await expect(page).toHaveURL(new RegExp(`/work-orders/[0-9a-f-]{36}$`));
  await expect(page.getByRole('heading', { name: /Work order\s+WO-200/ })).toBeVisible();
  const items = page.getByRole('table', { name: 'Items' });
  await expect(items.getByRole('row')).toHaveCount(4); // header + A-1 + two D-7 lines
  await expect(page.getByText('The import source cannot be deleted')).toBeVisible();
});

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
  await expect(page.getByText('Drawing units are not specified')).toBeVisible();

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
