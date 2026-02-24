/**
 * Test Utilities for XMR Package
 *
 * Provides mocking utilities, test helpers, and fixtures for XMR tests.
 */

import { vi } from 'vitest';

/**
 * Create a spy that tracks calls but doesn't interfere
 *
 * Usage:
 *   const spy = createSpy();
 *   xmr.on('event', spy);
 *   // ... trigger event
 *   expect(spy).toHaveBeenCalledWith('arg1', 'arg2');
 */
export function createSpy() {
  return vi.fn();
}

/**
 * Mock Xmr class from @xibosignage/xibo-communication-framework
 *
 * Usage:
 *   const MockXmr = mockXmr();
 *   // Use in tests
 */
export function mockXmr() {
  class MockXmr {
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

  return MockXmr;
}

/**
 * Mock player instance with all required methods
 *
 * Usage:
 *   const mockPlayer = createMockPlayer();
 *   const wrapper = new XmrWrapper(config, mockPlayer);
 */
export function createMockPlayer() {
  return {
    collect: vi.fn(() => Promise.resolve()),
    captureScreenshot: vi.fn(() => Promise.resolve()),
    changeLayout: vi.fn(() => Promise.resolve()),
    overlayLayout: vi.fn(() => Promise.resolve()),
    revertToSchedule: vi.fn(() => Promise.resolve()),
    purgeAll: vi.fn(() => Promise.resolve()),
    executeCommand: vi.fn(() => Promise.resolve()),
    triggerWebhook: vi.fn(),
    refreshDataConnectors: vi.fn(),
    reportGeoLocation: vi.fn(() => Promise.resolve()),
    requestGeoLocation: vi.fn(() => Promise.resolve({ latitude: 41.3851, longitude: 2.1734 })),
    updateStatus: vi.fn()
  };
}

/**
 * Mock config for XMR tests
 */
export function createMockConfig(overrides = {}) {
  return {
    cmsUrl: 'https://test.cms.com',
    hardwareKey: 'test-hw-key',
    serverKey: 'test-server-key',
    xmrChannel: 'test-channel',
    data: {
      xmrPubKey: '',
      xmrPrivKey: '',
    },
    ensureXmrKeyPair: vi.fn(async function () {
      this.data.xmrPubKey = '-----BEGIN PUBLIC KEY-----\nMOCK\n-----END PUBLIC KEY-----';
      this.data.xmrPrivKey = '-----BEGIN PRIVATE KEY-----\nMOCK\n-----END PRIVATE KEY-----';
    }),
    ...overrides
  };
}

/**
 * Wait for condition to be true
 *
 * Usage:
 *   await waitFor(() => wrapper.isConnected(), 5000);
 */
export async function waitFor(condition, timeout = 5000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) {
      throw new Error('waitFor timeout');
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/**
 * Wait for a specific time (for testing timing-dependent logic)
 *
 * Usage:
 *   await wait(100); // Wait 100ms
 */
export async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
