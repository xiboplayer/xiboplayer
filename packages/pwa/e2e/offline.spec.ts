// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Offline resilience tests.
 *
 * Verifies the player continues rendering after going offline
 * and does not crash or show an error page.
 */
import { test, expect } from '@playwright/test';
import { mockCms } from './helpers/mock-cms';

test.describe('Offline resilience', () => {
  test.beforeEach(async ({ page }) => {
    await mockCms(page, { displayName: 'E2E Offline Test' });
  });

  test('player continues rendering after going offline', async ({ page, context }) => {
    await page.goto('/player/');

    // Wait for player to fully initialize and render
    const container = page.locator('#player-container');
    await expect(container).toBeVisible({ timeout: 10_000 });

    // Capture a reference to what's rendered before going offline
    const contentBefore = await container.innerHTML();

    // Go offline
    await context.setOffline(true);

    // Wait a bit and verify the player is still rendering
    await page.waitForTimeout(3_000);

    await expect(container).toBeVisible();
    const contentAfter = await container.innerHTML();

    // Container should still have content (not be empty)
    expect(contentAfter.length).toBeGreaterThan(0);

    // Restore connectivity for cleanup
    await context.setOffline(false);
  });

  test('player does not show error page when offline', async ({ page, context }) => {
    await page.goto('/player/');

    // Wait for player initialization
    const container = page.locator('#player-container');
    await expect(container).toBeVisible({ timeout: 10_000 });

    // Go offline
    await context.setOffline(true);
    await page.waitForTimeout(3_000);

    // Verify no browser error page (ERR_INTERNET_DISCONNECTED etc.)
    const bodyText = await page.locator('body').innerText();
    expect(bodyText).not.toContain('ERR_INTERNET_DISCONNECTED');
    expect(bodyText).not.toContain('ERR_NETWORK_CHANGED');
    expect(bodyText).not.toContain('This site can');
    expect(bodyText).not.toContain('No internet');

    // The page URL should still be the player, not chrome-error://
    expect(page.url()).not.toContain('chrome-error');
    expect(page.url()).toContain('/player');

    // Restore connectivity for cleanup
    await context.setOffline(false);
  });
});
