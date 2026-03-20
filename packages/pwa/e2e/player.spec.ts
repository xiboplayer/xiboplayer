// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Player lifecycle tests -- config injection, collection cycle, rendering.
 *
 * The test server (webServer in playwright.config.ts) passes pwaConfig to the
 * proxy, which injects CMS config into index.html before inline scripts run.
 * This is the same mechanism used in production (Electron / proxy).
 */
import { test, expect } from '@playwright/test';
import { mockCms, extractAction } from './helpers/mock-cms';

const CMS_CONFIG = { displayName: 'E2E Test Display' };

test.describe('Player with config', () => {
  test.beforeEach(async ({ page }) => {
    await mockCms(page, CMS_CONFIG);
  });

  test('does not redirect to setup when config is injected', async ({ page }) => {
    await page.goto('/player/');
    await page.waitForTimeout(2_000);
    expect(page.url()).not.toContain('setup.html');
    expect(page.url()).toContain('/player');
  });

  test('player-container is present and visible', async ({ page }) => {
    await page.goto('/player/');
    const container = page.locator('#player-container');
    await expect(container).toBeVisible();
  });

  test('registers with CMS via XMDS', async ({ page }) => {
    const xmdsRequests: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('xmds-proxy')) {
        const body = req.postData() ?? '';
        const action = extractAction(body);
        if (action) xmdsRequests.push(action);
      }
    });

    await page.goto('/player/');

    await expect(async () => {
      expect(xmdsRequests).toContain('RegisterDisplay');
    }).toPass({ timeout: 15_000 });
  });

  test('fetches schedule after registration', async ({ page }) => {
    const xmdsRequests: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('xmds-proxy')) {
        const body = req.postData() ?? '';
        const action = extractAction(body);
        if (action) xmdsRequests.push(action);
      }
    });

    await page.goto('/player/');

    await expect(async () => {
      expect(xmdsRequests).toContain('RegisterDisplay');
      expect(xmdsRequests).toContain('Schedule');
    }).toPass({ timeout: 15_000 });
  });

  test('status bar shows version and CMS info on hover', async ({ page }) => {
    await page.goto('/player/');
    await page.waitForTimeout(5_000);

    const configInfo = page.locator('#config-info');
    await page.hover('body', { position: { x: 10, y: 10 } });

    await expect(configInfo).toBeVisible({ timeout: 5_000 });
    const text = await configInfo.textContent();
    expect(text).toContain('CMS:');
  });
});
