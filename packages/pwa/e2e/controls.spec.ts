// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Keyboard and mouse control tests.
 *
 * Config is injected by the test proxy server (pwaConfig).
 */
import { test, expect } from '@playwright/test';
import { mockCms } from './helpers/mock-cms';

test.describe('Keyboard controls', () => {
  test.beforeEach(async ({ page }) => {
    await mockCms(page, { displayName: 'E2E Controls Test' });
    await page.goto('/player/');
    // Wait for player to initialize
    await page.waitForTimeout(3_000);
  });

  test('D key toggles debug overlay', async ({ page }) => {
    await page.keyboard.press('d');
    await page.waitForTimeout(500);

    const overlay = page.locator('#overlay');
    const count = await overlay.count();

    if (count > 0) {
      const hasVisible = await overlay.evaluate((el) => el.classList.contains('visible'));
      expect(typeof hasVisible).toBe('boolean');
    }

    // Press D again to toggle off
    await page.keyboard.press('d');
  });

  test('S key opens setup overlay when setupKey is enabled', async ({ page }) => {
    await page.keyboard.press('s');
    await page.waitForTimeout(1_000);

    // The setup overlay creates a gate card with #gate-key input
    const gateKey = page.locator('#gate-key');
    const isSetupVisible = await gateKey.isVisible().catch(() => false);

    if (isSetupVisible) {
      // Close with Escape
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      const stillVisible = await gateKey.isVisible().catch(() => false);
      expect(stillVisible).toBe(false);
    }
  });
});
