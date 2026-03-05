/**
 * Config Tests
 *
 * Tests for configuration management with split localStorage persistence
 * (xibo_global + xibo_cms:{cmsId} + xibo_active_cms)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock @xiboplayer/crypto before importing Config
vi.mock('@xiboplayer/crypto', () => {
  let callCount = 0;
  return {
    generateRsaKeyPair: vi.fn(async () => {
      callCount++;
      return {
        publicKeyPem: `-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKEY${callCount}==\n-----END PUBLIC KEY-----`,
        privateKeyPem: `-----BEGIN PRIVATE KEY-----\nMIICdgIBADANBgkqhkiG9w0BAQEFPRIVKEY${callCount}==\n-----END PRIVATE KEY-----`,
      };
    }),
    isValidPemKey: vi.fn((pem) => {
      if (!pem || typeof pem !== 'string') return false;
      return /^-----BEGIN (PUBLIC KEY|PRIVATE KEY)-----\n/.test(pem);
    }),
  };
});

import { Config, computeCmsId, fnvHash, warnPlatformMismatch } from './config.js';

/**
 * Seed split localStorage with a full config (global + CMS-scoped).
 * Helper to set up pre-existing config in the new format.
 */
function seedConfig(storage, data) {
  const GLOBAL_KEYS = new Set(['hardwareKey', 'xmrPubKey', 'xmrPrivKey']);
  const global = {};
  const cms = {};
  for (const [k, v] of Object.entries(data)) {
    if (GLOBAL_KEYS.has(k)) global[k] = v;
    else cms[k] = v;
  }
  storage.setItem('xibo_global', JSON.stringify(global));
  const cmsId = computeCmsId(data.cmsUrl);
  if (cmsId) {
    storage.setItem(`xibo_cms:${cmsId}`, JSON.stringify(cms));
    storage.setItem('xibo_active_cms', cmsId);
  }
}

