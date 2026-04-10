// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
// @vitest-environment node
/**
 * ProtocolDetector Tests
 *
 * Tests CMS protocol auto-detection logic:
 * - REST probing via RestClient.isAvailable() with first/reprobe timeout split
 * - Fallback to XMDS/SOAP when REST is unavailable
 * - Forced protocol selection (bypass auto-detection)
 * - Re-probing on connection errors
 * - Automatic background re-probe loop with exponential backoff
 *
 * Pinned to the node environment because this file only exercises JS
 * logic + mocks — no DOM is needed, and jsdom's CJS require of
 * @asamuzakjp/css-color has a top-level-await bug on current Node.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ProtocolDetector } from './protocol-detector.js';
import { CMS_CLIENT_METHODS } from './cms-client.js';

// Stub all CmsClient methods on a mock constructor's prototype
function addCmsClientStubs(MockClass) {
  for (const method of CMS_CLIENT_METHODS) {
    MockClass.prototype[method] = vi.fn();
  }
}

describe('ProtocolDetector', () => {
  let MockRestClient;
  let MockXmdsClient;
  let config;

  beforeEach(() => {
    config = {
      cmsUrl: 'https://cms.example.com',
      cmsKey: 'test-key',
      hardwareKey: 'test-hw',
    };

    MockRestClient = vi.fn(function (cfg) {
      this.config = cfg;
      this.type = 'rest';
    });
    MockRestClient.isAvailable = vi.fn();
    addCmsClientStubs(MockRestClient);

    MockXmdsClient = vi.fn(function (cfg) {
      this.config = cfg;
      this.type = 'xmds';
    });
    addCmsClientStubs(MockXmdsClient);
  });

  // ── detect() ─────────────────────────────────────────────────────

  describe('detect()', () => {
    it('should detect REST when health endpoint returns 200', async () => {
      MockRestClient.isAvailable.mockResolvedValue(true);

      const detector = new ProtocolDetector('https://cms.example.com', MockRestClient, MockXmdsClient);
      const { client, protocol } = await detector.detect(config);

      expect(protocol).toBe('rest');
      expect(client.type).toBe('rest');
      expect(detector.getProtocol()).toBe('rest');
      // detect() triggers a FIRST probe with the generous firstProbeTimeoutMs
      expect(MockRestClient.isAvailable).toHaveBeenCalledWith('https://cms.example.com', {
        maxRetries: 0,
        timeoutMs: 10000,
      });
    });

    it('should fall back to XMDS when REST is unavailable', async () => {
      MockRestClient.isAvailable.mockResolvedValue(false);

      const detector = new ProtocolDetector('https://cms.example.com', MockRestClient, MockXmdsClient);
      const { client, protocol } = await detector.detect(config);

      expect(protocol).toBe('xmds');
      expect(client.type).toBe('xmds');
      expect(detector.getProtocol()).toBe('xmds');
    });

    it('should fall back to XMDS when probe throws', async () => {
      MockRestClient.isAvailable.mockRejectedValue(new Error('Network error'));

      const detector = new ProtocolDetector('https://cms.example.com', MockRestClient, MockXmdsClient);
      // probe() will throw, but detect() should handle it
      // Actually, isAvailable catches internally and returns false
      // Let's test the direct throw case by mocking probe
      const { client, protocol } = await detector.detect(config);

      expect(protocol).toBe('xmds');
      expect(client.type).toBe('xmds');
    });

    it('should use forced REST protocol without probing', async () => {
      const detector = new ProtocolDetector('https://cms.example.com', MockRestClient, MockXmdsClient);
      const { client, protocol } = await detector.detect(config, 'rest');

      expect(protocol).toBe('rest');
      expect(client.type).toBe('rest');
      expect(MockRestClient.isAvailable).not.toHaveBeenCalled();
    });

    it('should use forced XMDS protocol without probing', async () => {
      const detector = new ProtocolDetector('https://cms.example.com', MockRestClient, MockXmdsClient);
      const { client, protocol } = await detector.detect(config, 'xmds');

      expect(protocol).toBe('xmds');
      expect(client.type).toBe('xmds');
      expect(MockRestClient.isAvailable).not.toHaveBeenCalled();
    });

    it('should pass config to client constructor', async () => {
      MockRestClient.isAvailable.mockResolvedValue(true);

      const detector = new ProtocolDetector('https://cms.example.com', MockRestClient, MockXmdsClient);
      const { client } = await detector.detect(config);

      expect(MockRestClient).toHaveBeenCalledWith(config);
      expect(client.config).toBe(config);
    });

    it('should use the generous first-probe timeout by default', async () => {
      MockRestClient.isAvailable.mockResolvedValue(true);

      const detector = new ProtocolDetector('https://cms.example.com', MockRestClient, MockXmdsClient);
      await detector.detect(config);

      // detect() triggers the FIRST probe, which uses firstProbeTimeoutMs (10s)
      // rather than the shorter reprobe timeout. A cold CMS needs headroom.
      expect(MockRestClient.isAvailable).toHaveBeenCalledWith('https://cms.example.com', {
        maxRetries: 0,
        timeoutMs: 10000,
      });
    });

    it('should honour back-compat probeTimeoutMs option', async () => {
      MockRestClient.isAvailable.mockResolvedValue(true);

      // Single probeTimeoutMs sets BOTH first-probe and reprobe timeouts
      const detector = new ProtocolDetector('https://cms.example.com', MockRestClient, MockXmdsClient, {
        probeTimeoutMs: 5000,
      });
      await detector.detect(config);

      expect(MockRestClient.isAvailable).toHaveBeenCalledWith('https://cms.example.com', {
        maxRetries: 0,
        timeoutMs: 5000,
      });
    });

    it('should honour split firstProbeTimeoutMs and reprobeTimeoutMs', async () => {
      MockRestClient.isAvailable.mockResolvedValue(false);

      const detector = new ProtocolDetector('https://cms.example.com', MockRestClient, MockXmdsClient, {
        firstProbeTimeoutMs: 15000,
        reprobeTimeoutMs: 2000,
      });
      await detector.detect(config); // first probe → 15000
      await detector.reprobe(config); // reprobe → 2000

      expect(MockRestClient.isAvailable).toHaveBeenNthCalledWith(1, 'https://cms.example.com', {
        maxRetries: 0,
        timeoutMs: 15000,
      });
      expect(MockRestClient.isAvailable).toHaveBeenNthCalledWith(2, 'https://cms.example.com', {
        maxRetries: 0,
        timeoutMs: 2000,
      });
    });

    it('should record lastProbeTime after detection', async () => {
      MockRestClient.isAvailable.mockResolvedValue(true);

      const detector = new ProtocolDetector('https://cms.example.com', MockRestClient, MockXmdsClient);
      expect(detector.lastProbeTime).toBe(0);

      await detector.detect(config);

      expect(detector.lastProbeTime).toBeGreaterThan(0);
      expect(detector.lastProbeTime).toBeLessThanOrEqual(Date.now());
    });
  });

  // ── reprobe() ────────────────────────────────────────────────────

  describe('reprobe()', () => {
    it('should detect protocol change from XMDS to REST', async () => {
      MockRestClient.isAvailable.mockResolvedValueOnce(false); // initial detect
      const detector = new ProtocolDetector('https://cms.example.com', MockRestClient, MockXmdsClient);
      await detector.detect(config);
      expect(detector.getProtocol()).toBe('xmds');

      MockRestClient.isAvailable.mockResolvedValueOnce(true); // reprobe
      const { client, protocol, changed } = await detector.reprobe(config);

      expect(changed).toBe(true);
      expect(protocol).toBe('rest');
      expect(client.type).toBe('rest');
      expect(detector.getProtocol()).toBe('rest');
    });

    it('should detect protocol change from REST to XMDS', async () => {
      MockRestClient.isAvailable.mockResolvedValueOnce(true); // initial detect
      const detector = new ProtocolDetector('https://cms.example.com', MockRestClient, MockXmdsClient);
      await detector.detect(config);
      expect(detector.getProtocol()).toBe('rest');

      MockRestClient.isAvailable.mockResolvedValueOnce(false); // reprobe
      const { client, protocol, changed } = await detector.reprobe(config);

      expect(changed).toBe(true);
      expect(protocol).toBe('xmds');
      expect(client.type).toBe('xmds');
      expect(detector.getProtocol()).toBe('xmds');
    });

    it('should return changed=false when protocol is unchanged', async () => {
      MockRestClient.isAvailable.mockResolvedValueOnce(true); // initial detect
      const detector = new ProtocolDetector('https://cms.example.com', MockRestClient, MockXmdsClient);
      await detector.detect(config);

      MockRestClient.isAvailable.mockResolvedValueOnce(true); // reprobe (same)
      const { client, protocol, changed } = await detector.reprobe(config);

      expect(changed).toBe(false);
      expect(protocol).toBe('rest');
      expect(client).toBeNull(); // No new client when unchanged
    });

    it('should update lastProbeTime on reprobe', async () => {
      MockRestClient.isAvailable.mockResolvedValue(true);
      const detector = new ProtocolDetector('https://cms.example.com', MockRestClient, MockXmdsClient);
      await detector.detect(config);
      const firstProbe = detector.lastProbeTime;

      // Small delay to ensure different timestamp
      await new Promise(r => setTimeout(r, 5));

      await detector.reprobe(config);
      expect(detector.lastProbeTime).toBeGreaterThanOrEqual(firstProbe);
    });
  });

  // ── getProtocol() ────────────────────────────────────────────────

  describe('getProtocol()', () => {
    it('should return null before detection', () => {
      const detector = new ProtocolDetector('https://cms.example.com', MockRestClient, MockXmdsClient);
      expect(detector.getProtocol()).toBeNull();
    });

    it('should return detected protocol after detect()', async () => {
      MockRestClient.isAvailable.mockResolvedValue(true);
      const detector = new ProtocolDetector('https://cms.example.com', MockRestClient, MockXmdsClient);
      await detector.detect(config);
      expect(detector.getProtocol()).toBe('rest');
    });
  });

  // ── probe() ──────────────────────────────────────────────────────

  describe('probe()', () => {
    it('should default to the reprobe timeout (plain probe() = not first)', async () => {
      MockRestClient.isAvailable.mockResolvedValue(true);
      const detector = new ProtocolDetector('https://cms.example.com', MockRestClient, MockXmdsClient);
      const result = await detector.probe();

      expect(result).toBe(true);
      // Plain probe() with no { first: true } uses the shorter reprobe timeout
      expect(MockRestClient.isAvailable).toHaveBeenCalledWith('https://cms.example.com', {
        maxRetries: 0,
        timeoutMs: 5000,
      });
    });

    it('should use firstProbeTimeoutMs when called with { first: true }', async () => {
      MockRestClient.isAvailable.mockResolvedValue(true);
      const detector = new ProtocolDetector('https://cms.example.com', MockRestClient, MockXmdsClient);
      await detector.probe({ first: true });

      expect(MockRestClient.isAvailable).toHaveBeenCalledWith('https://cms.example.com', {
        maxRetries: 0,
        timeoutMs: 10000,
      });
    });

    it('should return false when REST is unavailable', async () => {
      MockRestClient.isAvailable.mockResolvedValue(false);
      const detector = new ProtocolDetector('https://cms.example.com', MockRestClient, MockXmdsClient);
      const result = await detector.probe();

      expect(result).toBe(false);
    });
  });

  // ── startAutoReprobe() / stopAutoReprobe() ───────────────────────

  describe('startAutoReprobe()', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should be a no-op when protocol is not xmds', async () => {
      MockRestClient.isAvailable.mockResolvedValue(true);
      const detector = new ProtocolDetector('https://cms.example.com', MockRestClient, MockXmdsClient);
      await detector.detect(config);
      expect(detector.getProtocol()).toBe('rest');

      const onPromoted = vi.fn();
      detector.startAutoReprobe(config, onPromoted);

      // No timer should be scheduled
      expect(detector._reprobeTimer).toBeNull();
      vi.advanceTimersByTime(60000);
      expect(onPromoted).not.toHaveBeenCalled();
    });

    it('should promote back to REST and call onRestPromoted when probe succeeds', async () => {
      MockRestClient.isAvailable.mockResolvedValueOnce(false); // initial detect → xmds
      const detector = new ProtocolDetector('https://cms.example.com', MockRestClient, MockXmdsClient);
      await detector.detect(config);
      expect(detector.getProtocol()).toBe('xmds');

      MockRestClient.isAvailable.mockResolvedValueOnce(true); // reprobe → rest
      const onPromoted = vi.fn();
      detector.startAutoReprobe(config, onPromoted);

      // First auto-reprobe fires after reprobeMinDelayMs (5s default)
      await vi.advanceTimersByTimeAsync(5000);

      expect(onPromoted).toHaveBeenCalledTimes(1);
      expect(onPromoted).toHaveBeenCalledWith(expect.objectContaining({ type: 'rest' }));
      expect(detector.getProtocol()).toBe('rest');
      // Timer is cleared after a successful promotion
      expect(detector._reprobeTimer).toBeNull();
    });

    it('should follow exponential backoff while REST stays unavailable', async () => {
      MockRestClient.isAvailable.mockResolvedValue(false); // always fails
      const detector = new ProtocolDetector('https://cms.example.com', MockRestClient, MockXmdsClient, {
        reprobeMinDelayMs: 1000,
        reprobeMaxDelayMs: 8000,
      });
      await detector.detect(config);

      const onPromoted = vi.fn();
      detector.startAutoReprobe(config, onPromoted);

      // 1st attempt at 1s
      expect(MockRestClient.isAvailable).toHaveBeenCalledTimes(1); // from detect()
      await vi.advanceTimersByTimeAsync(1000);
      expect(MockRestClient.isAvailable).toHaveBeenCalledTimes(2);

      // 2nd attempt at 1 + 2 = 3s (doubled)
      await vi.advanceTimersByTimeAsync(2000);
      expect(MockRestClient.isAvailable).toHaveBeenCalledTimes(3);

      // 3rd attempt at 3 + 4 = 7s
      await vi.advanceTimersByTimeAsync(4000);
      expect(MockRestClient.isAvailable).toHaveBeenCalledTimes(4);

      // 4th attempt at 7 + 8 = 15s (capped at max)
      await vi.advanceTimersByTimeAsync(8000);
      expect(MockRestClient.isAvailable).toHaveBeenCalledTimes(5);

      // 5th at +8s (still capped)
      await vi.advanceTimersByTimeAsync(8000);
      expect(MockRestClient.isAvailable).toHaveBeenCalledTimes(6);

      expect(onPromoted).not.toHaveBeenCalled();
      detector.stopAutoReprobe();
    });

    it('should cancel the pending timer when stopAutoReprobe is called', async () => {
      MockRestClient.isAvailable.mockResolvedValue(false);
      const detector = new ProtocolDetector('https://cms.example.com', MockRestClient, MockXmdsClient);
      await detector.detect(config);

      const onPromoted = vi.fn();
      detector.startAutoReprobe(config, onPromoted);
      expect(detector._reprobeTimer).not.toBeNull();

      detector.stopAutoReprobe();
      expect(detector._reprobeTimer).toBeNull();

      // Advancing the clock should trigger no further calls
      const callsBefore = MockRestClient.isAvailable.mock.calls.length;
      await vi.advanceTimersByTimeAsync(300000); // 5 minutes
      expect(MockRestClient.isAvailable.mock.calls.length).toBe(callsBefore);
      expect(onPromoted).not.toHaveBeenCalled();
    });

    it('should restart cleanly when startAutoReprobe is called twice', async () => {
      MockRestClient.isAvailable.mockResolvedValue(false);
      const detector = new ProtocolDetector('https://cms.example.com', MockRestClient, MockXmdsClient, {
        reprobeMinDelayMs: 1000,
        reprobeMaxDelayMs: 4000,
      });
      await detector.detect(config);

      const onPromoted = vi.fn();
      detector.startAutoReprobe(config, onPromoted);
      // Advance once so delay doubles internally
      await vi.advanceTimersByTimeAsync(1000);

      // Restart — delay should reset to minimum
      detector.startAutoReprobe(config, onPromoted);
      expect(detector._reprobeDelay).toBe(1000);
    });
  });
});
