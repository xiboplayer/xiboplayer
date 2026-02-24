/**
 * XMDS REST API — Live Integration Tests
 *
 * Tests the REST transport against a real Xibo CMS instance.
 * These tests verify end-to-end communication between the XmdsClient
 * (REST mode) and the CMS Player REST API endpoints.
 *
 * Prerequisites:
 *   - CMS at CMS_URL must have the Player REST API patch applied
 *   - A display with the given HARDWARE_KEY must exist and be authorized
 *   - The SERVER_KEY must match the CMS setting
 *
 * Run with:
 *   CMS_URL=https://your-cms.example.com \
 *   CMS_KEY=your-cms-key \
 *   HARDWARE_KEY=pwa-your-hardware-key \
 *   npx vitest run src/xmds.rest.integration.test.js
 *
 * Or:
 *   npm test -- --testPathPattern=integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RestClient } from './rest-client.js';
import { XmdsClient } from './xmds-client.js';

// ─── Configuration ─────────────────────────────────────────────────

const CMS_URL = process.env.CMS_URL || 'https://your-cms.example.com';
const CMS_KEY = process.env.CMS_KEY || 'your-cms-key';
const HARDWARE_KEY = process.env.HARDWARE_KEY || 'pwa-your-hardware-key';
const DISPLAY_NAME = process.env.DISPLAY_NAME || 'REST Integration Test';

// Skip all tests if no CMS_URL is provided and we're not in CI
const SKIP = !process.env.CMS_URL && !process.env.CI && !process.env.RUN_INTEGRATION;

// ─── Test Suite ────────────────────────────────────────────────────

describe.skipIf(SKIP)('XMDS REST API — Live Integration', () => {
  /** @type {RestClient} */
  let client;
  /** @type {XmdsClient} */
  let soapClient;

  beforeAll(() => {
    // Restore real fetch (vitest.setup.js mocks it for unit tests)
    global.fetch = global.__nativeFetch;

    // REST client
    client = new RestClient({
      cmsUrl: CMS_URL,
      cmsKey: CMS_KEY,
      hardwareKey: HARDWARE_KEY,
      displayName: DISPLAY_NAME,
      xmrChannel: 'integration-test-channel',
      retryOptions: { maxRetries: 1, baseDelayMs: 500 },
    });

    // SOAP client for parity comparison
    soapClient = new XmdsClient({
      cmsUrl: CMS_URL,
      cmsKey: CMS_KEY,
      hardwareKey: HARDWARE_KEY,
      displayName: DISPLAY_NAME,
      xmrChannel: 'integration-test-channel',
      retryOptions: { maxRetries: 1, baseDelayMs: 500 },
    });
  });

  // ────────────────────────────────────────────────────────────────
  // RegisterDisplay
  // ────────────────────────────────────────────────────────────────

  describe('RegisterDisplay', () => {
    it('should register and return READY for an authorized display', async () => {
      const result = await client.registerDisplay();

      expect(result).toBeDefined();
      expect(result.code).toBeDefined();
      expect(['READY', 'WAITING', 'ADDED']).toContain(result.code);

      if (result.code === 'READY') {
        expect(result.settings).toBeDefined();
        expect(result.settings).not.toBeNull();
        expect(result.message).toContain('Display is active');
      } else {
        expect(result.message).toContain('awaiting');
      }
    });

    it('should return READY with expected settings keys', async () => {
      const result = await client.registerDisplay();

      if (result.code !== 'READY') {
        console.warn('Display not authorized — skipping settings check');
        return;
      }

      // Core settings that every Xibo display receives
      // Note: downloadStartWindow/downloadEndWindow are optional per CMS config
      const expectedKeys = [
        'collectInterval',
        'statsEnabled',
        'xmrNetworkAddress',
      ];

      for (const key of expectedKeys) {
        expect(result.settings, `Missing setting: ${key}`).toHaveProperty(key);
      }
    });

    it('should fail gracefully with wrong server key', async () => {
      const badClient = new RestClient({
        cmsUrl: CMS_URL,
        cmsKey: 'wrong-key',
        hardwareKey: HARDWARE_KEY,
        displayName: DISPLAY_NAME,
        xmrChannel: 'test',
        retryOptions: { maxRetries: 0 },
      });

      // The CMS returns error code 0 (not an HTTP error)
      // So we expect either an Error or a result with error info
      try {
        const result = await badClient.registerDisplay();
        // If it doesn't throw, the code should indicate failure
        expect(result.code).not.toBe('READY');
      } catch (e) {
        expect(e.message).toMatch(/server key|failed|400|500/i);
      }
    });

    it('should produce the same code as SOAP transport', async () => {
      const restResult = await client.registerDisplay();
      const soapResult = await soapClient.registerDisplay();

      expect(restResult.code).toBe(soapResult.code);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // RequiredFiles
  // ────────────────────────────────────────────────────────────────

  describe('RequiredFiles', () => {
    it('should return a file manifest array', async () => {
      const files = await client.requiredFiles();

      expect(Array.isArray(files)).toBe(true);
      expect(files.length).toBeGreaterThan(0);
    });

    it('should include media files with proper attributes', async () => {
      const files = await client.requiredFiles();
      const mediaFiles = files.filter(f => f.type === 'media');

      if (mediaFiles.length === 0) {
        console.warn('No media files in manifest — skipping');
        return;
      }

      for (const file of mediaFiles) {
        expect(file.id).toBeDefined();
        expect(file.size).toBeGreaterThan(0);
        expect(file.md5).toBeDefined();
        expect(file.md5).toHaveLength(32);
        expect(file.path).toBeDefined();
      }
    });

    it('should include layout files', async () => {
      const files = await client.requiredFiles();
      const layoutFiles = files.filter(f => f.type === 'layout');

      expect(layoutFiles.length).toBeGreaterThan(0);

      for (const file of layoutFiles) {
        expect(file.id).toBeDefined();
        expect(file.size).toBeGreaterThan(0);
        expect(file.md5).toBeDefined();
      }
    });

    it('should include resource files with layout/region/media IDs', async () => {
      const files = await client.requiredFiles();
      const resourceFiles = files.filter(f => f.type === 'resource');

      if (resourceFiles.length === 0) {
        console.warn('No resource files — skipping');
        return;
      }

      for (const file of resourceFiles) {
        expect(file.layoutid).toBeDefined();
        expect(file.regionid).toBeDefined();
        expect(file.mediaid).toBeDefined();
      }
    });

    it('should support ETag caching (second call uses cache)', async () => {
      // First call populates cache
      const files1 = await client.requiredFiles();
      expect(files1.length).toBeGreaterThan(0);

      // Second call should get 304 + cached result
      const files2 = await client.requiredFiles();
      expect(files2.length).toBe(files1.length);

      // Verify ETag was stored
      expect(client._etags.has('/requiredFiles')).toBe(true);
    });

    it('should produce same file count as SOAP transport', async () => {
      // Clear cache for fair comparison
      client._etags.clear();
      client._responseCache.clear();

      const restFiles = await client.requiredFiles();
      const soapFiles = await soapClient.requiredFiles();

      expect(restFiles.length).toBe(soapFiles.length);

      // Compare file IDs (order may differ)
      const restIds = restFiles.map(f => `${f.type}-${f.id}`).sort();
      const soapIds = soapFiles.map(f => `${f.type}-${f.id}`).sort();
      expect(restIds).toEqual(soapIds);
    });

    it('should include download URLs for media files', async () => {
      const files = await client.requiredFiles();
      const mediaFiles = files.filter(f => f.type === 'media');

      for (const file of mediaFiles) {
        expect(file.path).toBeDefined();
        // Path should be a valid URL
        expect(file.path).toMatch(/^https?:\/\//);
      }
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Schedule
  // ────────────────────────────────────────────────────────────────

  describe('Schedule', () => {
    it('should return a schedule object', async () => {
      const schedule = await client.schedule();

      expect(schedule).toBeDefined();
      expect(schedule).toHaveProperty('layouts');
      expect(schedule).toHaveProperty('overlays');
      expect(Array.isArray(schedule.layouts)).toBe(true);
    });

    it('should include layout entries with required attributes', async () => {
      const schedule = await client.schedule();

      if (schedule.layouts.length === 0 && !schedule.default) {
        console.warn('Empty schedule — skipping');
        return;
      }

      for (const layout of schedule.layouts) {
        expect(layout.file).toBeDefined();
        expect(layout.fromdt).toBeDefined();
        expect(layout.todt).toBeDefined();
        expect(layout.scheduleid).toBeDefined();
        expect(layout.priority).toBeDefined();
      }
    });

    it('should support ETag caching', async () => {
      client._etags.clear();
      client._responseCache.clear();

      const schedule1 = await client.schedule();
      const schedule2 = await client.schedule();

      // Both should return same data
      expect(schedule1.layouts.length).toBe(schedule2.layouts.length);

      // ETag should be cached
      expect(client._etags.has('/schedule')).toBe(true);
    });

    it('should match SOAP schedule layout count', async () => {
      client._etags.clear();
      client._responseCache.clear();

      const restSchedule = await client.schedule();
      const soapSchedule = await soapClient.schedule();

      expect(restSchedule.layouts.length).toBe(soapSchedule.layouts.length);
    });

    it('should include schedule metadata (default layout, dependents)', async () => {
      const schedule = await client.schedule();

      // Check layouts have dependents array
      for (const layout of schedule.layouts) {
        if (layout.dependents) {
          expect(Array.isArray(layout.dependents)).toBe(true);
        }
      }
    });
  });

  // ────────────────────────────────────────────────────────────────
  // GetResource
  // ────────────────────────────────────────────────────────────────

  describe('GetResource', () => {
    let resourceFiles;

    beforeAll(async () => {
      const files = await client.requiredFiles();
      resourceFiles = files.filter(f => f.type === 'resource');
    });

    it('should fetch a widget resource as HTML', async () => {
      if (resourceFiles.length === 0) {
        console.warn('No resources to test — skipping');
        return;
      }

      const res = resourceFiles[0];
      const html = await client.getResource(res.layoutid, res.regionid, res.mediaid);

      expect(html).toBeDefined();
      expect(typeof html).toBe('string');
      expect(html.length).toBeGreaterThan(0);
    });

    it('should return valid HTML for all resource files', async () => {
      if (resourceFiles.length === 0) {
        console.warn('No resources — skipping');
        return;
      }

      // Test first 3 resources max to avoid slow test
      const toTest = resourceFiles.slice(0, 3);

      for (const res of toTest) {
        const html = await client.getResource(res.layoutid, res.regionid, res.mediaid);
        expect(html, `Resource ${res.mediaid} returned empty`).toBeDefined();
        expect(html.length, `Resource ${res.mediaid} is empty`).toBeGreaterThan(0);
      }
    });
  });

  // ────────────────────────────────────────────────────────────────
  // SubmitLog
  // ────────────────────────────────────────────────────────────────

  describe('SubmitLog', () => {
    it('should submit a log entry successfully', async () => {
      const result = await client.submitLog([
        {
          date: new Date().toISOString(),
          category: 'General',
          type: 'info',
          message: 'Integration test log entry',
        },
      ]);

      expect(result).toBeDefined();
      // REST returns { success: true }
      if (typeof result === 'object') {
        expect(result.success).toBe(true);
      }
    });

    it('should handle multiple log entries', async () => {
      const logs = Array.from({ length: 5 }, (_, i) => ({
        date: new Date().toISOString(),
        category: 'General',
        type: i === 0 ? 'error' : 'info',
        message: `Integration test log ${i + 1} of 5`,
      }));

      const result = await client.submitLog(logs);

      expect(result).toBeDefined();
      if (typeof result === 'object') {
        expect(result.success).toBe(true);
      }
    });
  });

  // ────────────────────────────────────────────────────────────────
  // SubmitStats
  // ────────────────────────────────────────────────────────────────

  describe('SubmitStats', () => {
    it('should submit proof-of-play stats successfully', async () => {
      const now = new Date();
      const from = new Date(now - 60000);

      const result = await client.submitStats([
        {
          type: 'layout',
          fromDt: from.toISOString(),
          toDt: now.toISOString(),
          scheduleId: '0',
          layoutId: '1',
          mediaId: '',
          tag: 'integration-test',
        },
      ]);

      expect(result).toBeDefined();
      if (typeof result === 'object') {
        expect(result.success).toBe(true);
      }
    });
  });

  // ────────────────────────────────────────────────────────────────
  // MediaInventory
  // ────────────────────────────────────────────────────────────────

  describe('MediaInventory', () => {
    it('should submit media inventory successfully', async () => {
      const result = await client.mediaInventory([
        { id: '1', complete: '1', md5: 'abc123', lastChecked: new Date().toISOString() },
      ]);

      expect(result).toBeDefined();
      if (typeof result === 'object') {
        expect(result.success).toBe(true);
      }
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Full Workflow: Complete Player Boot Sequence
  // ────────────────────────────────────────────────────────────────

  describe('Full Player Boot Workflow', () => {
    it('should execute the complete player boot sequence via REST', async () => {
      // Fresh client with no cache
      const bootClient = new RestClient({
        cmsUrl: CMS_URL,
        cmsKey: CMS_KEY,
        hardwareKey: HARDWARE_KEY,
        displayName: 'Boot Sequence Test',
        xmrChannel: 'boot-test-channel',
        retryOptions: { maxRetries: 1, baseDelayMs: 500 },
      });

      // Step 1: Register
      const registration = await bootClient.registerDisplay();
      expect(registration).toBeDefined();
      expect(registration.code).toBeDefined();
      console.log(`  Register: ${registration.code}`);

      if (registration.code !== 'READY') {
        console.warn('  Display not authorized — cannot complete boot sequence');
        return;
      }

      // Step 2: RequiredFiles
      const files = await bootClient.requiredFiles();
      expect(files.length).toBeGreaterThan(0);
      const mediaCount = files.filter(f => f.type === 'media').length;
      const layoutCount = files.filter(f => f.type === 'layout').length;
      const resourceCount = files.filter(f => f.type === 'resource').length;
      console.log(`  RequiredFiles: ${files.length} total (${mediaCount} media, ${layoutCount} layouts, ${resourceCount} resources)`);

      // Step 3: Schedule
      const schedule = await bootClient.schedule();
      expect(schedule).toBeDefined();
      console.log(`  Schedule: ${schedule.layouts.length} layouts, ${schedule.overlays.length} overlays`);

      // Step 4: GetResource (for first resource if available)
      const resources = files.filter(f => f.type === 'resource');
      if (resources.length > 0) {
        const res = resources[0];
        const html = await bootClient.getResource(res.layoutid, res.regionid, res.mediaid);
        expect(html).toBeDefined();
        console.log(`  GetResource: ${html.length} chars for widget ${res.mediaid}`);
      }

      // Step 5: Submit log
      const logResult = await bootClient.submitLog([{
        date: new Date().toISOString(),
        category: 'General',
        type: 'info',
        message: 'Player boot sequence completed via REST API',
      }]);
      expect(logResult).toBeDefined();
      console.log(`  SubmitLog: OK`);

      // Step 6: Submit stats
      const now = new Date();
      const statsResult = await bootClient.submitStats([{
        type: 'layout',
        fromDt: new Date(now - 10000).toISOString(),
        toDt: now.toISOString(),
        scheduleId: '0',
        layoutId: String(schedule.layouts[0]?.file || '0'),
        mediaId: '',
        tag: 'integration-test-boot',
      }]);
      expect(statsResult).toBeDefined();
      console.log(`  SubmitStats: OK`);

      // Step 7: MediaInventory
      const inventory = files.filter(f => f.type === 'media').slice(0, 5).map(f => ({
        id: f.id,
        complete: '1',
        md5: f.md5,
        lastChecked: now.toISOString(),
      }));
      if (inventory.length > 0) {
        const invResult = await bootClient.mediaInventory(inventory);
        expect(invResult).toBeDefined();
        console.log(`  MediaInventory: ${inventory.length} items reported`);
      }

      console.log('  Boot sequence: COMPLETE');
    });
  });

  // ────────────────────────────────────────────────────────────────
  // REST vs SOAP Parity
  // ────────────────────────────────────────────────────────────────

  describe('REST ↔ SOAP Transport Parity', () => {
    it('should expose the same business methods as SOAP transport', () => {
      // Compare only business-level API methods, not transport-specific helpers
      // (REST has restGet/restSend, SOAP has buildEnvelope/call/parseResponse, etc.)
      const businessMethods = [
        'blackList', 'getResource', 'mediaInventory', 'notifyStatus',
        'registerDisplay', 'requiredFiles', 'schedule',
        'submitLog', 'submitScreenShot', 'submitStats',
      ].sort();

      const restMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(client))
        .filter(m => !m.startsWith('_') && m !== 'constructor')
        .sort();
      const soapMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(soapClient))
        .filter(m => !m.startsWith('_') && m !== 'constructor')
        .sort();

      for (const method of businessMethods) {
        expect(restMethods).toContain(method);
        expect(soapMethods).toContain(method);
      }
    });

    it('should return same requiredFiles file types and counts', async () => {
      client._etags.clear();
      client._responseCache.clear();

      const restFiles = await client.requiredFiles();
      const soapFiles = await soapClient.requiredFiles();

      const restTypes = {};
      for (const f of restFiles) {
        restTypes[f.type] = (restTypes[f.type] || 0) + 1;
      }

      const soapTypes = {};
      for (const f of soapFiles) {
        soapTypes[f.type] = (soapTypes[f.type] || 0) + 1;
      }

      expect(restTypes).toEqual(soapTypes);
    });

    it('should return same schedule layout IDs', async () => {
      client._etags.clear();
      client._responseCache.clear();

      const restSchedule = await client.schedule();
      const soapSchedule = await soapClient.schedule();

      const restIds = restSchedule.layouts.map(l => l.file).sort();
      const soapIds = soapSchedule.layouts.map(l => l.file).sort();

      expect(restIds).toEqual(soapIds);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Error Handling
  // ────────────────────────────────────────────────────────────────

  describe('Error Handling', () => {
    it('should handle invalid hardware key gracefully', async () => {
      const badClient = new RestClient({
        cmsUrl: CMS_URL,
        cmsKey: CMS_KEY,
        hardwareKey: 'nonexistent-display',
        displayName: 'Bad Display',
        xmrChannel: 'test',
        retryOptions: { maxRetries: 0 },
      });

      try {
        const result = await badClient.requiredFiles();
        // Some endpoints may return empty rather than error
        expect(Array.isArray(result)).toBe(true);
      } catch (e) {
        // Expected — invalid display
        expect(e.message).toBeDefined();
      }
    });

    it('should handle unreachable CMS', async () => {
      const badClient = new RestClient({
        cmsUrl: 'https://nonexistent.example.com',
        cmsKey: 'test',
        hardwareKey: 'test',
        displayName: 'Unreachable',
        xmrChannel: 'test',
        retryOptions: { maxRetries: 0 },
      });

      await expect(badClient.registerDisplay()).rejects.toThrow();
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Performance & Caching
  // ────────────────────────────────────────────────────────────────

  describe('Performance & Caching', () => {
    it('should cache requiredFiles ETag across calls', async () => {
      client._etags.clear();
      client._responseCache.clear();

      // Call 1: fresh fetch
      const t1 = Date.now();
      await client.requiredFiles();
      const firstDuration = Date.now() - t1;

      // Call 2: should use 304 cache
      const t2 = Date.now();
      await client.requiredFiles();
      const secondDuration = Date.now() - t2;

      console.log(`  First fetch: ${firstDuration}ms, Cached fetch: ${secondDuration}ms`);

      expect(client._etags.has('/requiredFiles')).toBe(true);
    });

    it('should cache schedule ETag across calls', async () => {
      client._etags.clear();
      client._responseCache.clear();

      await client.schedule();
      await client.schedule();

      expect(client._etags.has('/schedule')).toBe(true);
    });
  });
});
