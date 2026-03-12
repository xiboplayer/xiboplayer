// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * DisplaySettings tests
 * Comprehensive test suite covering all settings parsing and validation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DisplaySettings } from './settings.js';

describe('DisplaySettings', () => {
  let settings;

  beforeEach(() => {
    settings = new DisplaySettings();
  });

  describe('constructor', () => {
    it('should initialize with default settings', () => {
      expect(settings.settings.collectInterval).toBe(300);
      expect(settings.settings.displayName).toBe('Unknown Display');
      expect(settings.settings.sizeX).toBe(1920);
      expect(settings.settings.sizeY).toBe(1080);
      expect(settings.settings.statsEnabled).toBe(false);
      expect(settings.settings.logLevel).toBe('error');
    });
  });

  describe('applySettings', () => {
    it('should handle null settings gracefully', () => {
      const result = settings.applySettings(null);
      expect(result.changed).toEqual([]);
      expect(result.settings.collectInterval).toBe(300);
    });

    it('should apply all settings from CMS response', () => {
      const cmsSettings = {
        collectInterval: 600,
        displayName: 'Test Display',
        sizeX: '3840',
        sizeY: '2160',
        statsEnabled: '1',
        logLevel: 'debug',
        xmrWebSocketAddress: 'ws://xmr.example.com:9505',
        preventSleep: '1',
        screenshotInterval: '180'
      };

      const result = settings.applySettings(cmsSettings);

      expect(result.settings.collectInterval).toBe(600);
      expect(result.settings.displayName).toBe('Test Display');
      expect(result.settings.sizeX).toBe(3840);
      expect(result.settings.sizeY).toBe(2160);
      expect(result.settings.statsEnabled).toBe(true);
      expect(result.settings.logLevel).toBe('debug');
      expect(result.settings.xmrWebSocketAddress).toBe('ws://xmr.example.com:9505');
      expect(result.settings.preventSleep).toBe(true);
      expect(result.settings.screenshotInterval).toBe(180);
    });

    it('should detect collection interval changes', () => {
      const listener = vi.fn();
      settings.on('interval-changed', listener);

      settings.applySettings({ collectInterval: 600 });

      expect(listener).toHaveBeenCalledWith(600);
    });

    it('should emit settings-applied event', () => {
      const listener = vi.fn();
      settings.on('settings-applied', listener);

      const cmsSettings = { collectInterval: 600 };
      settings.applySettings(cmsSettings);

      expect(listener).toHaveBeenCalled();
      expect(listener.mock.calls[0][1]).toContain('collectInterval');
    });

    it('should handle CamelCase setting names (uppercase first letter)', () => {
      const cmsSettings = {
        CollectInterval: 600,
        DisplayName: 'CamelCase Display',
        SizeX: '1920',
        SizeY: '1080',
        StatsEnabled: '1',
        LogLevel: 'info'
      };

      settings.applySettings(cmsSettings);

      expect(settings.settings.collectInterval).toBe(600);
      expect(settings.settings.displayName).toBe('CamelCase Display');
      expect(settings.settings.sizeX).toBe(1920);
      expect(settings.settings.sizeY).toBe(1080);
      expect(settings.settings.statsEnabled).toBe(true);
      expect(settings.settings.logLevel).toBe('info');
    });
  });

  describe('parseCollectInterval', () => {
    it('should parse valid interval', () => {
      expect(settings.parseCollectInterval(600)).toBe(600);
      expect(settings.parseCollectInterval('900')).toBe(900);
    });

    it('should enforce minimum interval (60 seconds)', () => {
      expect(settings.parseCollectInterval(30)).toBe(300);
      expect(settings.parseCollectInterval(0)).toBe(300);
      expect(settings.parseCollectInterval(-100)).toBe(300);
    });

    it('should enforce maximum interval (24 hours)', () => {
      expect(settings.parseCollectInterval(100000)).toBe(86400);
      expect(settings.parseCollectInterval(999999)).toBe(86400);
    });

    it('should handle invalid input', () => {
      expect(settings.parseCollectInterval('invalid')).toBe(300);
      expect(settings.parseCollectInterval(null)).toBe(300);
      expect(settings.parseCollectInterval(undefined)).toBe(300);
      expect(settings.parseCollectInterval(NaN)).toBe(300);
    });
  });

  describe('parseBoolean', () => {
    it('should parse boolean values', () => {
      expect(settings.parseBoolean(true)).toBe(true);
      expect(settings.parseBoolean(false)).toBe(false);
    });

    it('should parse string values', () => {
      expect(settings.parseBoolean('1')).toBe(true);
      expect(settings.parseBoolean('0')).toBe(false);
    });

    it('should parse numeric values', () => {
      expect(settings.parseBoolean(1)).toBe(true);
      expect(settings.parseBoolean(0)).toBe(false);
    });

    it('should use default value for invalid input', () => {
      expect(settings.parseBoolean(null)).toBe(false);
      expect(settings.parseBoolean(undefined)).toBe(false);
      expect(settings.parseBoolean('yes')).toBe(false);
      expect(settings.parseBoolean('no')).toBe(false);
      expect(settings.parseBoolean(null, true)).toBe(true);
    });
  });

  describe('getters', () => {
    beforeEach(() => {
      settings.applySettings({
        collectInterval: 900,
        displayName: 'My Display',
        sizeX: '2560',
        sizeY: '1440',
        statsEnabled: '1'
      });
    });

    it('should get collection interval', () => {
      expect(settings.getCollectInterval()).toBe(900);
    });

    it('should get display name', () => {
      expect(settings.getDisplayName()).toBe('My Display');
    });

    it('should get display size', () => {
      const size = settings.getDisplaySize();
      expect(size.width).toBe(2560);
      expect(size.height).toBe(1440);
    });

    it('should check if stats enabled', () => {
      expect(settings.isStatsEnabled()).toBe(true);
    });

    it('should get all settings', () => {
      const allSettings = settings.getAllSettings();
      expect(allSettings.collectInterval).toBe(900);
      expect(allSettings.displayName).toBe('My Display');
      expect(allSettings.statsEnabled).toBe(true);
    });

    it('should get specific setting', () => {
      expect(settings.getSetting('collectInterval')).toBe(900);
      expect(settings.getSetting('displayName')).toBe('My Display');
      expect(settings.getSetting('unknownSetting', 'default')).toBe('default');
    });
  });

  describe('download windows', () => {
    describe('isInDownloadWindow', () => {
      it('should return true if no download window configured', () => {
        expect(settings.isInDownloadWindow()).toBe(true);
      });

      it('should return true if only start window configured', () => {
        settings.applySettings({ downloadStartWindow: '14:00' });
        expect(settings.isInDownloadWindow()).toBe(true);
      });

      it('should return true if only end window configured', () => {
        settings.applySettings({ downloadEndWindow: '18:00' });
        expect(settings.isInDownloadWindow()).toBe(true);
      });

      it('should check normal same-day window', () => {
        settings.applySettings({
          downloadStartWindow: '09:00',
          downloadEndWindow: '17:00'
        });

        // Mock current time to 12:00 (within window)
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0));

        expect(settings.isInDownloadWindow()).toBe(true);

        // Mock current time to 08:00 (before window)
        vi.setSystemTime(new Date(2026, 0, 15, 8, 0, 0));
        expect(settings.isInDownloadWindow()).toBe(false);

        // Mock current time to 18:00 (after window)
        vi.setSystemTime(new Date(2026, 0, 15, 18, 0, 0));
        expect(settings.isInDownloadWindow()).toBe(false);

        vi.useRealTimers();
      });

      it('should check overnight window (crosses midnight)', () => {
        settings.applySettings({
          downloadStartWindow: '22:00',
          downloadEndWindow: '06:00'
        });

        // Mock current time to 23:00 (within overnight window)
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 0, 15, 23, 0, 0));

        expect(settings.isInDownloadWindow()).toBe(true);

        // Mock current time to 02:00 (within overnight window)
        vi.setSystemTime(new Date(2026, 0, 15, 2, 0, 0));
        expect(settings.isInDownloadWindow()).toBe(true);

        // Mock current time to 12:00 (outside overnight window)
        vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0));
        expect(settings.isInDownloadWindow()).toBe(false);

        vi.useRealTimers();
      });

      it('should handle invalid time window gracefully', () => {
        settings.applySettings({
          downloadStartWindow: 'invalid',
          downloadEndWindow: '17:00'
        });

        // Should return true (allow downloads) if parsing fails
        expect(settings.isInDownloadWindow()).toBe(true);
      });
    });

    describe('parseTimeWindow', () => {
      it('should parse valid time strings', () => {
        expect(settings.parseTimeWindow('00:00')).toBe(0);
        expect(settings.parseTimeWindow('12:30')).toBe(750);
        expect(settings.parseTimeWindow('23:59')).toBe(1439);
      });

      it('should reject invalid formats', () => {
        expect(() => settings.parseTimeWindow('12')).toThrow('Invalid time window format');
        expect(() => settings.parseTimeWindow('12:30:00')).toThrow('Invalid time window format');
        expect(() => settings.parseTimeWindow('invalid')).toThrow('Invalid time window format');
        expect(() => settings.parseTimeWindow(null)).toThrow('Invalid time window format');
        expect(() => settings.parseTimeWindow(undefined)).toThrow('Invalid time window format');
      });

      it('should reject invalid values', () => {
        expect(() => settings.parseTimeWindow('24:00')).toThrow('Invalid time window values');
        expect(() => settings.parseTimeWindow('12:60')).toThrow('Invalid time window values');
        expect(() => settings.parseTimeWindow('-1:30')).toThrow('Invalid time window values');
        expect(() => settings.parseTimeWindow('12:-1')).toThrow('Invalid time window values');
      });
    });

    describe('getNextDownloadWindow', () => {
      it('should return null if no download window configured', () => {
        expect(settings.getNextDownloadWindow()).toBeNull();
      });

      it('should calculate next window later today', () => {
        settings.applySettings({
          downloadStartWindow: '15:00',
          downloadEndWindow: '18:00'
        });

        // Mock current time to 10:00
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 0, 15, 10, 0, 0));

        const nextWindow = settings.getNextDownloadWindow();
        expect(nextWindow).toBeTruthy();
        expect(nextWindow.getHours()).toBe(15);
        expect(nextWindow.getMinutes()).toBe(0);

        vi.useRealTimers();
      });

      it('should calculate next window tomorrow', () => {
        settings.applySettings({
          downloadStartWindow: '09:00',
          downloadEndWindow: '17:00'
        });

        // Mock current time to 20:00 (after window)
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 0, 15, 20, 0, 0));

        const nextWindow = settings.getNextDownloadWindow();
        expect(nextWindow).toBeTruthy();
        expect(nextWindow.getDate()).toBe(16); // Tomorrow
        expect(nextWindow.getHours()).toBe(9);
        expect(nextWindow.getMinutes()).toBe(0);

        vi.useRealTimers();
      });

      it('should handle invalid time window gracefully', () => {
        settings.applySettings({
          downloadStartWindow: 'invalid',
          downloadEndWindow: '17:00'
        });

        expect(settings.getNextDownloadWindow()).toBeNull();
      });
    });
  });

  describe('screenshot', () => {
    beforeEach(() => {
      settings.applySettings({ screenshotInterval: 120 });
    });

    it('should return true if no last screenshot', () => {
      expect(settings.shouldTakeScreenshot(null)).toBe(true);
    });

    it('should return false if interval not elapsed', () => {
      vi.useFakeTimers();
      const now = new Date(2026, 0, 15, 12, 0, 0);
      vi.setSystemTime(now);

      const lastScreenshot = new Date(now.getTime() - 60000); // 60 seconds ago
      expect(settings.shouldTakeScreenshot(lastScreenshot)).toBe(false);

      vi.useRealTimers();
    });

    it('should return true if interval elapsed', () => {
      vi.useFakeTimers();
      const now = new Date(2026, 0, 15, 12, 0, 0);
      vi.setSystemTime(now);

      const lastScreenshot = new Date(now.getTime() - 130000); // 130 seconds ago
      expect(settings.shouldTakeScreenshot(lastScreenshot)).toBe(true);

      vi.useRealTimers();
    });

    it('should handle exact interval boundary', () => {
      vi.useFakeTimers();
      const now = new Date(2026, 0, 15, 12, 0, 0);
      vi.setSystemTime(now);

      const lastScreenshot = new Date(now.getTime() - 120000); // Exactly 120 seconds ago
      expect(settings.shouldTakeScreenshot(lastScreenshot)).toBe(true);

      vi.useRealTimers();
    });
  });

  describe('edge cases and integration', () => {
    it('should handle empty settings object', () => {
      const result = settings.applySettings({});
      expect(result.changed).toEqual([]);
      expect(result.settings.collectInterval).toBe(300); // Default
    });

    it('should handle mixed case and missing values', () => {
      const cmsSettings = {
        CollectInterval: '450',
        displayName: null,
        SizeX: undefined,
        statsEnabled: ''
      };

      settings.applySettings(cmsSettings);

      expect(settings.settings.collectInterval).toBe(450);
      expect(settings.settings.displayName).toBe('Unknown Display'); // Default
      expect(settings.settings.sizeX).toBe(1920); // Default
      expect(settings.settings.statsEnabled).toBe(false); // Default
    });

    it('should handle multiple consecutive applies', () => {
      // First apply
      settings.applySettings({ collectInterval: 600, displayName: 'Display 1' });
      expect(settings.settings.collectInterval).toBe(600);
      expect(settings.settings.displayName).toBe('Display 1');

      // Second apply (different interval)
      settings.applySettings({ collectInterval: 900, displayName: 'Display 2' });
      expect(settings.settings.collectInterval).toBe(900);
      expect(settings.settings.displayName).toBe('Display 2');

      // Third apply (same interval, different name)
      settings.applySettings({ collectInterval: 900, displayName: 'Display 3' });
      expect(settings.settings.collectInterval).toBe(900);
      expect(settings.settings.displayName).toBe('Display 3');
    });

    it('should preserve settings across multiple applies', () => {
      // Apply initial settings
      settings.applySettings({
        collectInterval: 600,
        displayName: 'Test',
        statsEnabled: '1'
      });

      expect(settings.settings.statsEnabled).toBe(true);
      expect(settings.settings.displayName).toBe('Test');

      // Apply partial update (NOTE: settings are re-applied from scratch, not preserved)
      // This matches upstream behavior where each RegisterDisplay overwrites settings
      settings.applySettings({ collectInterval: 900 });

      // After partial update, missing values revert to defaults (not preserved)
      expect(settings.settings.statsEnabled).toBe(false); // Reverts to default
      expect(settings.settings.collectInterval).toBe(900);
    });

    it('should handle SSP (ad space) settings', () => {
      settings.applySettings({ isAdspaceEnabled: '1' });
      expect(settings.settings.isSspEnabled).toBe(true);

      settings.applySettings({ isAdspaceEnabled: '0' });
      expect(settings.settings.isSspEnabled).toBe(false);

      settings.applySettings({ IsAdspaceEnabled: '1' });
      expect(settings.settings.isSspEnabled).toBe(true);
    });

    it('should handle XMR settings', () => {
      const cmsSettings = {
        xmrNetworkAddress: 'tcp://xmr.example.com:9505',
        xmrWebSocketAddress: 'ws://xmr.example.com:9505',
        xmrCmsKey: 'test-key-12345'
      };

      settings.applySettings(cmsSettings);

      expect(settings.settings.xmrNetworkAddress).toBe('tcp://xmr.example.com:9505');
      expect(settings.settings.xmrWebSocketAddress).toBe('ws://xmr.example.com:9505');
      expect(settings.settings.xmrCmsKey).toBe('test-key-12345');
    });

    it('should handle all supported log levels', () => {
      const levels = ['error', 'audit', 'info', 'debug'];

      for (const level of levels) {
        settings.applySettings({ logLevel: level });
        expect(settings.settings.logLevel).toBe(level);
      }
    });
  });
});
