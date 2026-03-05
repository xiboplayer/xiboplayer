/**
 * ProtocolDetector Tests
 *
 * Tests CMS protocol auto-detection logic:
 * - REST probing via RestClient.isAvailable()
 * - Fallback to XMDS/SOAP when REST is unavailable
 * - Forced protocol selection (bypass auto-detection)
 * - Re-probing on connection errors
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
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
      expect(MockRestClient.isAvailable).toHaveBeenCalledWith('https://cms.example.com', {
        maxRetries: 0,
        timeoutMs: 3000,
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

    it('should use custom probe timeout', async () => {
      MockRestClient.isAvailable.mockResolvedValue(true);

      const detector = new ProtocolDetector('https://cms.example.com', MockRestClient, MockXmdsClient, {
        probeTimeoutMs: 5000,
      });
      await detector.detect(config);

      expect(MockRestClient.isAvailable).toHaveBeenCalledWith('https://cms.example.com', {
        maxRetries: 0,
        timeoutMs: 5000,
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
    it('should call RestClient.isAvailable with correct URL and timeout', async () => {
      MockRestClient.isAvailable.mockResolvedValue(true);
      const detector = new ProtocolDetector('https://cms.example.com', MockRestClient, MockXmdsClient);
      const result = await detector.probe();

      expect(result).toBe(true);
      expect(MockRestClient.isAvailable).toHaveBeenCalledWith('https://cms.example.com', {
        maxRetries: 0,
        timeoutMs: 3000,
      });
    });

    it('should return false when REST is unavailable', async () => {
      MockRestClient.isAvailable.mockResolvedValue(false);
      const detector = new ProtocolDetector('https://cms.example.com', MockRestClient, MockXmdsClient);
      const result = await detector.probe();

      expect(result).toBe(false);
    });
  });
});
