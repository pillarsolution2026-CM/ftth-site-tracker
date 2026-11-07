import { expect, test, type Page } from '@playwright/test';

// Subcontractors (ADR-036). Contractor lines come only from an uploaded sheet. The mock API
// (mock-contractors.ts) gives every project except the two seeded ones a virtual work order with
// lines T-1 (100 @ 12.5), T-2 (40 @ 3), the box line 2-12-4-8 (100 @ 30) and a legacy line, so this
// flow creates its own project and does not touch the state the other specs share.

async function loginAs(page: Page, email: string) {
  await page.goto('/ar/login');
  await page.getByLabel('البريد الإلكتروني').fill(email);
  await page.getByLabel('كلمة المرور').fill('correct-password');
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page).toHaveURL(/\/ar$/);
}

type Cell = string | number | null;

/** The mock API reads this stand-in for an .xlsx: the zip magic followed by JSON. */
function sheet(rows: Cell[][]): Buffer {
  const header = ['الكود', 'الوصف', 'الوحدة', 'نطاق الشغل', 'الكمية', 'السعر'];
  return Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from(JSON.stringify({ sheets: [{ name: 'Sheet1', header, rows }] })),
  ]);
}

const BOX = ['2-12-4-8', 'تركيب بوكس', 'عدد'] as const;
const FIX_BRACKET = 'تركيب الخوصة';
const FIX_BOX = 'تركيب البوكس';
const FIX_SPLICE = 'لحام البوكس';

async function createContractor(page: Page, name: string, contact: string) {
  await page.getByLabel('الاسم', { exact: true }).fill(name);
  await page.getByLabel('الشخص المسؤول').fill(contact);
  await page.getByLabel('الهاتف').fill('0100 123 4567');
  await page.getByRole('button', { name: 'إنشاء المقاول' }).click();
  await expect(page.getByRole('cell', { name, exact: true })).toBeVisible();
}

async function pickSheet(page: Page, buffer: Buffer, name = 'lines.xlsx') {
  await page.locator('#import-file').setInputFiles({
    name,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer,
  });
}

async function startRegistration(page: Page, contractor: string) {
  await page.getByRole('link', { name: 'تسجيل مقاول', exact: true }).click();
  await page.getByLabel('المقاول', { exact: true }).selectOption({ label: contractor });
  await page.getByLabel('تاريخ التسجيل').fill('2026-11-07');
}