describe('Config', () => {
  let config;
  let mockLocalStorage;
  let mockRandomUUID;

  beforeEach(() => {
    // Mock localStorage (with key/length for iteration in listCmsProfiles)
    mockLocalStorage = {
      data: {},
      getItem(key) {
        return this.data[key] || null;
      },
      setItem(key, value) {
        this.data[key] = value;
      },
      removeItem(key) {
        delete this.data[key];
      },
      clear() {
        this.data = {};
      },
      key(index) {
        return Object.keys(this.data)[index] || null;
      },
      get length() {
        return Object.keys(this.data).length;
      }
    };

    vi.stubGlobal('localStorage', mockLocalStorage);

    // Mock crypto.randomUUID using vi.stubGlobal (jsdom makes crypto read-only)
    mockRandomUUID = vi.fn(() => '12345678-1234-4567-8901-234567890abc');
    vi.stubGlobal('crypto', {
      randomUUID: mockRandomUUID
    });

    // Ensure no env vars interfere with localStorage path
    delete process.env.CMS_ADDRESS;
    delete process.env.CMS_URL;
    delete process.env.CMS_KEY;
    delete process.env.DISPLAY_NAME;
    delete process.env.HARDWARE_KEY;
    delete process.env.XMR_CHANNEL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('Initialization', () => {
    it('should create new config when localStorage is empty', () => {
      config = new Config();

      expect(config.data).toBeDefined();
      expect(config.data.cmsUrl).toBe('');
      expect(config.data.cmsKey).toBe('');
      expect(config.data.displayName).toBe('');
      expect(config.data.hardwareKey).toMatch(/^pwa-/);
      expect(config.data.xmrChannel).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('should generate stable hardware key on first load', () => {
      config = new Config();

      const hwKey = config.data.hardwareKey;
      expect(hwKey).toMatch(/^pwa-[0-9a-f]{28}$/);
      expect(hwKey).toBe('pwa-1234567812344567890123456789');
    });

    it('should save config to split localStorage on creation', () => {
      config = new Config();

      const global = JSON.parse(mockLocalStorage.getItem('xibo_global'));
      expect(global.hardwareKey).toBe(config.data.hardwareKey);
    });

    it('should load existing config from split localStorage', () => {
      const existingConfig = {
        cmsUrl: 'https://test.cms.com',
        cmsKey: 'test-key',
        displayName: 'Test Display',
        hardwareKey: 'pwa-existinghardwarekey1234567',
        xmrChannel: '12345678-1234-4567-8901-234567890abc'
      };

      seedConfig(mockLocalStorage, existingConfig);

      config = new Config();

      expect(config.data.cmsUrl).toBe('https://test.cms.com');
      expect(config.data.cmsKey).toBe('test-key');
      expect(config.data.displayName).toBe('Test Display');
      expect(config.data.hardwareKey).toBe('pwa-existinghardwarekey1234567');
      expect(config.data.xmrChannel).toBe('12345678-1234-4567-8901-234567890abc');
    });

    it('should regenerate hardware key if invalid in stored config', () => {
      seedConfig(mockLocalStorage, {
        cmsUrl: 'https://test.cms.com',
        cmsKey: 'test-key',
        displayName: 'Test Display',
        hardwareKey: 'short', // Invalid: too short
        xmrChannel: '12345678-1234-4567-8901-234567890abc'
      });

      config = new Config();

      expect(config.data.hardwareKey).not.toBe('short');
      expect(config.data.hardwareKey).toMatch(/^pwa-[0-9a-f]{28}$/);
    });

    it('should handle corrupted JSON in localStorage', () => {
      mockLocalStorage.setItem('xibo_global', 'invalid-json{');

      config = new Config();

      // Should create new config
      expect(config.data.hardwareKey).toMatch(/^pwa-/);
      expect(config.isConfigured()).toBe(false);
    });
  });

  describe('Hardware Key Generation', () => {
    beforeEach(() => {
      config = new Config();
    });

    it('should generate UUID-based hardware key when crypto.randomUUID available', () => {
      const hwKey = config.generateStableHardwareKey();

      expect(hwKey).toBe('pwa-1234567812344567890123456789');
      expect(mockRandomUUID).toHaveBeenCalled();
    });

    it('should fallback to random hex when crypto.randomUUID unavailable', () => {
      vi.stubGlobal('crypto', {});
      vi.spyOn(Math, 'random').mockReturnValue(0.5);

      const hwKey = config.generateStableHardwareKey();

      expect(hwKey).toMatch(/^pwa-[0-9a-f]{28}$/);
      expect(hwKey.length).toBe(32); // 'pwa-' + 28 chars
    });

    it('should ensure hardware key never becomes undefined', () => {
      config.data.hardwareKey = undefined;

      const hwKey = config.hardwareKey; // Getter auto-repairs

      expect(hwKey).toMatch(/^pwa-/);
      expect(config.data.hardwareKey).toBe(hwKey);
    });
  });

  describe('XMR Channel Generation', () => {
    beforeEach(() => {
      config = new Config();
    });

    it('should generate valid UUID v4', () => {
      const channel = config.generateXmrChannel();

      expect(channel).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('should generate different UUIDs each time', () => {
      const channel1 = config.generateXmrChannel();
      const channel2 = config.generateXmrChannel();

      expect(channel1).not.toBe(channel2);
    });
  });

  describe('Hash Function (FNV-1a)', () => {
    beforeEach(() => {
      config = new Config();
    });

    it('should generate 32-character hex hash', () => {
      const hash = config.hash('test string');

      expect(hash).toMatch(/^[0-9a-f]{32}$/);
    });

    it('should be deterministic for same input', () => {
      const hash1 = config.hash('test');
      const hash2 = config.hash('test');

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different inputs', () => {
      const hash1 = config.hash('test1');
      const hash2 = config.hash('test2');

      expect(hash1).not.toBe(hash2);
    });

    it('should handle empty string', () => {
      const hash = config.hash('');

      expect(hash).toMatch(/^[0-9a-f]{32}$/);
    });

    it('should produce good entropy for similar inputs', () => {
      const hash1 = config.hash('a');
      const hash2 = config.hash('b');

      // Hashes should be completely different (not just 1 character difference)
      let differences = 0;
      for (let i = 0; i < hash1.length; i++) {
        if (hash1[i] !== hash2[i]) differences++;
      }

      expect(differences).toBeGreaterThan(15); // At least half different
    });
  });

  describe('Canvas Fingerprint', () => {
    let createElementSpy;

    beforeEach(() => {
      config = new Config();

      // Mock canvas via spying on document.createElement
      const mockCanvas = {
        getContext: vi.fn(() => ({
          textBaseline: '',
          font: '',
          fillStyle: '',
          fillRect: vi.fn(),
          fillText: vi.fn()
        })),
        toDataURL: vi.fn(() => 'data:image/png;base64,mockdata')
      };

      createElementSpy = vi.spyOn(document, 'createElement').mockReturnValue(mockCanvas);
    });

    afterEach(() => {
      createElementSpy.mockRestore();
    });

    it('should generate canvas fingerprint', () => {
      const fingerprint = config.getCanvasFingerprint();

      expect(fingerprint).toBe('data:image/png;base64,mockdata');
      expect(createElementSpy).toHaveBeenCalledWith('canvas');
    });

    it('should return "no-canvas" when canvas context unavailable', () => {
      const mockCanvas = {
        getContext: vi.fn(() => null)
      };

      createElementSpy.mockReturnValue(mockCanvas);

      const fingerprint = config.getCanvasFingerprint();

      expect(fingerprint).toBe('no-canvas');
    });

    it('should return "canvas-error" on exception', () => {
      createElementSpy.mockImplementation(() => {
        throw new Error('Canvas not supported');
      });

      const fingerprint = config.getCanvasFingerprint();

      expect(fingerprint).toBe('canvas-error');
    });
  });

  describe('Configuration Getters/Setters', () => {
    beforeEach(() => {
      config = new Config();
    });

    it('should get/set cmsUrl', () => {
      expect(config.cmsUrl).toBe('');

      config.cmsUrl = 'https://new.cms.com';

      expect(config.cmsUrl).toBe('https://new.cms.com');
      expect(config.data.cmsUrl).toBe('https://new.cms.com');
    });

    it('should save to split localStorage when cmsUrl set', () => {
      config.cmsUrl = 'https://test.com';

      const cmsId = computeCmsId('https://test.com');
      const cms = JSON.parse(mockLocalStorage.getItem(`xibo_cms:${cmsId}`));
      expect(cms.cmsUrl).toBe('https://test.com');
    });

    it('should get/set cmsKey', () => {
      config.cmsKey = 'new-key';

      expect(config.cmsKey).toBe('new-key');
      expect(config.data.cmsKey).toBe('new-key');
    });

    it('should get/set displayName', () => {
      config.displayName = 'New Display';

      expect(config.displayName).toBe('New Display');
      expect(config.data.displayName).toBe('New Display');
    });

    it('should get hardwareKey (read-only via data)', () => {
      const originalKey = config.hardwareKey;

      expect(config.hardwareKey).toBe(originalKey);
      expect(config.hardwareKey).toMatch(/^pwa-/);
    });

    it('should get xmrChannel (read-only)', () => {
      const channel = config.xmrChannel;

      expect(channel).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('isConfigured()', () => {
    beforeEach(() => {
      config = new Config();
    });

    it('should return false when config incomplete', () => {
      expect(config.isConfigured()).toBe(false);
    });

    it('should return false when only cmsUrl set', () => {
      config.cmsUrl = 'https://test.com';

      expect(config.isConfigured()).toBe(false);
    });

    it('should return false when only cmsKey set', () => {
      config.cmsKey = 'test-key';

      expect(config.isConfigured()).toBe(false);
    });

    it('should return false when only displayName set', () => {
      config.displayName = 'Test Display';

      expect(config.isConfigured()).toBe(false);
    });

    it('should return true when all required fields set', () => {
      config.cmsUrl = 'https://test.com';
      config.cmsKey = 'test-key';
      config.displayName = 'Test Display';

      expect(config.isConfigured()).toBe(true);
    });
  });

  describe('save()', () => {
    beforeEach(() => {
      config = new Config();
    });

    it('should save current config to split localStorage', () => {
      config.data.cmsUrl = 'https://manual.com';
      config.data.cmsKey = 'manual-key';

      config.save();

      const cmsId = computeCmsId('https://manual.com');
      const cms = JSON.parse(mockLocalStorage.getItem(`xibo_cms:${cmsId}`));
      expect(cms.cmsUrl).toBe('https://manual.com');
      expect(cms.cmsKey).toBe('manual-key');
    });

    it('should auto-save when setters used', () => {
      config.cmsUrl = 'https://auto.com';

      const cmsId = computeCmsId('https://auto.com');
      const cms = JSON.parse(mockLocalStorage.getItem(`xibo_cms:${cmsId}`));
      expect(cms.cmsUrl).toBe('https://auto.com');
    });
  });

  describe('Backwards Compatibility', () => {
    beforeEach(() => {
      config = new Config();
    });

    it('should support generateHardwareKey() alias', () => {
      const key1 = config.generateHardwareKey();
      const key2 = config.generateStableHardwareKey();

      // Both should generate valid keys
      expect(key1).toMatch(/^pwa-[0-9a-f]{28}$/);
      expect(key2).toMatch(/^pwa-[0-9a-f]{28}$/);
    });
  });

  describe('Edge Cases', () => {
    it('should handle missing hardwareKey in loaded config', () => {
      seedConfig(mockLocalStorage, {
        cmsUrl: 'https://test.com',
        cmsKey: 'test-key',
        displayName: 'Test'
        // hardwareKey missing
      });

      config = new Config();

      // Should auto-generate
      expect(config.hardwareKey).toMatch(/^pwa-/);
    });

    it('should handle null values in config', () => {
      seedConfig(mockLocalStorage, {
        cmsUrl: null,
        cmsKey: null,
        displayName: null,
        hardwareKey: 'pwa-1234567812344567890123456789',
        xmrChannel: '12345678-1234-4567-8901-234567890abc'
      });

      config = new Config();

      expect(config.isConfigured()).toBe(false);
      // null values are normalized to empty strings by the validation gate
      expect(config.cmsUrl).toBe('');
    });

    it('should handle very long strings', () => {
      config = new Config();

      const longString = 'a'.repeat(10000);
      const hash = config.hash(longString);

      expect(hash).toMatch(/^[0-9a-f]{32}$/);
    });

    it('should handle unicode in hash', () => {
      config = new Config();

      const hash = config.hash('测试中文🎉');

      expect(hash).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  describe('Persistence', () => {
    it('should persist hardware key across multiple instances', () => {
      const config1 = new Config();
      const key1 = config1.hardwareKey;

      const config2 = new Config();
      const key2 = config2.hardwareKey;

      expect(key1).toBe(key2);
    });

    it('should persist configuration changes', () => {
      const config1 = new Config();
      config1.cmsUrl = 'https://persist.com';
      config1.cmsKey = 'persist-key';
      config1.displayName = 'Persist Display';

      const config2 = new Config();

      expect(config2.cmsUrl).toBe('https://persist.com');
      expect(config2.cmsKey).toBe('persist-key');
      expect(config2.displayName).toBe('Persist Display');
    });
  });

  describe('ensureXmrKeyPair()', () => {
    beforeEach(() => {
      config = new Config();
    });

    it('should generate and store RSA key pair', async () => {
      expect(config.data.xmrPubKey).toBeUndefined();
      expect(config.data.xmrPrivKey).toBeUndefined();

      await config.ensureXmrKeyPair();

      expect(config.data.xmrPubKey).toMatch(/^-----BEGIN PUBLIC KEY-----/);
      expect(config.data.xmrPrivKey).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    });

    it('should persist keys to xibo_global', async () => {
      await config.ensureXmrKeyPair();

      const global = JSON.parse(mockLocalStorage.getItem('xibo_global'));
      expect(global.xmrPubKey).toMatch(/^-----BEGIN PUBLIC KEY-----/);
      expect(global.xmrPrivKey).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    });

    it('should be idempotent — second call preserves existing keys', async () => {
      await config.ensureXmrKeyPair();
      const firstPubKey = config.data.xmrPubKey;
      const firstPrivKey = config.data.xmrPrivKey;

      await config.ensureXmrKeyPair();

      expect(config.data.xmrPubKey).toBe(firstPubKey);
      expect(config.data.xmrPrivKey).toBe(firstPrivKey);
    });

    it('should regenerate keys if xmrPubKey is invalid', async () => {
      config.data.xmrPubKey = 'invalid-key';
      config.data.xmrPrivKey = 'invalid-key';

      await config.ensureXmrKeyPair();

      expect(config.data.xmrPubKey).toMatch(/^-----BEGIN PUBLIC KEY-----/);
      expect(config.data.xmrPrivKey).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    });

    it('should regenerate keys if xmrPubKey is empty string', async () => {
      config.data.xmrPubKey = '';

      await config.ensureXmrKeyPair();

      expect(config.data.xmrPubKey).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    });

    it('should survive config reload from localStorage', async () => {
      await config.ensureXmrKeyPair();
      const savedPubKey = config.data.xmrPubKey;

      // Create new config (loads from localStorage)
      const config2 = new Config();

      expect(config2.data.xmrPubKey).toBe(savedPubKey);
    });
  });

  describe('XMR Key Getters', () => {
    beforeEach(() => {
      config = new Config();
    });

    it('should return empty string for xmrPubKey when not set', () => {
      expect(config.xmrPubKey).toBe('');
    });

    it('should return empty string for xmrPrivKey when not set', () => {
      expect(config.xmrPrivKey).toBe('');
    });

    it('should return xmrPubKey after ensureXmrKeyPair', async () => {
      await config.ensureXmrKeyPair();

      expect(config.xmrPubKey).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    });

    it('should return xmrPrivKey after ensureXmrKeyPair', async () => {
      await config.ensureXmrKeyPair();

      expect(config.xmrPrivKey).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    });
  });

  describe('warnPlatformMismatch()', () => {
    let warnSpy;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('should warn when Chromium-only key is used in Electron', () => {
      warnPlatformMismatch({ browser: 'chrome', cmsUrl: 'https://test.com' }, 'electron');

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('browser');
      expect(warnSpy.mock.calls[0][0]).toContain('chromium');
    });

    it('should warn when Electron-only key is used in Chromium', () => {
      warnPlatformMismatch({ autoLaunch: true }, 'chromium');

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('autoLaunch');
      expect(warnSpy.mock.calls[0][0]).toContain('electron');
    });

    it('should not warn for shared keys', () => {
      warnPlatformMismatch({ kioskMode: true, cmsUrl: 'https://test.com' }, 'electron');

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should not warn when config or platform is missing', () => {
      warnPlatformMismatch(null, 'electron');
      warnPlatformMismatch({ browser: 'chrome' }, '');

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should warn for multiple mismatched keys', () => {
      warnPlatformMismatch({ browser: 'chrome', extraBrowserFlags: '--flag' }, 'electron');

      expect(warnSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('Per-CMS Namespacing', () => {
    describe('fnvHash()', () => {
      it('should produce 12-char hex string', () => {
        expect(fnvHash('test')).toMatch(/^[0-9a-f]{12}$/);
      });

      it('should be deterministic', () => {
        expect(fnvHash('hello')).toBe(fnvHash('hello'));
      });

      it('should differ for different inputs', () => {
        expect(fnvHash('hello')).not.toBe(fnvHash('world'));
      });
    });

    describe('computeCmsId()', () => {
      it('should produce hostname-hash format', () => {
        const id = computeCmsId('https://displays.superpantalles.com');
        expect(id).toMatch(/^displays\.superpantalles\.com-[0-9a-f]{12}$/);
      });

      it('should handle localhost with port', () => {
        const id = computeCmsId('http://localhost:8080');
        expect(id).toMatch(/^localhost-[0-9a-f]{12}$/);
      });

      it('should return null for empty URL', () => {
        expect(computeCmsId('')).toBeNull();
        expect(computeCmsId(null)).toBeNull();
        expect(computeCmsId(undefined)).toBeNull();
      });

      it('should be deterministic for same URL', () => {
        const id1 = computeCmsId('https://cms.example.com');
        const id2 = computeCmsId('https://cms.example.com');
        expect(id1).toBe(id2);
      });

      it('should differ for different URLs', () => {
        const id1 = computeCmsId('https://cms1.example.com');
        const id2 = computeCmsId('https://cms2.example.com');
        expect(id1).not.toBe(id2);
      });

      it('should handle invalid URL gracefully', () => {
        const id = computeCmsId('not-a-url');
        expect(id).toMatch(/^unknown-[0-9a-f]{12}$/);
      });
    });

    describe('activeCmsId', () => {
      it('should return null when no CMS configured', () => {
        config = new Config();
        expect(config.activeCmsId).toBeNull();
      });

      it('should return CMS ID when configured', () => {
        seedConfig(mockLocalStorage, {
          cmsUrl: 'https://test.cms.com',
          cmsKey: 'key',
          displayName: 'Test',
          hardwareKey: 'pwa-existinghardwarekey1234567',
          xmrChannel: '12345678-1234-4567-8901-234567890abc',
        });

        config = new Config();
        expect(config.activeCmsId).toBe(computeCmsId('https://test.cms.com'));
      });
    });

    describe('switchCms()', () => {
      it('should switch to a new CMS and preserve hardwareKey', () => {
        seedConfig(mockLocalStorage, {
          cmsUrl: 'https://cms1.com',
          cmsKey: 'key1',
          displayName: 'Display on CMS1',
          hardwareKey: 'pwa-existinghardwarekey1234567',
          xmrChannel: '12345678-1234-4567-8901-234567890abc',
        });

        config = new Config();
        const hwKey = config.hardwareKey;

        const result = config.switchCms('https://cms2.com');

        expect(result.isNew).toBe(true);
        expect(result.cmsId).toBe(computeCmsId('https://cms2.com'));
        expect(config.hardwareKey).toBe(hwKey); // Same device identity
        expect(config.cmsUrl).toBe('https://cms2.com');
        expect(config.cmsKey).toBe(''); // New CMS, no key yet
      });

      it('should switch back to a previously known CMS', () => {
        seedConfig(mockLocalStorage, {
          cmsUrl: 'https://cms1.com',
          cmsKey: 'key1',
          displayName: 'Display on CMS1',
          hardwareKey: 'pwa-existinghardwarekey1234567',
          xmrChannel: '12345678-1234-4567-8901-234567890abc',
        });

        config = new Config();

        // Switch to CMS2
        config.switchCms('https://cms2.com');
        config.cmsKey = 'key2';
        config.displayName = 'Display on CMS2';

        // Switch back to CMS1
        const result = config.switchCms('https://cms1.com');

        expect(result.isNew).toBe(false);
        expect(config.cmsKey).toBe('key1');
        expect(config.displayName).toBe('Display on CMS1');
      });
    });

    describe('listCmsProfiles()', () => {
      it('should list all CMS profiles', () => {
        seedConfig(mockLocalStorage, {
          cmsUrl: 'https://cms1.com',
          cmsKey: 'key1',
          displayName: 'Display 1',
          hardwareKey: 'pwa-existinghardwarekey1234567',
          xmrChannel: '12345678-1234-4567-8901-234567890abc',
        });

        config = new Config();
        config.switchCms('https://cms2.com');
        config.displayName = 'Display 2';
        config.save();

        const profiles = config.listCmsProfiles();

        expect(profiles.length).toBe(2);
        expect(profiles.find(p => p.cmsUrl === 'https://cms1.com')).toBeTruthy();
        expect(profiles.find(p => p.cmsUrl === 'https://cms2.com')).toBeTruthy();
        // Only one should be active
        expect(profiles.filter(p => p.isActive).length).toBe(1);
      });
    });

    describe('Split storage save/load', () => {
      it('should write split keys on save', () => {
        config = new Config();
        config.data.cmsUrl = 'https://test.com';
        config.data.cmsKey = 'k';
        config.save();

        // Global key should exist
        expect(mockLocalStorage.getItem('xibo_global')).toBeTruthy();
        // CMS key should exist
        const cmsId = computeCmsId('https://test.com');
        expect(mockLocalStorage.getItem(`xibo_cms:${cmsId}`)).toBeTruthy();

        // Global should have hardwareKey, not cmsUrl
        const global = JSON.parse(mockLocalStorage.getItem('xibo_global'));
        expect(global.hardwareKey).toBeTruthy();
        expect(global.cmsUrl).toBeUndefined();

        // CMS should have cmsUrl, not hardwareKey
        const cms = JSON.parse(mockLocalStorage.getItem(`xibo_cms:${cmsId}`));
        expect(cms.cmsUrl).toBe('https://test.com');
        expect(cms.hardwareKey).toBeUndefined();
      });

      it('should reload from split storage correctly', () => {
        // Write config
        config = new Config();
        config.data.cmsUrl = 'https://reload.com';
        config.data.cmsKey = 'reload-key';
        config.data.displayName = 'Reload Test';
        config.save();

        // Reload
        const config2 = new Config();
        expect(config2.cmsUrl).toBe('https://reload.com');
        expect(config2.cmsKey).toBe('reload-key');
        expect(config2.displayName).toBe('Reload Test');
        expect(config2.hardwareKey).toBe(config.hardwareKey);
      });
    });
  });
});
