// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * XmrWrapper Tests
 *
 * Tests connection lifecycle, all CMS commands, and error handling.
 * Reconnection is delegated to the framework's built-in 60s health-check.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { XmrWrapper } from './xmr-wrapper.js';
import { createSpy, createMockPlayer, createMockConfig, wait } from './test-utils.js';

// Matches "HH:MM:SS.mmm [Name]" timestamp prefix
const ts = (name, suffix = '') =>
  expect.stringMatching(new RegExp(`^\\d{2}:\\d{2}:\\d{2}\\.\\d{3} \\[${name}\\]${suffix}$`));

// Mock the native XmrClient
vi.mock('./xmr-client.js', () => {
  class MockXmrClient {
    constructor(channel) {
      this.channel = channel;
      this.events = new Map();
      this.connected = false;
      this.init = vi.fn(() => Promise.resolve());
      this.start = vi.fn(() => {
        this.connected = true;
        this.emit('connected');
        return Promise.resolve();
      });
      this.stop = vi.fn(() => {
        this.connected = false;
        this.emit('disconnected');
        return Promise.resolve();
      });
      this.send = vi.fn(() => Promise.resolve());
    }

    on(event, callback) {
      if (!this.events.has(event)) {
        this.events.set(event, []);
      }
      this.events.get(event).push(callback);
    }

    emit(event, ...args) {
      const listeners = this.events.get(event);
      if (listeners) {
        listeners.forEach(callback => callback(...args));
      }
    }

    // Simulate CMS sending a command
    simulateCommand(command, data) {
      this.emit(command, data);
    }
  }

  return { XmrClient: MockXmrClient };
});

