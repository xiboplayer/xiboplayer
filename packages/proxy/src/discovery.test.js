// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
import { describe, it, expect } from 'vitest';
import { getLanIp, advertiseSyncService, discoverSyncLead } from './discovery.js';

describe('getLanIp', () => {
  it('should return a non-empty IPv4 string', () => {
    const ip = getLanIp();
    expect(ip).toBeTruthy();
    expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  it('should not return a loopback address', () => {
    const ip = getLanIp();
    expect(ip).not.toBe('127.0.0.1');
  });
});

describe('advertiseSyncService + discoverSyncLead', () => {
  it('should advertise and discover a sync service by syncGroupId', async () => {
    const ad = advertiseSyncService({ port: 19590, syncGroupId: '99', displayId: 'test-lead' });

    try {
      const result = await discoverSyncLead({ syncGroupId: '99', timeout: 5000 });
      expect(result).toBeTruthy();
      expect(result.port).toBe(19590);
      expect(result.host).toBeTruthy();
    } finally {
      ad.stop();
    }
  });

  it('should filter by syncGroupId — wrong group returns null', async () => {
    const ad = advertiseSyncService({ port: 19591, syncGroupId: '100', displayId: 'test-lead-2' });

    try {
      const result = await discoverSyncLead({ syncGroupId: '999', timeout: 2000 });
      expect(result).toBeNull();
    } finally {
      ad.stop();
    }
  });

  it('should return null on timeout when no service is advertised', async () => {
    const result = await discoverSyncLead({ syncGroupId: '777', timeout: 1000 });
    expect(result).toBeNull();
  });

  it('should stop advertising when stop() is called', async () => {
    const ad = advertiseSyncService({ port: 19592, syncGroupId: '101', displayId: 'test-lead-3' });
    ad.stop();

    // Give mDNS time to process the de-advertisement
    await new Promise((r) => setTimeout(r, 500));

    const result = await discoverSyncLead({ syncGroupId: '101', timeout: 2000 });
    expect(result).toBeNull();
  });
});
