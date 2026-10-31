import { expect, test, type Page } from '@playwright/test';

// Work orders take their lines from the project's approved contract (ADR-028). The mock API seeds
// the approved contract C-SEED (items 1-1: 100 @ 12.5 and 1-1-1: 40 @ 3, both civil) for the first
// project, and a draft contract for the second one.

// The mock API reads this stand-in for an .xlsx: the zip magic followed by JSON (see mock-api.ts).
function xlsxFixture(): Buffer {
  const sheets = [
    {
      name: 'WO',
      header: ['Code', 'Description', 'Unit', 'Quantity', 'Unit price', 'Work type'],
      rows: [
        // price differs from the contract (12.5)
        ['1-1', 'حفر خندق', 'م', '10', '13', 'مدني'],
        // not a contract item
        ['9-9', 'Unknown', 'm', '1', '1', 'مدني'],
        // more than the 40 the contract has
        ['1-1-1', 'ردم', 'م', '50', '3', 'مدني'],
      ],
    },
  ];
  return Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from(JSON.stringify({ sheets })),
  ]);
}

async function login(page: Page) {
  await page.goto('/en/login');
  await page.locator('#email').fill('pm@example.com');
  await page.locator('#password').fill('correct-password');
  await page.locator('form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/en$/);
}

async function openWorkOrders(page: Page, project: RegExp) {
  await page.getByRole('link', { name: project }).click();
  await page.getByRole('link', { name: 'Work orders', exact: true }).click();
}

test.describe.configure({ mode: 'serial' });

test('the import preview checks every row against the approved contract', async ({ page }) => {
  await login(page);
  await openWorkOrders(page, /القاهرة الجديدة/);
  await page.getByRole('link', { name: 'Import from Excel' }).click();

  await page.locator('#import-file').setInputFiles({
    name: 'wo.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: xlsxFixture(),
  });
  await expect(page.getByRole('heading', { name: '2. Sheet and columns' })).toBeVisible();
  await expect(page.getByText('Unit price differs from the contract (12.5)')).toBeVisible();
  await expect(page.getByText('The code is not in the contract')).toBeVisible();
  await expect(
    page.getByText('The quantity is above what is available in the contract (available 40 of 40)'),
  ).toBeVisible();

  // No duplicate-decision step; the rows with errors still block the commit.
  await expect(page.getByLabel('Keep all as separate lines')).toHaveCount(0);
  await page.getByLabel('Number', { exact: true }).fill('WO-IMPORT');
  await expect(page.getByRole('button', { name: 'Create the work order' })).toBeDisabled();
  await expect(page.getByText('Rows with errors are still included: exclude them')).toBeVisible();
});

test('create the work order from two contract items, hit the contract limit, edit a quantity', async ({
  page,
}) => {
  await login(page);
  await openWorkOrders(page, /القاهرة الجديدة/);
  await expect(page.getByText('No work orders yet')).toBeVisible();

  await page.getByRole('link', { name: 'New work order' }).click();
  await page.getByLabel('Number', { exact: true }).fill('WO-100');
  const picker = page.getByRole('table', { name: 'Contract items' });
  await expect(picker.getByRole('row')).toHaveCount(3); // header + 2 items
  await expect(page.getByTestId('available-1-1')).toHaveText('100');

  await page.getByLabel('Choose item 1-1', { exact: true }).check();
  await page.getByLabel('Quantity for item 1-1', { exact: true }).fill('150');
  await expect(page.getByText('Quantity is above what is available (100)')).toBeVisible();
  await page.getByLabel('Choose item 1-1-1').check();
  await page.getByLabel('Quantity for item 1-1-1').fill('10');

  // The warning does not block: the server answers 409 with the figures.
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'item 1-1' })).toContainText(
    'item 1-1: requested 150, available 100 (contract 100, reserved 0)',
  );

  await page.getByLabel('Quantity for item 1-1', { exact: true }).fill('60');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Work order\s+WO-100/ })).toBeVisible();

  const items = page.getByRole('table', { name: 'Items' });
  await expect(items.getByRole('row')).toHaveCount(3);
  // 60 × 12.5 + 10 × 3 = 780, exact.
  await expect(page.getByText('780.00 EGP')).toBeVisible();
  // Contract quantity and what is left after the reservation, per line.
  const first = items.getByRole('row').filter({ hasText: 'حفر خندق' });
  await expect(first).toContainText('100');
  await expect(first).toContainText('40');

  // Only the quantity can be edited; the server refuses more than the contract has left.
  await page.getByRole('button', { name: 'Edit 1-1', exact: true }).click();
  const form = page.getByRole('form', { name: 'Edit item' });
  await expect(form.getByRole('textbox')).toHaveCount(1);
  await form.getByLabel('Quantity').fill('120');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByRole('alert')).toContainText(
    'item 1-1: requested 120, available 100 (contract 100, reserved 0)',
  );
  await form.getByLabel('Quantity').fill('80');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('form', { name: 'Edit item' })).toHaveCount(0);
  await expect(page.getByText('1,030.00 EGP')).toBeVisible();

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

  // One work order per project: the list links to it and offers no second one.
  await page.getByRole('link', { name: 'Back to the list' }).click();
  await expect(page.getByText(/already has its work order/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'New work order' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Import from Excel' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'WO-100' })).toBeVisible();
});

test('a project under a draft contract says to approve the contract first', async ({ page }) => {
  await login(page);
  await openWorkOrders(page, /الإسكندرية/);
  await expect(
    page.getByText('The contract is still a draft. Approve the contract first.'),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'New work order' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Import from Excel' })).toHaveCount(0);

  // Typing the URL does not get around it.
  await page.goto(page.url().replace(/\/work-orders$/, '/work-orders/import'));
  await expect(
    page.getByText('The contract is still a draft. Approve the contract first.'),
  ).toBeVisible();
  await expect(page.locator('#import-file')).toHaveCount(0);
});
