import { devices, expect, test } from '@playwright/test';

const API_BASE_URL = process.env['E2E_API_BASE_URL'] ?? 'http://localhost:3000';

test.use({ ...devices['Pixel 5'] });

test('mobile beta login loads the workspace without overflow and remains keyboard operable', async ({
  page,
  request,
}) => {
  const suffix = `${Date.now().toString()}-${Math.random().toString(36).slice(2)}`;
  const email = `mobile-e2e-${suffix}@luminaos.test`;
  const password = 'mobile-e2e-password-123';
  const newPassword = 'mobile-e2e-new-password-456';
  const workspaceName = `Mobile E2E ${suffix}`;

  const registerResponse = await request.post(`${API_BASE_URL}/auth/register`, {
    data: { email, password },
  });
  expect(registerResponse.ok()).toBe(true);

  const workspaceResponse = await request.post(`${API_BASE_URL}/workspaces`, {
    data: { name: workspaceName },
  });
  expect(workspaceResponse.ok()).toBe(true);

  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Hesabınıza giriş yapın' })).toBeVisible();
  const emailInput = page.getByLabel('E-posta');
  const passwordInput = page.getByLabel('Parola');
  const loginButton = page.getByRole('button', { name: 'Giriş yap' });

  await emailInput.focus();
  await page.keyboard.press('Tab');
  await expect(passwordInput).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(loginButton).toBeFocused();

  await emailInput.fill(email);
  await passwordInput.fill(password);
  await loginButton.click();

  await expect(page.getByRole('heading', { name: 'LuminaOS' })).toBeVisible();
  await expect(page.getByText(workspaceName, { exact: true })).toBeVisible();
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  await expect(page.locator('details.advanced-tools')).not.toHaveAttribute('open', '');

  const viewportWidth = page.viewportSize()?.width;
  expect(viewportWidth).toBeDefined();
  const documentWidth = await page.evaluate<number>('document.documentElement.scrollWidth');
  expect(documentWidth).toBeLessThanOrEqual(viewportWidth ?? 0);

  for (const control of [
    page.getByTestId('view-tab-list'),
    page.getByTestId('view-tab-board'),
    page.getByRole('button', { name: 'Çıkış yap' }),
  ]) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }

  await page.getByText('Gelişmiş araçlar ve ayarlar', { exact: true }).click();
  await page.getByLabel('Mevcut parola').fill(password);
  await page.getByLabel('Yeni parola', { exact: true }).fill(newPassword);
  await page.getByLabel('Yeni parola tekrarı').fill(newPassword);
  await page.getByRole('button', { name: 'Parolayı değiştir' }).click();
  await expect(
    page.getByText('Parolanız güncellendi. Diğer açık oturumlar kapatıldı.', { exact: true }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Çıkış yap' }).click();
  await expect(page.getByRole('heading', { name: 'Hesabınıza giriş yapın' })).toBeVisible();

  await page.getByLabel('E-posta').fill(email);
  await page.getByLabel('Parola').fill(newPassword);
  await page.getByRole('button', { name: 'Giriş yap' }).click();
  await expect(page.getByText(workspaceName, { exact: true })).toBeVisible();
});
