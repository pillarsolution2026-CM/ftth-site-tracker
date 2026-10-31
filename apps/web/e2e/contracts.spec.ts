import { expect, test, type Page } from '@playwright/test';

async function loginAs(page: Page, email: string) {
  await page.goto('/ar/login');
  await page.getByLabel('البريد الإلكتروني').fill(email);
  await page.getByLabel('كلمة المرور').fill('correct-password');
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page).toHaveURL(/\/ar$/);
}

// The mock API reads this stand-in for an .xlsx: the zip magic followed by JSON (see mock-api.ts).
// A heading row has no unit and no price; the two units differ only by spaces (UNIT_FORM_VARIANT).
function boqFixture(): Buffer {
  const sheets = [
    {
      name: 'BOQ',
      header: ['مسلسل', 'الوصف', 'الوحدة', 'الكمية', 'سعر الوحدة', 'نوع الأعمال'],
      rows: [
        ['1', 'أعمال مدنية', '', '', '', ''],
        ['1-1', 'حفر خندق', 'BULDING (1 to 8)', '10', '2.5', 'مدني'],
        ['1-2', 'ردم خندق', 'BULDING  (1 to 8)', '4', '1', 'مدني'],
      ],
    },
  ];
  return Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from(JSON.stringify({ sheets })),
  ]);
}

test('an admin creates a contract, imports a BOQ with headings, approves it, then creates a project under it', async ({
  page,
}) => {
  await loginAs(page, 'admin@example.com');
  await page.goto('/ar/admin/contracts');
  await expect(page.getByRole('link', { name: 'العقود', exact: true })).toBeVisible();

  await page.getByLabel('رقم العقد').fill('C-77');
  await page.getByLabel('اسم العقد').fill('عقد القاهرة');
  await page.getByLabel('العميل', { exact: true }).fill('عميل المقايسة');
  await page.getByLabel('العملة').fill('egp');
  await expect(page.getByText('رمز ISO، مثل EGP. لا يمكن تغييرها لاحقًا.')).toBeVisible();
  await page.getByRole('button', { name: 'إنشاء العقد' }).click();

  await expect(page.getByRole('heading', { name: /العقد\s+C-77/ })).toBeVisible();
  await expect(page.getByText('مسودة')).toBeVisible();
  await expect(page.getByText('لا توجد بنود في المقايسة بعد')).toBeVisible();

  // Import: headings become section rows, the unit variant is a warning, nothing blocks.
  await page.getByRole('link', { name: 'استيراد من Excel' }).click();
  await page.locator('#import-file').setInputFiles({
    name: 'boq.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: boqFixture(),
  });
  await expect(page.getByTestId('import-total')).toHaveText('29.00');
  await expect(page.locator('#map-code')).toHaveValue('0');
  await expect(page.getByText('عنوان قسم').first()).toBeVisible();
  await expect(page.getByText('نفس الوحدة مكتوبة بشكل مختلف في الصفوف 4').first()).toBeVisible();
  await expect(page.getByText('نفس الوحدة مكتوبة بشكل مختلف في الصفوف 3').first()).toBeVisible();

  const replace = page.getByRole('button', { name: 'استبدال بنود المقايسة' });
  await expect(replace).toBeDisabled();
  await expect(page.getByText(/يستبدل كل بنود المقايسة الحالية/)).toBeVisible();
  await page.locator('#import-confirm-replace').check();
  await expect(replace).toBeEnabled();
  await replace.click();

  await expect(page).toHaveURL(/\/admin\/contracts\/[0-9a-f-]{36}$/);
  const boq = page.getByRole('table', { name: 'المقايسة (بنود العقد)' });
  await expect(boq.getByText('أعمال مدنية')).toBeVisible();
  await expect(boq.getByRole('row')).toHaveCount(5); // header + heading + 2 items + total
  await expect(page.getByTestId('boq-total')).toContainText('29.00 EGP');

  // Approval is final: a confirmation first, then the BOQ is locked.
  await page.getByRole('button', { name: 'اعتماد العقد' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'اعتماد العقد؟' });
  await expect(dialog.getByText(/الاعتماد نهائي ولا يمكن التراجع عنه/)).toBeVisible();
  await dialog.getByRole('button', { name: 'اعتماد نهائي' }).click();
  await expect(page.getByText('معتمد').first()).toBeVisible();
  await expect(page.getByText(/المقايسة مقفلة/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'إضافة بند' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'استيراد من Excel' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'اعتماد العقد' })).toHaveCount(0);

  // The header stays editable after approval, the currency does not.
  await page.getByRole('button', { name: 'تعديل بيانات العقد' }).click();
  await expect(page.getByLabel('العملة')).toHaveAttribute('readonly', '');
  await page.getByRole('button', { name: 'إلغاء' }).click();

  // A project (work order) is created under that contract: client and currency come from it.
  await page.goto('/ar/admin/projects');
  await page.getByLabel('اسم أمر التكليف / المشروع').fill('أمر تكليف شبرا');
  await expect(page.getByLabel('العميل')).toHaveCount(0);
  await page
    .getByLabel('العقد', { exact: true })
    .selectOption({ label: 'C-77 — عقد القاهرة — عميل المقايسة — EGP' });
  await page.getByRole('button', { name: 'إنشاء أمر التكليف / المشروع' }).click();
  await expect(page.getByRole('heading', { name: 'أمر تكليف شبرا' })).toBeVisible();
  await expect(page.getByText('C-77')).toBeVisible();
  await expect(page.getByText('عميل المقايسة')).toBeVisible();
});

test('a PM reads the contract of the project, read-only', async ({ page }) => {
  await loginAs(page, 'pm@example.com');
  await page.getByRole('link', { name: /القاهرة الجديدة/ }).click();
  await page.getByRole('link', { name: 'العقد', exact: true }).click();

  await expect(page).toHaveURL(/\/projects\/0f8fad5b-d9cb-469f-a165-70867728950e\/contract$/);
  await expect(page.getByRole('heading', { name: 'العقد', exact: true })).toBeVisible();
  await expect(page.getByText('عرض للقراءة فقط')).toBeVisible();
  const boq = page.getByRole('table', { name: 'المقايسة (بنود العقد)' });
  await expect(boq.getByText('أعمال مدنية')).toBeVisible();
  await expect(boq.getByText('حفر خندق')).toBeVisible();
  await expect(page.getByRole('button', { name: 'اعتماد العقد' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'إضافة بند' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'استيراد من Excel' })).toHaveCount(0);

  // The BFF only exposes the admin contract routes to admins (the mock answers 403 to a PM).
  const response = await page.request.get('/api/admin/contracts');
  expect(response.status()).toBe(403);
});