test('an admin registers three subcontractors on the scopes of one line by uploading sheets', async ({
  page,
}) => {
  await loginAs(page, 'admin@example.com');

  // The shared list of contractors.
  await page.goto('/ar/admin/contractors');
  await expect(page.getByRole('link', { name: 'المقاولين الباطن', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'إنشاء المقاول' }).click();
  await expect(page.getByText('هذا الحقل مطلوب').first()).toBeVisible();
  await createContractor(page, 'Nile Cables', 'Hassan Ali');
  await createContractor(page, 'Delta Telecom', 'Mona Said');
  await createContractor(page, 'Sphinx Fiber', 'Omar Fathy');

  // A new project (so it has its own work order in the mock).
  await page.goto('/ar/admin/projects');
  await page.getByLabel('اسم أمر التكليف / المشروع').fill('مشروع المقاولين');
  await page
    .getByLabel('العقد', { exact: true })
    .selectOption({ label: 'C-SEED — عقد الشبكة — Client — EGP' });
  await page.getByRole('button', { name: 'إنشاء أمر التكليف / المشروع' }).click();
  await expect(page.getByRole('heading', { name: 'مشروع المقاولين' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'المقاولين الباطن', level: 2 })).toBeVisible();
  // No manual line entry any more.
  await expect(page.getByRole('button', { name: 'إضافة بند' })).toHaveCount(0);
  const projectUrl = page.url();

  // 1. Nile Cables: the trench line whole and the box scope «fix the bracket». A row that is not
  //    in the work order blocks the commit until it is excluded.
  await startRegistration(page, 'Nile Cables');
  await pickSheet(
    page,
    sheet([
      ['T-1', 'حفر خندق', 'م', null, '30', '12.5'],
      [...BOX, FIX_BRACKET, '100', '10'],
      ['X-9', 'غير موجود', 'م', null, '1', '1'],
    ]),
  );
  await expect(page.getByText('الكود ليس من بنود أمر التكليف')).toBeVisible();
  await expect(page.getByRole('button', { name: 'تسجيل البنود' })).toBeDisabled();
  await page.locator('#exclude-error-rows').check();
  await page.getByRole('button', { name: 'تسجيل البنود' }).click();
  await expect(page).toHaveURL(projectUrl);
  // 30 × 12.5 + 100 × 10 = 1375, exact.
  await expect(page.getByText('1,375.00 EGP')).toBeVisible();

  // 2. Delta Telecom: another scope of the same box line.
  await startRegistration(page, 'Delta Telecom');
  await pickSheet(page, sheet([[...BOX, FIX_BOX, '100', '12']]));
  await page.getByRole('button', { name: 'تسجيل البنود' }).click();
  await expect(page.getByText('1,200.00 EGP')).toBeVisible();

  // 3. Sphinx Fiber: 10 + 12 + 9 is above the contract price 30; the most allowed is 8.
  await startRegistration(page, 'Sphinx Fiber');
  await pickSheet(page, sheet([[...BOX, FIX_SPLICE, '100', '9']]));
  await expect(page.getByText(/أقصى سعر مسموح 8/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'تسجيل البنود' })).toBeDisabled();
  // The same file again with a price that fits.
  await pickSheet(page, sheet([[...BOX, FIX_SPLICE, '100', '8']]), 'fixed.xlsx');
  await expect(page.getByText(/أقصى سعر مسموح/)).toHaveCount(0);
  await page.getByRole('button', { name: 'تسجيل البنود' }).click();
  await expect(page.getByText('800.00 EGP')).toBeVisible();

  // The scopes show on the lines, with the per-line summary; the uploaded files are listed.
  const nile = page.getByRole('table', { name: 'بنود Nile Cables' });
  await expect(nile).toContainText(FIX_BRACKET);
  await expect(nile).toContainText('البند كامل');
  await expect(nile).toContainText('مقسّم: 3 نطاقات');
  await expect(page.getByText('lines.xlsx').first()).toBeVisible();

  // A dated price must keep the scopes within the contract price: this scope may not pass 10.
  await nile.getByRole('button', { name: 'إضافة سعر بتاريخ 2-12-4-8' }).click();
  await page.getByLabel('السعر من تاريخ (2-12-4-8)').fill('2026-11-20');
  await page.getByLabel('السعر الجديد (2-12-4-8)').fill('11');
  await nile.getByRole('button', { name: 'حفظ' }).click();
  await expect(page.getByText(/أقصى سعر مسموح لهذا النطاق/)).toContainText('10');

  // More lines for Nile Cables: the same upload flow on the existing registration.
  await page.getByRole('link', { name: 'رفع بنود إضافية للمقاول Nile Cables' }).click();
  await expect(page).toHaveURL(/registrationId=/);
  await pickSheet(page, sheet([['T-2', 'ردم', 'م', null, '10', '3']]), 'more.xlsx');
  await page.getByRole('button', { name: 'تسجيل البنود' }).click();
  // 1375 + 10 × 3 = 1405
  await expect(page.getByText('1,405.00 EGP')).toBeVisible();
  await expect(page.getByText('more.xlsx')).toBeVisible();

  // Remove a registration after confirming.
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'حذف التسجيل Sphinx Fiber' }).click();
  await expect(page.getByRole('heading', { name: 'Sphinx Fiber', level: 3 })).toHaveCount(0);
});

test('the PM reads the subcontractors page from the project menu, with no actions', async ({
  page,
}) => {
  await loginAs(page, 'pm@example.com');
  await page.getByRole('link', { name: /القاهرة الجديدة/ }).click();
  await page.getByRole('link', { name: 'المقاولين الباطن', exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/.+\/contractors$/);
  await expect(page.getByRole('heading', { name: 'المقاولين الباطن', level: 1 })).toBeVisible();
  await expect(page.getByText('عرض للقراءة فقط')).toBeVisible();
  await expect(page.getByText(/لا يوجد أمر تكليف لهذا المشروع/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'رفع بنود إضافية' })).toHaveCount(0);
});
