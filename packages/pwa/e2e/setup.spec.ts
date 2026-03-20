// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Setup screen tests -- verifies the player shows setup when unconfigured.
 *
 * Note: the test proxy server injects config by default. These tests either
 * navigate directly to setup.html or clear localStorage to simulate no config.
 */
import { test, expect } from '@playwright/test';

test.describe('Setup screen', () => {
  test('redirects to setup.html when no config is present', async ({ page }) => {
    // Clear config injected by proxy: intercept the page, run before scripts
    await page.addInitScript(() => localStorage.clear());

    // Navigate — should redirect to setup.html since localStorage is empty
    await page.goto('/player/');
    await page.waitForURL('**/setup.html**', { timeout: 5_000 });

    expect(page.url()).toContain('setup.html');
  });

  test('setup page shows CMS URL and CMS Key fields', async ({ page }) => {
    await page.goto('/player/setup.html');

    await expect(page.locator('#cms-url')).toBeVisible();
    await expect(page.locator('#cms-key')).toBeVisible();
    await expect(page.locator('#display-name')).toBeVisible();
  });

  test('setup page has Xibo Player branding', async ({ page }) => {
    await page.goto('/player/setup.html');

    await expect(page).toHaveTitle(/Xibo Player Setup/);
  });
});
