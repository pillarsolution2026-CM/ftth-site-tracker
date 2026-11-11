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
  await expect(page.getByText('No General has been uploaded yet')).toBeVisible();
  await expect(page.getByText('No Secondary has been uploaded yet')).toBeVisible();

  // The kind comes first: the file input stays locked until General or Secondary is chosen.
  await expect(page.locator('#cad-file-input')).toBeDisabled();
  await page.getByRole('radio', { name: 'General (main)' }).check();
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

  const upload = await page.request.post(
    `/api/projects/${PROJECT_ID}/cad-files?kind=general&newVersion=true`,
    {
      headers: { origin: BASE },
      multipart: {
        file: {
          name: 'big.dxf',
          mimeType: 'application/octet-stream',
          buffer: Buffer.alloc(size, 0x41),
        },
      },
    },
  );
  expect(upload.status()).toBe(201);
  expect((await upload.json()).sizeBytes).toBe(size); // the whole file reached the API
  expect((await upload.json()).drawingKind).toBe('general'); // the query string reached the API

  // The kind is required, and a kind that already has a current file asks first (ADR-040).
  const small = {
    name: 'x.dxf',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('0\nEOF\n'),
  };
  const noKind = await page.request.post(`/api/projects/${PROJECT_ID}/cad-files`, {
    headers: { origin: BASE },
    multipart: { file: small },
  });
  expect(noKind.status()).toBe(422);
  const exists = await page.request.post(`/api/projects/${PROJECT_ID}/cad-files?kind=general`, {
    headers: { origin: BASE },
    multipart: { file: small },
  });
  expect(exists.status()).toBe(409);
  expect((await exists.json()).details).toMatchObject({
    reason: 'KIND_EXISTS',
    kind: 'general',
    currentFileName: 'big.dxf',
  });

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
  // Two builds of the General (the first one is left unanswered, ADR-042) plus the Secondary.
  test.setTimeout(90_000);
  await login(page);
  await openProject(page, 'CAD files');

  // The work order already has a General (big.dxf): the PM is asked if this is a new version.
  const dxf = Buffer.from('0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nEOF\n');
  await page.getByRole('radio', { name: 'General (main)' }).check();
  await page.locator('#cad-file-input').setInputFiles({
    name: 'mapping-1.dxf',
    mimeType: 'application/octet-stream',
    buffer: dxf,
  });
  const question = page.getByRole('alertdialog');
  await expect(question).toContainText('Is this a new version of the General?');
  await expect(question).toContainText('big.dxf');
  await question.getByRole('button', { name: 'No' }).click();
  await expect(
    page.getByText('A work order has only one General — the file was not uploaded'),
  ).toBeVisible();
  await expect(page.getByRole('row', { name: /mapping-1\.dxf/ })).toHaveCount(0);

  await page.locator('#cad-file-input').setInputFiles({
    name: 'mapping-1.dxf',
    mimeType: 'application/octet-stream',
    buffer: dxf,
  });
  await page.getByRole('alertdialog').getByRole('button', { name: 'Yes, a new version' }).click();
  // The older General stays as history in the system but is no longer listed (owner 2026-11-11).
  await expect(page.getByRole('row', { name: /big\.dxf/ })).toHaveCount(0);
  const row = page.getByRole('row', { name: /mapping-1\.dxf/ });
  await expect(row.getByText('Processed')).toBeVisible({ timeout: 20_000 });
  await row.getByRole('link', { name: 'mapping-1.dxf' }).click();

  // The mapping link exists once the file is processed.
  await page.getByRole('link', { name: 'Mapping', exact: true }).click();
  await expect(page).toHaveURL(/\/cad-files\/[^/]+\/mapping$/);
  await expect(page.getByRole('heading', { name: 'CAD mapping', exact: true })).toBeVisible();

  // No unit picker any more (ADR-035): always metres, INSUNITS shown for information; the drawing
  // is placed in the panel below (no control points here: used as drawn).
  await expect(page.getByLabel('Drawing unit', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Always metres/)).toBeVisible();
  await expect(page.getByLabel('EPSG code', { exact: true })).toHaveValue('32636');
  await expect(page.getByRole('heading', { name: 'Place the drawing on the map' })).toBeVisible();
  await expect(page.getByText(/No control points yet/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save mapping' })).toBeEnabled();
  // ADR-042: the General is asked how its bundles are installed; «من كبائن الرئيسي» is a Secondary's.
  await expect(page.getByRole('region', { name: 'Installation method' })).toContainText(
    'Is the whole route pulled through old pipes, or does part of it need digging and new pipes?',
  );
  await expect(page.getByRole('button', { name: 'From the General’s cabinets' })).toHaveCount(0);

  await page.getByLabel('Becomes: ROUTE-MAIN').selectOption('route');
  await expect(page.getByRole('button', { name: 'Build revision' })).toBeDisabled();
  await page.getByRole('button', { name: 'Save mapping' }).click();
  await expect(page.getByText('Mapping saved (version 1)')).toBeVisible();

  await page.getByRole('button', { name: 'Build revision' }).click();
  await expect(page).toHaveURL(/\/design-revisions\/[^/]+$/);
  await expect(page.getByText('Refreshing automatically every 3 seconds')).toBeVisible();

  // ADR-042: the question was never answered, so this draft says the installation is unclear.
  await expect(page.getByText('Network features')).toBeVisible({ timeout: 20_000 });
  const unclear = page.getByRole('region', { name: 'Before publishing' });
  await expect(unclear).toContainText('Installation method (pull / trench) is clear');
  await expect(unclear).toContainText('The installation question is not answered');
  await expect(unclear.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
  const installation = page.getByRole('region', { name: 'Installation method' });
  await installation.getByRole('button', { name: 'All pulled through old pipes' }).click();
  await expect(
    installation.getByText('Current answer: All pulled through old pipes'),
  ).toBeVisible();
  // The draft froze no answer: it must be built again to apply it.
  await expect(installation.getByText('Rebuild so the marks are applied')).toBeVisible();
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await page.getByRole('button', { name: 'Discard revision' }).click();
  await page.getByRole('link', { name: 'CAD files', exact: true }).click();
  await page
    .getByRole('row', { name: /mapping-1\.dxf/ })
    .getByRole('link', { name: 'mapping-1.dxf' })
    .click();
  await page.getByRole('link', { name: 'Mapping', exact: true }).click();
  await page.getByRole('button', { name: 'Build revision' }).click();
  await expect(page).toHaveURL(/\/design-revisions\/[^/]+$/);

  // Draft: counts, units warning, text review in "needs review", diff.
  await expect(page.getByText('Network features')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Lengths use the unit chosen by the project manager/)).toBeVisible();
  // Drawing viewer (ADR-039): the mock has no rendered view yet.
  await expect(page.getByRole('heading', { name: 'Drawing viewer' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prepare the view' })).toBeVisible();
  const counts = page.getByRole('region', { name: 'Network features' });
  await expect(counts).toContainText('361.5');
  await expect(page.getByLabel('Status', { exact: true })).toHaveValue('review');
  const links = page.getByRole('table', { name: 'Text review' });
  await expect(links.getByRole('row')).toHaveCount(4); // header + 3 in review
  await expect(links.getByText('%%U\\M+ABCD')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Changes' }).getByRole('row')).toHaveCount(6);

  await links.getByRole('button', { name: 'Confirm: F 36 C' }).click();
  await expect(links.getByRole('row')).toHaveCount(3);

  // The checklist shows the checks; open links need the acknowledgement before Publish unlocks.
  const checklist = page.getByRole('region', { name: 'Before publishing' });
  await expect(checklist).toContainText('Coordinates: source CRS chosen');
  await expect(checklist).toContainText('No drawing errors');
  await expect(checklist).toContainText('Open items reviewed');
  // The answer was frozen by the second build: the installation row is done.
  await expect(checklist).toContainText('Installation method (pull / trench) is clear');
  // The other drawing has no draft yet: publishing is locked and says so (ADR-040).
  await expect(checklist.getByText('❌')).toHaveCount(3);
  await expect(checklist).toContainText('Cabinets match in both drawings (name and count)');
  await expect(checklist).toContainText('There is no draft for the Secondary to compare with');
  await expect(checklist).toContainText('There is no draft for the Secondary yet');
  await expect(checklist).toContainText('both drawings together');
  const publish = checklist.getByRole('button', { name: 'Publish', exact: true });
  await expect(publish).toBeDisabled();

  // Upload the Secondary, map it and build its draft.
  await page.getByRole('link', { name: 'CAD files', exact: true }).click();
  await page.getByRole('radio', { name: 'Secondary', exact: true }).check();
  await page.locator('#cad-file-input').setInputFiles({
    name: 'secondary-1.dxf',
    mimeType: 'application/octet-stream',
    buffer: dxf,
  });
  const secondaryRow = page.getByRole('row', { name: /secondary-1\.dxf/ });
  await expect(secondaryRow.getByText('Processed')).toBeVisible({ timeout: 20_000 });
  await secondaryRow.getByRole('link', { name: 'secondary-1.dxf' }).click();
  await page.getByRole('link', { name: 'Mapping', exact: true }).click();
  await page.getByLabel('Becomes: ROUTE-MAIN').selectOption('route');

  // ADR-042: a Secondary is not asked; its placement is filled from the General’s cabinets.
  await expect(page.getByRole('region', { name: 'Installation method' })).toHaveCount(0);
  await expect(page.getByText(/points added from the General’s cabinets/)).toBeVisible();
  await expect(page.getByRole('table', { name: 'Control points' })).toContainText('gc-1-2');
  await expect(page.getByText('Cabinets that did not match')).toBeVisible();

  // ADR-041: this is a Secondary, so the text layer can become a cabinet zone and take the
  // Secondary text roles only; the route layer takes the number of ways.
  const textLayer = page.getByLabel('Becomes: طبقة-النصوص');
  await expect(textLayer.getByRole('option', { name: 'Cabinet zone' })).toHaveCount(1);
  await textLayer.selectOption('label');
  const textRow = page.getByRole('row', { name: /طبقة-النصوص/ });
  await expect(textRow.getByRole('checkbox', { name: 'Handhole type' })).toHaveCount(0);
  await textRow.getByRole('checkbox', { name: 'Box number' }).check();
  await page.getByLabel(/Number of ways: ROUTE-MAIN/).fill('1');
  await page.getByRole('button', { name: 'Save mapping' }).click();
  await expect(page.getByText('Mapping saved (version 1)')).toBeVisible();
  await page.getByRole('button', { name: 'Build revision' }).click();
  await expect(page).toHaveURL(/\/design-revisions\/[^/]+$/);
  await expect(page.getByText('Network features')).toBeVisible({ timeout: 20_000 });
  // The reading totals are shown because the mapping gave the texts a meaning.
  await expect(page.getByRole('table', { name: 'Bundles by type' })).toContainText('361.500');

  // The Secondary draft sees the General draft as the other drawing, ready, and links to it.
  const pairChecklist = page.getByRole('region', { name: 'Before publishing' });
  await expect(pairChecklist).toContainText('The other drawing (General (main)) is ready');
  await expect(pairChecklist).toContainText('The Secondary is all trench — no question.');
  await expect(
    pairChecklist.getByRole('link', { name: 'Open the General (main) draft' }),
  ).toBeVisible();
  const pairPublish = pairChecklist.getByRole('button', { name: 'Publish', exact: true });
  await expect(pairPublish).toBeDisabled(); // open items of both drawings need the acknowledgement
  await pairChecklist.getByLabel(/I understand/).check();
  await expect(pairPublish).toBeEnabled();
  await pairPublish.click();

  await expect(page.getByRole('heading', { name: /Design revision\s+#1/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toHaveCount(0);

  await page.getByRole('link', { name: 'Design revisions', exact: true }).first().click();
  const revisionTable = page.getByRole('table', { name: 'Design revisions' });
  await expect(revisionTable).toContainText('Published');
  // Both drawings were published together and each row names its kind.
  // …and the first General draft, discarded because its installation was unanswered.
  await expect(revisionTable.getByRole('row')).toHaveCount(4);
  await expect(revisionTable).toContainText('Discarded');
  await expect(revisionTable.locator('[data-kind="general"]').first()).toContainText('Main');
  await expect(revisionTable.locator('[data-kind="secondary"]')).toContainText('Secondary');
});
