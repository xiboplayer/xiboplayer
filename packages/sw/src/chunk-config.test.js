// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { calculateChunkConfig } from './chunk-config.js';

const mockLog = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('calculateChunkConfig', () => {
  const origNavigator = global.navigator;

  afterEach(() => {
    // Restore navigator
    Object.defineProperty(global, 'navigator', { value: origNavigator, writable: true, configurable: true });
  });

  function setDeviceMemory(gb) {
    Object.defineProperty(global, 'navigator', {
      value: { ...origNavigator, deviceMemory: gb, userAgent: origNavigator?.userAgent || '' },
      writable: true,
      configurable: true,
    });
  }

  it('returns low-memory config for 0.5 GB', () => {
    setDeviceMemory(0.5);
    const config = calculateChunkConfig(mockLog);
    expect(config.chunkSize).toBe(10 * 1024 * 1024);
    expect(config.concurrency).toBe(1);
  });

  it('returns 1GB config for 1 GB', () => {
    setDeviceMemory(1);
    const config = calculateChunkConfig(mockLog);
    expect(config.chunkSize).toBe(20 * 1024 * 1024);
    expect(config.concurrency).toBe(2);
  });

  it('returns 2GB config for 2 GB', () => {
    setDeviceMemory(2);
    const config = calculateChunkConfig(mockLog);
    expect(config.chunkSize).toBe(30 * 1024 * 1024);
    expect(config.concurrency).toBe(2);
  });

  it('returns 4GB config for 4 GB', () => {
    setDeviceMemory(4);
    const config = calculateChunkConfig(mockLog);
    expect(config.chunkSize).toBe(50 * 1024 * 1024);
    expect(config.concurrency).toBe(4);
  });

  it('returns high-RAM config for 8+ GB', () => {
    setDeviceMemory(8);
    const config = calculateChunkConfig(mockLog);
    expect(config.chunkSize).toBe(100 * 1024 * 1024);
    expect(config.concurrency).toBe(4);
  });

  it('returns high-RAM config for 16 GB', () => {
    setDeviceMemory(16);
    const config = calculateChunkConfig(mockLog);
    expect(config.chunkSize).toBe(100 * 1024 * 1024);
  });

  it('falls back to 4GB default when deviceMemory is undefined', () => {
    // Clear deviceMemory
    Object.defineProperty(global, 'navigator', {
      value: { deviceMemory: undefined, userAgent: 'Mozilla/5.0' },
      writable: true,
      configurable: true,
    });
    const config = calculateChunkConfig(mockLog);
    expect(config.chunkSize).toBe(50 * 1024 * 1024); // 4GB default
  });

  it('always returns all 4 config keys', () => {
    setDeviceMemory(4);
    const config = calculateChunkConfig(mockLog);
    expect(config).toHaveProperty('chunkSize');
    expect(config).toHaveProperty('blobCacheSize');
    expect(config).toHaveProperty('threshold');
    expect(config).toHaveProperty('concurrency');
  });

  it('chunk size scales with memory', () => {
    setDeviceMemory(0.5);
    const low = calculateChunkConfig(mockLog);
    setDeviceMemory(8);
    const high = calculateChunkConfig(mockLog);
    expect(high.chunkSize).toBeGreaterThan(low.chunkSize);
    expect(high.blobCacheSize).toBeGreaterThan(low.blobCacheSize);
  });
});
