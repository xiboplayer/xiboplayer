/**
 * REST API — Live Integration Tests
 *
 * Tests the RestClient transport against a real Xibo CMS instance
 * with the Player API module deployed.
 *
 * Prerequisites:
 *   - CMS at CMS_URL must have /api/v2/player/* endpoints deployed
 *   - A display with the given HARDWARE_KEY must exist and be authorized
 *   - The SERVER_KEY must match the CMS setting
 *
 * Run with:
 *   CMS_URL=https://displays.superpantalles.com \
 *   CMS_KEY=isiSdUCy \
 *   HARDWARE_KEY=pwa-11e79847294d418ba74df4ba534d \
 *   npx vitest run src/xmds.rest.integration.test.js
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { RestClient } from './rest-client.js';

// ─── Configuration ─────────────────────────────────────────────────

const CMS_URL = process.env.CMS_URL || 'https://your-cms.example.com';
const CMS_KEY = process.env.CMS_KEY || 'your-cms-key';
const HARDWARE_KEY = process.env.HARDWARE_KEY || 'pwa-your-hardware-key';
const DISPLAY_NAME = process.env.DISPLAY_NAME || 'REST Integration Test';

// Skip all tests if no CMS_URL is provided
const SKIP = !process.env.CMS_URL && !process.env.CI && !process.env.RUN_INTEGRATION;

// ─── Test Suite ────────────────────────────────────────────────────

describe.skipIf(SKIP)('REST API — Live Integration', () => {
  /** @type {RestClient} */
  let client;

  beforeAll(() => {
    // Restore real fetch (vitest.setup.js mocks it for unit tests)
    if (global.__nativeFetch) global.fetch = global.__nativeFetch;

    client = new RestClient({
      cmsUrl: CMS_URL,
      cmsKey: CMS_KEY,
      hardwareKey: HARDWARE_KEY,
      displayName: DISPLAY_NAME,
      xmrChannel: 'rest-integration-test',
      retryOptions: { maxRetries: 1, baseDelayMs: 500 },
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Health & Availability
  // ──────────────────────────────────────────────────────────────────

  describe('Health & Availability', () => {
    it('should detect REST availability via static isAvailable()', async () => {
      const available = await RestClient.isAvailable(CMS_URL);
      expect(available).toBe(true);
    });

    it('should return false for a CMS without REST API', async () => {
      const available = await RestClient.isAvailable('http://127.0.0.1:1', { maxRetries: 0 });
      expect(available).toBe(false);
    }, 10000);
  });

  // ──────────────────────────────────────────────────────────────────
  // JWT Authentication
  // ──────────────────────────────────────────────────────────────────

  describe('JWT Authentication', () => {
    it('should authenticate and obtain a JWT token', async () => {
      client._token = null;
      await client._authenticate();

      expect(client._token).toBeDefined();
      expect(client._token.length).toBeGreaterThan(50);
      expect(client._displayId).toBeGreaterThan(0);
      expect(client._tokenExpiresAt).toBeGreaterThan(Date.now());
    });

    it('should reuse token for subsequent calls', async () => {
      const token1 = await client._getToken();
      const token2 = await client._getToken();
      expect(token1).toBe(token2);
    });

    it('should fail auth with wrong server key', async () => {
      const bad = new RestClient({
        cmsUrl: CMS_URL,
        cmsKey: 'wrong-key',
        hardwareKey: HARDWARE_KEY,
        retryOptions: { maxRetries: 0 },
      });

      await expect(bad._authenticate()).rejects.toThrow(/403|forbidden|server key/i);
    });

    it('should fail auth with wrong hardware key', async () => {
      const bad = new RestClient({
        cmsUrl: CMS_URL,
        cmsKey: CMS_KEY,
        hardwareKey: 'nonexistent-display',
        retryOptions: { maxRetries: 0 },
      });

      await expect(bad._authenticate()).rejects.toThrow(/403|not found|denied/i);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // RegisterDisplay
  // ──────────────────────────────────────────────────────────────────

  describe('RegisterDisplay', () => {
    it('should register and return READY', async () => {
      const result = await client.registerDisplay();

      expect(result).toBeDefined();
      expect(result.code).toBe('READY');
      expect(result.settings).toBeDefined();
      expect(result.message).toContain('Display is active');
    });

    it('should include expected settings keys', async () => {
      const result = await client.registerDisplay();
      if (result.code !== 'READY') return;

      for (const key of ['collectInterval', 'statsEnabled', 'xmrNetworkAddress']) {
        expect(result.settings, `Missing setting: ${key}`).toHaveProperty(key);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // RequiredFiles (media)
  // ──────────────────────────────────────────────────────────────────

  describe('RequiredFiles', () => {
    it('should return files in flat format', async () => {
      const result = await client.requiredFiles();

      expect(result).toHaveProperty('files');
      expect(result).toHaveProperty('purge');
      expect(Array.isArray(result.files)).toBe(true);
      expect(result.files.length).toBeGreaterThan(0);
    });

    it('should include media files with download URLs', async () => {
      const { files } = await client.requiredFiles();
      const media = files.filter(f => f.type === 'media');

      expect(media.length).toBeGreaterThan(0);
      for (const file of media) {
        expect(file.id).toBeDefined();
        expect(file.md5).toBeDefined();
        expect(file.path).toMatch(/^https?:\/\//);
      }
    });

    it('should include layout files', async () => {
      const { files } = await client.requiredFiles();
      const layouts = files.filter(f => f.type === 'layout');

      expect(layouts.length).toBeGreaterThan(0);
      for (const layout of layouts) {
        expect(layout.id).toBeDefined();
        expect(layout.md5).toBeDefined();
      }
    });

    it('should support ETag caching', async () => {
      client._etags.clear();
      client._responseCache.clear();

      await client.requiredFiles();
      const hasEtag = client._etags.has(`/displays/${client._displayId}/media`);
      expect(hasEtag).toBe(true);

      // Second call should use cache
      const result2 = await client.requiredFiles();
      expect(result2.files.length).toBeGreaterThan(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Schedule
  // ──────────────────────────────────────────────────────────────────

  describe('Schedule', () => {
    it('should return native JSON schedule', async () => {
      const schedule = await client.schedule();

      expect(schedule).toBeDefined();
      expect(schedule).toHaveProperty('layouts');
      expect(schedule).toHaveProperty('overlays');
      expect(Array.isArray(schedule.layouts)).toBe(true);
    });

    it('should include default layout', async () => {
      const schedule = await client.schedule();
      expect(schedule.default).toBeDefined();
    });

    it('should support ETag caching', async () => {
      client._etags.clear();
      client._responseCache.clear();

      await client.schedule();
      expect(client._etags.has(`/displays/${client._displayId}/schedule`)).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Reporting Endpoints
  // ──────────────────────────────────────────────────────────────────

  describe('NotifyStatus', () => {
    it('should report status successfully', async () => {
      const result = await client.notifyStatus({ currentLayoutId: 483 });
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });
  });

  describe('SubmitLog', () => {
    it('should submit logs as XML string', async () => {
      const result = await client.submitLog(
        '<logs><log date="2026-03-01" category="info" type="info" message="REST integration test" method="test" /></logs>'
      );
      expect(result).toBe(true);
    });

    it('should submit logs as array', async () => {
      const result = await client.submitLog([
        { date: new Date().toISOString(), category: 'General', type: 'info', message: 'REST array log test' },
      ]);
      expect(result).toBe(true);
    });
  });

  describe('SubmitStats', () => {
    it('should submit proof-of-play stats', async () => {
      const now = new Date();
      const result = await client.submitStats([{
        type: 'layout',
        fromDt: new Date(now - 60000).toISOString(),
        toDt: now.toISOString(),
        scheduleId: '0',
        layoutId: '483',
        mediaId: '',
        tag: 'rest-integration-test',
      }]);
      expect(result).toBe(true);
    });
  });

  describe('MediaInventory', () => {
    it('should submit inventory as array', async () => {
      const result = await client.mediaInventory([
        { id: '1', complete: '1', md5: 'abf73257821e2cf601d299c509726c03', lastChecked: new Date().toISOString() },
      ]);
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Full Boot Sequence
  // ──────────────────────────────────────────────────────────────────

  describe('Full Player Boot Sequence', () => {
    it('should execute the complete boot sequence', async () => {
      const bootClient = new RestClient({
        cmsUrl: CMS_URL,
        cmsKey: CMS_KEY,
        hardwareKey: HARDWARE_KEY,
        displayName: 'Boot Sequence Test',
        xmrChannel: 'boot-test',
        retryOptions: { maxRetries: 1, baseDelayMs: 500 },
      });

      // 1. Register
      const reg = await bootClient.registerDisplay();
      expect(reg.code).toBe('READY');

      // 2. RequiredFiles
      const { files } = await bootClient.requiredFiles();
      expect(files.length).toBeGreaterThan(0);

      // 3. Schedule
      const schedule = await bootClient.schedule();
      expect(schedule).toBeDefined();

      // 4. Status
      const status = await bootClient.notifyStatus({ currentLayoutId: schedule.default || 0 });
      expect(status.success).toBe(true);

      // 5. Log
      const logOk = await bootClient.submitLog([{
        date: new Date().toISOString(), category: 'General', type: 'info',
        message: 'REST boot sequence complete',
      }]);
      expect(logOk).toBe(true);

      // 6. Stats
      const now = new Date();
      const statsOk = await bootClient.submitStats([{
        type: 'layout', fromDt: new Date(now - 10000).toISOString(),
        toDt: now.toISOString(), scheduleId: '0',
        layoutId: String(schedule.default || '0'), mediaId: '', tag: 'boot',
      }]);
      expect(statsOk).toBe(true);

      // 7. Inventory
      const inv = await bootClient.mediaInventory(files.filter(f => f.type === 'media').slice(0, 5).map(f => ({
        id: f.id, complete: '1', md5: f.md5 || '', lastChecked: now.toISOString(),
      })));
      expect(inv.success).toBe(true);
    });
  });
});
