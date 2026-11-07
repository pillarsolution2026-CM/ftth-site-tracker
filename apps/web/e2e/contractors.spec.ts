import { expect, test, type Page } from '@playwright/test';

// Subcontractors (ADR-036). The mock API (mock-contractors.ts) gives every project except the two
// seeded ones a virtual work order with lines T-1 (100 @ 12.5), T-2 (40 @ 3) and a legacy line, so
// this flow creates its own project and does not touch the state the other specs share.

async function loginAs(page: Page, email: string) {
  await page.goto('/ar/login');
  await page.getByLabel('البريد الإلكتروني').fill(email);
  await page.getByLabel('كلمة المرور').fill('correct-password');
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page).toHaveURL(/\/ar$/);
}

test('an admin adds a subcontractor, registers it on a work order with a price, adds a dated price and removes it', async ({
  page,
}) => {
  await loginAs(page, 'admin@example.com');

  // The shared list of contractors.
  await page.goto('/ar/admin/contractors');
  await expect(page.getByRole('link', { name: 'المقاولين الباطن', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'إنشاء المقاول' }).click();
  await expect(page.getByText('هذا الحقل مطلوب').first()).toBeVisible();
  await page.getByLabel('الاسم', { exact: true }).fill('Nile Cables');
  await page.getByLabel('الشخص المسؤول').fill('Hassan Ali');
  await page.getByLabel('الهاتف').fill('0100 123 4567');
  await page.getByRole('button', { name: 'إنشاء المقاول' }).click();
  await expect(page.getByText('تم إنشاء المقاول')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Nile Cables', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'تعديل Nile Cables' }).click();
  await page.getByLabel('الشخص المسؤول').fill('Omar Fathy');
  await page.getByRole('button', { name: 'حفظ' }).click();
  await expect(page.getByText('تم حفظ التعديلات')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Omar Fathy', exact: true })).toBeVisible();

  // A new project (so it has its own work order in the mock).
  await page.goto('/ar/admin/projects');
  await page.getByLabel('اسم أمر التكليف / المشروع').fill('مشروع المقاولين');
  await page
    .getByLabel('العقد', { exact: true })
    .selectOption({ label: 'C-SEED — عقد الشبكة — Client — EGP' });
  await page.getByRole('button', { name: 'إنشاء أمر التكليف / المشروع' }).click();
  await expect(page.getByRole('heading', { name: 'مشروع المقاولين' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'المقاولين الباطن', level: 2 })).toBeVisible();

  // Register: the legacy line is disabled with its reason; the checks block a bad quantity.
  await page.getByRole('button', { name: 'تسجيل مقاول' }).click();
  await expect(page.getByLabel('إسناد البند OLD-1')).toBeDisabled();
  await expect(page.getByText('بند قديم: لا يمكن إسناده لمقاول')).toBeVisible();
  await page.getByLabel('المقاول', { exact: true }).selectOption({ label: 'Nile Cables' });
  await page.getByLabel('تاريخ التسجيل').fill('2026-11-07');
  await page.getByLabel('إسناد البند T-1').check();
  await page.getByLabel('الكمية (T-1)').fill('150');
  await page.getByRole('button', { name: 'تسجيل', exact: true }).click();
  await expect(page.getByText(/الكمية أكبر من المتاح/)).toContainText('100');
  await page.getByLabel('الكمية (T-1)').fill('30');
  await page.getByRole('button', { name: 'تسجيل', exact: true }).click();

  // 30 × 12.5 = 375, exact.
  await expect(page.getByRole('heading', { name: 'Nile Cables', level: 3 })).toBeVisible();
  await expect(page.getByText(/إجمالي هذا المقاول/)).toContainText('375.00 EGP');

  const lines = page.getByRole('table', { name: 'بنود Nile Cables' });
  // A dated price: it must come after the first one (the registration date).
  await page.getByRole('button', { name: 'إضافة سعر بتاريخ T-1' }).click();
  await page.getByLabel('السعر من تاريخ (T-1)').fill('2026-11-07');
  await page.getByLabel('السعر الجديد (T-1)').fill('11.5');
  await lines.getByRole('button', { name: 'حفظ' }).click();
  await expect(page.getByText(/التاريخ يجب أن يكون بعد آخر تاريخ سعر/)).toBeVisible();
  await page.getByLabel('السعر من تاريخ (T-1)').fill('2026-11-20');
  await lines.getByRole('button', { name: 'حفظ' }).click();
  await expect(page.getByText(/إجمالي هذا المقاول/)).toContainText('345.00 EGP');

  // Remove the registration after confirming.
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'حذف التسجيل Nile Cables' }).click();
  await expect(page.getByText('لا يوجد مقاول مسجَّل على أمر التكليف بعد.')).toBeVisible();
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
  await expect(page.getByRole('button', { name: 'تسجيل مقاول' })).toHaveCount(0);
});