describe('XmrWrapper', () => {
  let wrapper;
  let mockPlayer;
  let mockConfig;
  let xmrInstance;

  beforeEach(() => {
    vi.clearAllTimers();
    vi.useFakeTimers();

    mockConfig = createMockConfig();
    mockPlayer = createMockPlayer();
    wrapper = new XmrWrapper(mockConfig, mockPlayer);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe('Constructor', () => {
    it('should create XmrWrapper with config and player', () => {
      expect(wrapper.config).toBe(mockConfig);
      expect(wrapper.player).toBe(mockPlayer);
      expect(wrapper.connected).toBe(false);
      expect(wrapper.xmr).toBeNull();
    });
  });

  describe('start(xmrUrl, cmsKey)', () => {
    it('should successfully start XMR connection', async () => {
      const result = await wrapper.start('wss://test.xmr.com', 'cms-key-123');

      expect(result).toBe(true);
      expect(wrapper.connected).toBe(true);
      expect(wrapper.xmr).toBeDefined();
      expect(wrapper.xmr.init).toHaveBeenCalled();
      expect(wrapper.xmr.start).toHaveBeenCalledWith('wss://test.xmr.com', 'cms-key-123');
    });

    it('should reuse existing xmr instance on subsequent start() calls', async () => {
      await wrapper.start('wss://test.xmr.com', 'cms-key-123');
      const firstInstance = wrapper.xmr;

      await wrapper.start('wss://test.xmr.com', 'cms-key-123');

      expect(wrapper.xmr).toBe(firstInstance);
      expect(firstInstance.init).toHaveBeenCalledTimes(1);
      expect(firstInstance.start).toHaveBeenCalledTimes(2);
    });

    it('should create new instance after stop()', async () => {
      await wrapper.start('wss://test.xmr.com', 'cms-key-123');
      const firstInstance = wrapper.xmr;

      await wrapper.stop();
      await wrapper.start('wss://test.xmr.com', 'cms-key-123');

      expect(wrapper.xmr).not.toBe(firstInstance);
    });

    it('should use custom xmrChannel if provided', async () => {
      mockConfig.xmrChannel = 'custom-channel';
      const newWrapper = new XmrWrapper(mockConfig, mockPlayer);

      await newWrapper.start('wss://test.xmr.com', 'cms-key-123');

      expect(newWrapper.xmr.channel).toBe('custom-channel');
    });

    it('should use hardware key as channel if xmrChannel not provided', async () => {
      delete mockConfig.xmrChannel;
      const newWrapper = new XmrWrapper(mockConfig, mockPlayer);

      await newWrapper.start('wss://test.xmr.com', 'cms-key-123');

      expect(newWrapper.xmr.channel).toBe('player-test-hw-key');
    });

    it('should handle connection failure gracefully', async () => {
      // Hook setupEventHandlers to patch the freshly-created Xmr instance
      // (init is an instance property, so prototype patching doesn't work)
      const origSetup = wrapper.setupEventHandlers.bind(wrapper);
      wrapper.setupEventHandlers = function() {
        origSetup.call(this);
        this.xmr.init = vi.fn(() => Promise.reject(new Error('Connection failed')));
      };

      const result = await wrapper.start('wss://test.xmr.com', 'cms-key-123');
      expect(result).toBe(false);

      wrapper.setupEventHandlers = origSetup;
    });
  });

  describe('Event Handlers', () => {
    beforeEach(async () => {
      await wrapper.start('wss://test.xmr.com', 'cms-key-123');
      xmrInstance = wrapper.xmr;
    });

    describe('Connection Events', () => {
      it('should handle connected event', () => {
        wrapper.connected = false;

        xmrInstance.simulateCommand('connected');

        expect(wrapper.connected).toBe(true);
        expect(mockPlayer.emit).toHaveBeenCalledWith('xmr-status', { connected: true });
      });

      it('should handle disconnected event', () => {
        wrapper.connected = true;

        xmrInstance.simulateCommand('disconnected');

        expect(wrapper.connected).toBe(false);
        expect(mockPlayer.emit).toHaveBeenCalledWith('xmr-status', { connected: false });
      });

      it('should handle error event', () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        xmrInstance.simulateCommand('error', new Error('Test error'));

        expect(consoleErrorSpy).toHaveBeenCalled();
        consoleErrorSpy.mockRestore();
      });
    });

    describe('CMS Commands', () => {
      it('should handle collectNow command', async () => {
        xmrInstance.simulateCommand('collectNow');

        // Wait for async handler
        await vi.runAllTimersAsync();

        expect(mockPlayer.collect).toHaveBeenCalled();
      });

      it('should handle collectNow failure gracefully', async () => {
        mockPlayer.collect.mockRejectedValue(new Error('Collection failed'));
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        xmrInstance.simulateCommand('collectNow');
        await vi.runAllTimersAsync();

        // Logger outputs as separate args: '[XMR]', 'collectNow failed:', Error
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          ts('XMR'),
          'collectNow failed:',
          expect.any(Error)
        );
        consoleErrorSpy.mockRestore();
      });

      it('should handle screenShot command', async () => {
        xmrInstance.simulateCommand('screenShot');
        await vi.runAllTimersAsync();

        expect(mockPlayer.captureScreenshot).toHaveBeenCalled();
      });

      it('should handle screenShot failure gracefully', async () => {
        mockPlayer.captureScreenshot.mockRejectedValue(new Error('Screenshot failed'));
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        xmrInstance.simulateCommand('screenShot');
        await vi.runAllTimersAsync();

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          ts('XMR'),
          'screenShot failed:',
          expect.any(Error)
        );
        consoleErrorSpy.mockRestore();
      });

      it('should handle licenceCheck command (no-op)', () => {
        // licenceCheck is a debug-level log — just verify it doesn't throw
        expect(() => {
          xmrInstance.simulateCommand('licenceCheck');
        }).not.toThrow();
      });

      it('should handle changeLayout command', async () => {
        xmrInstance.simulateCommand('changeLayout', 'layout-123');
        await vi.runAllTimersAsync();

        expect(mockPlayer.changeLayout).toHaveBeenCalledWith('layout-123', { duration: 0, changeMode: 'replace' });
      });

      it('should handle changeLayout failure gracefully', async () => {
        mockPlayer.changeLayout.mockRejectedValue(new Error('Layout change failed'));
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        xmrInstance.simulateCommand('changeLayout', 'layout-123');
        await vi.runAllTimersAsync();

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          ts('XMR'),
          'changeLayout failed:',
          expect.any(Error)
        );
        consoleErrorSpy.mockRestore();
      });

      it('should handle rekey command — rotates RSA keys and triggers collect', async () => {
        // Set existing keys
        mockConfig.data.xmrPubKey = 'old-pub-key';
        mockConfig.data.xmrPrivKey = 'old-priv-key';

        xmrInstance.simulateCommand('rekeyAction');
        await vi.runAllTimersAsync();

        // Should clear old keys before regenerating
        expect(mockConfig.ensureXmrKeyPair).toHaveBeenCalled();
        // After ensureXmrKeyPair, new keys should be set
        expect(mockConfig.data.xmrPubKey).toMatch(/^-----BEGIN PUBLIC KEY-----/);
        expect(mockConfig.data.xmrPrivKey).toMatch(/^-----BEGIN PRIVATE KEY-----/);
        // Should trigger collect to re-register with new key
        expect(mockPlayer.collect).toHaveBeenCalled();
      });

      it('should handle rekey failure gracefully', async () => {
        mockConfig.ensureXmrKeyPair.mockRejectedValue(new Error('Key generation failed'));
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        xmrInstance.simulateCommand('rekeyAction');
        await vi.runAllTimersAsync();

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          ts('XMR'),
          'Key rotation failed:',
          expect.any(Error)
        );
        consoleErrorSpy.mockRestore();
      });

      it('should handle criteriaUpdate command', async () => {
        const criteriaData = { displayId: '123', criteria: 'new-criteria' };

        xmrInstance.simulateCommand('criteriaUpdate', criteriaData);
        await vi.runAllTimersAsync();

        // Should trigger collect to get updated criteria
        expect(mockPlayer.collect).toHaveBeenCalled();
      });

      it('should handle criteriaUpdate failure gracefully', async () => {
        mockPlayer.collect.mockRejectedValue(new Error('Collect failed'));
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        xmrInstance.simulateCommand('criteriaUpdate', {});
        await vi.runAllTimersAsync();

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          ts('XMR'),
          'criteriaUpdate failed:',
          expect.any(Error)
        );
        consoleErrorSpy.mockRestore();
      });

      it('should handle currentGeoLocation with coordinates (CMS push)', async () => {
        const geoData = { latitude: 40.7128, longitude: -74.0060 };

        xmrInstance.simulateCommand('currentGeoLocation', geoData);
        await vi.runAllTimersAsync();

        expect(mockPlayer.reportGeoLocation).toHaveBeenCalledWith(geoData);
        expect(mockPlayer.requestGeoLocation).not.toHaveBeenCalled();
      });

      it('should handle currentGeoLocation without coordinates (CMS request)', async () => {
        xmrInstance.simulateCommand('currentGeoLocation', {});
        await vi.runAllTimersAsync();

        expect(mockPlayer.requestGeoLocation).toHaveBeenCalled();
        expect(mockPlayer.reportGeoLocation).not.toHaveBeenCalled();
      });

      it('should handle currentGeoLocation with null data (CMS request)', async () => {
        xmrInstance.simulateCommand('currentGeoLocation', null);
        await vi.runAllTimersAsync();

        expect(mockPlayer.requestGeoLocation).toHaveBeenCalled();
        expect(mockPlayer.reportGeoLocation).not.toHaveBeenCalled();
      });

      it('should handle currentGeoLocation when reportGeoLocation not implemented', async () => {
        delete mockPlayer.reportGeoLocation;
        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        xmrInstance.simulateCommand('currentGeoLocation', { latitude: 40, longitude: -74 });
        await vi.runAllTimersAsync();

        expect(consoleWarnSpy).toHaveBeenCalledWith(
          ts('XMR'),
          'Geo location reporting not implemented in player'
        );
        consoleWarnSpy.mockRestore();
      });

      it('should handle currentGeoLocation when requestGeoLocation not implemented', async () => {
        delete mockPlayer.requestGeoLocation;
        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        xmrInstance.simulateCommand('currentGeoLocation', {});
        await vi.runAllTimersAsync();

        expect(consoleWarnSpy).toHaveBeenCalledWith(
          ts('XMR'),
          'Geo location request not implemented in player'
        );
        consoleWarnSpy.mockRestore();
      });

      it('should handle currentGeoLocation failure gracefully', async () => {
        mockPlayer.requestGeoLocation.mockRejectedValue(new Error('Geo location failed'));
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        xmrInstance.simulateCommand('currentGeoLocation', {});
        await vi.runAllTimersAsync();

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          ts('XMR'),
          'currentGeoLocation failed:',
          expect.any(Error)
        );
        consoleErrorSpy.mockRestore();
      });

      it('should handle overlayLayout command', async () => {
        xmrInstance.simulateCommand('overlayLayout', 'overlay-layout-456');
        await vi.runAllTimersAsync();

        expect(mockPlayer.overlayLayout).toHaveBeenCalledWith('overlay-layout-456', { duration: 0 });
      });

      it('should handle overlayLayout failure gracefully', async () => {
        mockPlayer.overlayLayout.mockRejectedValue(new Error('Overlay layout failed'));
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        xmrInstance.simulateCommand('overlayLayout', 'overlay-layout-456');
        await vi.runAllTimersAsync();

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          ts('XMR'),
          'overlayLayout failed:',
          expect.any(Error)
        );
        consoleErrorSpy.mockRestore();
      });

      it('should handle revertToSchedule command', async () => {
        xmrInstance.simulateCommand('revertToSchedule');
        await vi.runAllTimersAsync();

        expect(mockPlayer.revertToSchedule).toHaveBeenCalled();
      });

      it('should handle revertToSchedule failure gracefully', async () => {
        mockPlayer.revertToSchedule.mockRejectedValue(new Error('Revert failed'));
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        xmrInstance.simulateCommand('revertToSchedule');
        await vi.runAllTimersAsync();

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          ts('XMR'),
          'revertToSchedule failed:',
          expect.any(Error)
        );
        consoleErrorSpy.mockRestore();
      });

      it('should handle purgeAll command', async () => {
        xmrInstance.simulateCommand('purgeAll');
        await vi.runAllTimersAsync();

        expect(mockPlayer.purgeAll).toHaveBeenCalled();
      });

      it('should handle purgeAll failure gracefully', async () => {
        mockPlayer.purgeAll.mockRejectedValue(new Error('Purge failed'));
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        xmrInstance.simulateCommand('purgeAll');
        await vi.runAllTimersAsync();

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          ts('XMR'),
          'purgeAll failed:',
          expect.any(Error)
        );
        consoleErrorSpy.mockRestore();
      });

      it('should handle commandAction with data object', async () => {
        const commandData = { commandCode: 'reboot', commands: '--force' };

        xmrInstance.simulateCommand('commandAction', commandData);
        await vi.runAllTimersAsync();

        expect(mockPlayer.executeCommand).toHaveBeenCalledWith('reboot', '--force');
      });

      it('should handle commandAction with string data (fallback)', async () => {
        xmrInstance.simulateCommand('commandAction', 'reboot');
        await vi.runAllTimersAsync();

        expect(mockPlayer.executeCommand).toHaveBeenCalledWith('reboot', undefined);
      });

      it('should handle commandAction failure gracefully', async () => {
        mockPlayer.executeCommand.mockRejectedValue(new Error('Command failed'));
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        xmrInstance.simulateCommand('commandAction', { commandCode: 'reboot' });
        await vi.runAllTimersAsync();

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          ts('XMR'),
          'commandAction failed:',
          expect.any(Error)
        );
        consoleErrorSpy.mockRestore();
      });

      it('should handle triggerWebhook with data object', async () => {
        const webhookData = { triggerCode: 'webhook-abc' };

        xmrInstance.simulateCommand('triggerWebhook', webhookData);
        await vi.runAllTimersAsync();

        expect(mockPlayer.triggerWebhook).toHaveBeenCalledWith('webhook-abc');
      });

      it('should handle triggerWebhook with string data (fallback)', async () => {
        xmrInstance.simulateCommand('triggerWebhook', 'webhook-xyz');
        await vi.runAllTimersAsync();

        expect(mockPlayer.triggerWebhook).toHaveBeenCalledWith('webhook-xyz');
      });

      it('should handle triggerWebhook failure gracefully', async () => {
        mockPlayer.triggerWebhook.mockImplementation(() => {
          throw new Error('Webhook failed');
        });
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        xmrInstance.simulateCommand('triggerWebhook', { triggerCode: 'webhook-abc' });
        await vi.runAllTimersAsync();

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          ts('XMR'),
          'triggerWebhook failed:',
          expect.any(Error)
        );
        consoleErrorSpy.mockRestore();
      });

      it('should handle dataUpdate command', async () => {
        xmrInstance.simulateCommand('dataUpdate');
        await vi.runAllTimersAsync();

        expect(mockPlayer.refreshDataConnectors).toHaveBeenCalled();
      });

      it('should handle dataUpdate failure gracefully', async () => {
        mockPlayer.refreshDataConnectors.mockImplementation(() => {
          throw new Error('Data refresh failed');
        });
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        xmrInstance.simulateCommand('dataUpdate');
        await vi.runAllTimersAsync();

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          ts('XMR'),
          'dataUpdate failed:',
          expect.any(Error)
        );
        consoleErrorSpy.mockRestore();
      });
    });
  });

  describe('stop()', () => {
    it('should stop XMR connection and null out instance', async () => {
      await wrapper.start('wss://test.xmr.com', 'cms-key-123');
      const xmrRef = wrapper.xmr;
      wrapper.connected = true;

      await wrapper.stop();

      expect(xmrRef.stop).toHaveBeenCalled();
      expect(wrapper.connected).toBe(false);
      expect(wrapper.xmr).toBeNull();
    });

    it('should handle stop when not started', async () => {
      await expect(wrapper.stop()).resolves.not.toThrow();
    });

    it('should handle stop errors gracefully', async () => {
      await wrapper.start('wss://test.xmr.com', 'cms-key-123');
      wrapper.xmr.stop = vi.fn(() => Promise.reject(new Error('Stop failed')));
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await wrapper.stop();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        ts('XMR'),
        'Error stopping:',
        expect.any(Error)
      );
      consoleErrorSpy.mockRestore();
    });
  });

  describe('isConnected()', () => {
    it('should return false when not connected', () => {
      expect(wrapper.isConnected()).toBe(false);
    });

    it('should return true when connected', async () => {
      await wrapper.start('wss://test.xmr.com', 'cms-key-123');

      expect(wrapper.isConnected()).toBe(true);
    });

    it('should return false after disconnect', async () => {
      await wrapper.start('wss://test.xmr.com', 'cms-key-123');
      await wrapper.stop();

      expect(wrapper.isConnected()).toBe(false);
    });
  });

  describe('send(action, data)', () => {
    beforeEach(async () => {
      await wrapper.start('wss://test.xmr.com', 'cms-key-123');
    });

    it('should send message when connected', async () => {
      const result = await wrapper.send('testAction', { test: 'data' });

      expect(result).toBe(true);
      expect(wrapper.xmr.send).toHaveBeenCalledWith('testAction', { test: 'data' });
    });

    it('should not send when disconnected', async () => {
      wrapper.connected = false;

      const result = await wrapper.send('testAction', { test: 'data' });

      expect(result).toBe(false);
      expect(wrapper.xmr.send).not.toHaveBeenCalled();
    });

    it('should handle send errors', async () => {
      wrapper.xmr.send.mockRejectedValue(new Error('Send failed'));
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await wrapper.send('testAction', { test: 'data' });

      expect(result).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });

    it('should not send when xmr not initialized', async () => {
      const newWrapper = new XmrWrapper(mockConfig, mockPlayer);

      const result = await newWrapper.send('testAction', {});

      expect(result).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('should handle multiple simultaneous commands', async () => {
      await wrapper.start('wss://test.xmr.com', 'cms-key-123');
      const xmr = wrapper.xmr;

      xmr.simulateCommand('collectNow');
      xmr.simulateCommand('screenShot');
      xmr.simulateCommand('changeLayout', 'layout-123');

      await vi.runAllTimersAsync();

      expect(mockPlayer.collect).toHaveBeenCalled();
      expect(mockPlayer.captureScreenshot).toHaveBeenCalled();
      expect(mockPlayer.changeLayout).toHaveBeenCalledWith('layout-123', { duration: 0, changeMode: 'replace' });
    });

    it('should handle rapid connect/disconnect cycles', async () => {
      await wrapper.start('wss://test.xmr.com', 'cms-key-123');
      await wrapper.stop();
      await wrapper.start('wss://test.xmr.com', 'cms-key-123');
      await wrapper.stop();

      expect(wrapper.connected).toBe(false);
    });

    it('should maintain connection state across errors', async () => {
      await wrapper.start('wss://test.xmr.com', 'cms-key-123');
      mockPlayer.collect.mockRejectedValue(new Error('Collect failed'));

      wrapper.xmr.simulateCommand('collectNow');
      await vi.runAllTimersAsync();

      expect(wrapper.connected).toBe(true);
    });
  });

  describe('Memory Management', () => {
    it('should null out xmr instance on stop', async () => {
      await wrapper.start('wss://test.xmr.com', 'cms-key-123');
      await wrapper.stop();

      expect(wrapper.xmr).toBeNull();
    });
  });
});
