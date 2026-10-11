import { expect } from '@playwright/test';

// These actions use the installed application's real renderer and bridge. They
// never consent to provider installation, log in, send a chat, or load a vault.
export async function verifyWindowsShell(app, page, project, { firstStart = false } = {}) {
  if (!project?.name) throw new Error('Missing isolated project identity.');
  await page.evaluate(() => window.aycode.updateSettings({ locale: 'en' }));
  const onboarding = page.locator('.onboarding');
  if (firstStart) {
    await expect(onboarding).toBeVisible({ timeout: 30_000 });
    await expect(onboarding.getByRole('list', { name: 'Steps of the introduction', exact: true })
      .getByRole('listitem')).toHaveCount(3);
    await onboarding.getByRole('button', { name: 'Set up an agent', exact: true }).click();
    await expect(onboarding.getByRole('heading', { name: 'Your agents', exact: true })).toBeVisible();
    await onboarding.getByRole('button', { name: 'Back', exact: true }).click();
    await onboarding.getByRole('button', { name: 'Skip introduction', exact: true }).click();
  }
  await expect(onboarding).toHaveCount(0);

  async function assertHiddenMenu() {
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows().filter(window => window.isVisible());
      return windows.length > 0 && windows.every(window =>
        window.isMenuBarAutoHide() && !window.isMenuBarVisible());
    }), { timeout: 15_000 }).toBe(true);
  }
  await assertHiddenMenu();
  // Rebuilding the native menu after a language change must not restore its row.
  await page.evaluate(() => window.aycode.updateSettings({ locale: 'de' }));
  await expect(page.getByRole('navigation', { name: 'Bereiche', exact: true })).toBeVisible();
  await assertHiddenMenu();
  await page.evaluate(() => window.aycode.updateSettings({ locale: 'en' }));

  const navigation = page.getByRole('navigation', { name: 'Areas', exact: true });
  await expect(navigation).toBeVisible();
  const more = navigation.getByRole('button', { name: /^More sections/ });
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(navigation.getByRole('button', { name: /^Graph(?:\s|$)/ })).toHaveCount(0);
  await navigation.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(page.locator('.projects')).toBeVisible();
  await page.locator('.project-card').getByRole('button', {
    name: `New chat in ${project.name}`, exact: true,
  }).click();
  const composer = page.getByRole('textbox', { name: 'What shall we start with?', exact: true });
  await expect(composer).toBeFocused();
  await composer.fill('Local Windows navigation fixture. Do not send.');
  const back = page.locator('.sidebar__header').getByRole('button', { name: 'Back', exact: true });
  await back.click();
  await expect(page.locator('.projects')).toBeVisible();
  await page.locator('.project-card').getByRole('button', {
    name: `New chat in ${project.name}`, exact: true,
  }).click();
  await expect(composer).toHaveValue('Local Windows navigation fixture. Do not send.');

  // Windows' real Control shortcut must still restore a hidden sidebar, and
  // Alt+Left belongs to navigation only after the text field relinquishes focus.
  await page.keyboard.press('Control+b');
  await expect(page.locator('.sidebar')).toBeHidden();
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(page.locator('.projects')).toBeVisible();
  await page.keyboard.press('Control+b');
  await expect(page.locator('.sidebar')).toBeVisible();
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await navigation.getByRole('button', { name: /^Graph(?:\s|$)/ }).click();
  await expect(page.locator('.graph-view')).toBeVisible();
  await back.click();
  await expect(page.locator('.projects')).toBeVisible();
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await assertHiddenMenu();
  return { firstStart, hiddenNativeMenu: true, languageMenuRebuild: true,
    directProjectChat: true, draftPreserved: true, backButton: true,
    controlSidebarShortcut: true, altLeftNavigation: true, discoverableGraph: true };
}
