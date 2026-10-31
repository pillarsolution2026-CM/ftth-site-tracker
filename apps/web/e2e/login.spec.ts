import { expect, test } from '@playwright/test';

test('Arabic login page is right-to-left', async ({ page }) => {
  await page.goto('/ar/login');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.getByRole('heading', { name: 'تسجيل الدخول' })).toBeVisible();
});

test('root redirects to /ar and protected pages require a session', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/ar\/login$/);
});

test('successful login shows the welcome text and role, and logout returns to login', async ({
  page,
}) => {
  await page.goto('/ar/login');
  await page.getByLabel('البريد الإلكتروني').fill('pm@example.com');
  await page.getByLabel('كلمة المرور').fill('correct-password');
  await page.getByRole('button', { name: 'دخول' }).click();

  await expect(page.getByRole('heading', { name: 'أهلًا منى أحمد' })).toBeVisible();
  // The PM has two projects (the second one is under a draft contract), so the badge shows twice.
  await expect(page.getByText('مدير المشروع').first()).toBeVisible();

  // The browser never sees the tokens.
  expect(await page.evaluate(() => document.cookie)).toBe('');

  await page.getByRole('button', { name: 'تسجيل الخروج' }).click();
  await expect(page).toHaveURL(/\/ar\/login$/);
});

test('wrong password shows the Arabic INVALID_CREDENTIALS message', async ({ page }) => {
  await page.goto('/ar/login');
  await page.getByLabel('البريد الإلكتروني').fill('pm@example.com');
  await page.getByLabel('كلمة المرور').fill('wrong-password');
  await page.getByRole('button', { name: 'دخول' }).click();

  await expect(page.locator('form').getByRole('alert')).toContainText(
    'البريد الإلكتروني أو كلمة المرور غير صحيحة',
  );
});
