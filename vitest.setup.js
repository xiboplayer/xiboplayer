/**
 * Vitest setup file
 * Global setup for all tests
 */

import { vi } from 'vitest';
import 'fake-indexeddb/auto';

// Mock fetch (will be overridden in tests that need real network)
global.__nativeFetch = globalThis.fetch;
global.fetch = vi.fn();

// Mock canvas for screenshot tests
global.HTMLCanvasElement = class HTMLCanvasElement {
  constructor() {
    this.width = 0;
    this.height = 0;
  }

  getContext() {
    return {
      fillStyle: '',
      fillRect: vi.fn(),
      drawImage: vi.fn()
    };
  }

  toDataURL() {
    return 'data:image/png;base64,mock';
  }
};

// Stub HTMLMediaElement methods not implemented in jsdom
// (prevents "Not implemented" errors during renderer cleanup)
try {
  window.HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
  window.HTMLMediaElement.prototype.pause = vi.fn();
  window.HTMLMediaElement.prototype.load = vi.fn();
} catch (_) {
  // Fallback if HTMLMediaElement not available (non-jsdom environments)
}

// Mock atob/btoa
global.atob = (str) => Buffer.from(str, 'base64').toString('binary');
global.btoa = (str) => Buffer.from(str, 'binary').toString('base64');

console.log('[vitest.setup] Global mocks initialized (fake-indexeddb active)');
