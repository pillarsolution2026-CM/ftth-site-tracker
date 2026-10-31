import { expect, test, type Page } from '@playwright/test';

async function loginAs(page: Page, email: string) {
  await page.goto('/ar/login');
  await page.getByLabel('البريد الإلكتروني').fill(email);
  await page.getByLabel('كلمة المرور').fill('correct-password');
  await page.getByRole('button', { name: 'دخول' }).click();
}

test('an admin sees every project, creates a user and a project, names a zone and assigns a supervisor', async ({
  page,
}) => {
  await loginAs(page, 'admin@example.com');
  await expect(page.getByRole('heading', { name: 'كل المشاريع' })).toBeVisible();
  // The admin has no membership, yet the existing project is listed and opens.
  await page.getByRole('link', { name: 'شبكة الألياف - القاهرة الجديدة' }).click();
  await expect(page).toHaveURL(/\/projects\/0f8fad5b-d9cb-469f-a165-70867728950e/);
  await expect(page.getByLabel('المشروع', { exact: true })).toHaveValue(
    '0f8fad5b-d9cb-469f-a165-70867728950e',
  );

  await page.goto('/ar/admin/users');
  await page.getByLabel('البريد الإلكتروني').fill('supervisor.one@example.com');
  await page.getByLabel('الاسم الظاهر').fill('مشرف واحد');
  await page.getByLabel('كلمة المرور الأولى').fill('short');
  await page.getByRole('button', { name: 'إنشاء المستخدم' }).click();
  await expect(page.getByText('كلمة المرور من 12 إلى 128 حرفًا')).toBeVisible();
  await page.getByLabel('كلمة المرور الأولى').fill('a-good-long-password');
  await page.getByRole('button', { name: 'إنشاء المستخدم' }).click();
  await expect(page.getByText('تم إنشاء المستخدم')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'supervisor.one@example.com' })).toBeVisible();

  await page.goto('/ar/admin/projects');
  // Suggested from the existing project; the client and the currency come from the contract.
  await expect(page.getByLabel('نظام الإحداثيات (EPSG)')).toHaveValue('32636');
  await expect(page.getByLabel('العميل')).toHaveCount(0);
  await expect(page.getByLabel('العملة')).toHaveCount(0);
  await page.getByLabel('اسم أمر التكليف / المشروع').fill('مشروع شبرا');
  await page.getByRole('button', { name: 'إنشاء أمر التكليف / المشروع' }).click();
  await expect(page.getByText('اختر العقد', { exact: true }).last()).toBeVisible();
  await page
    .getByLabel('العقد', { exact: true })
    .selectOption({ label: 'C-SEED — عقد الشبكة — Client — EGP' });
  await page.getByRole('button', { name: 'إنشاء أمر التكليف / المشروع' }).click();
  await expect(page.getByRole('heading', { name: 'مشروع شبرا' })).toBeVisible();

  await page.getByLabel('الدور').selectOption('supervisor');
  await expect(page.getByText('أضف منطقة أولًا لإسناد مشرف أو مقاول باطن')).toBeVisible();
  await page.getByLabel('اسم المنطقة').fill('المنطقة أ');
  await page.getByRole('button', { name: 'إضافة منطقة' }).click();
  await expect(page.getByText('المنطقة أ').first()).toBeVisible();

  await page
    .getByLabel('المستخدم')
    .selectOption({ label: 'مشرف واحد — supervisor.one@example.com' });
  await page.getByLabel('المنطقة', { exact: true }).selectOption({ label: 'المنطقة أ' });
  await page.getByRole('button', { name: 'إسناد' }).click();
  await expect(page.getByRole('cell', { name: 'المنطقة أ' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'مشرف', exact: true })).toBeVisible();
});

test('a non-admin is refused the admin screens and keeps seeing only memberships', async ({
  page,
}) => {
  await loginAs(page, 'pm@example.com');
  await expect(page.getByRole('heading', { name: 'مشاريعي' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'إدارة المشاريع والمستخدمين' })).toHaveCount(0);
  await page.goto('/ar/admin/users');
  await expect(page.getByText('هذه الصفحة لمدير النظام فقط')).toBeVisible();
});
