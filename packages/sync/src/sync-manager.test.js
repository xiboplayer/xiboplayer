/**
 * SyncManager unit tests
 *
 * Tests multi-display sync coordination via BroadcastChannel.
 * Uses a simple BroadcastChannel mock for Node.js environment.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SyncManager } from './sync-manager.js';

// ── BroadcastChannel mock ──────────────────────────────────────────
// Simulates same-origin message passing between instances

const channels = new Map(); // channelName → Set<{onmessage}>

class MockBroadcastChannel {
  constructor(name) {
    this.name = name;
    this.onmessage = null;
    this._closed = false;

    if (!channels.has(name)) {
      channels.set(name, new Set());
    }
    channels.get(name).add(this);
  }

  postMessage(data) {
    if (this._closed) return;
    const peers = channels.get(this.name);
    if (!peers) return;

    // Deliver to all OTHER instances on the same channel (not self)
    for (const peer of peers) {
      if (peer !== this && peer.onmessage && !peer._closed) {
        // Clone data to simulate structured clone
        peer.onmessage({ data: JSON.parse(JSON.stringify(data)) });
      }
    }
  }

  close() {
    this._closed = true;
    const peers = channels.get(this.name);
    if (peers) {
      peers.delete(this);
      if (peers.size === 0) channels.delete(this.name);
    }
  }
}

// Install mock globally
globalThis.BroadcastChannel = MockBroadcastChannel;

// ── Helper to flush microtasks ──────────────────────────────────────
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

describe('SyncManager', () => {
  let lead;
  let follower1;
  let follower2;

  const makeSyncConfig = (isLead) => ({
    syncGroup: isLead ? 'lead' : '192.168.1.100',
    syncPublisherPort: 9590,
    syncSwitchDelay: 50, // Short delays for tests
    syncVideoPauseDelay: 10,
    isLead,
  });

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    channels.clear();
  });

  afterEach(() => {
    lead?.stop();
    follower1?.stop();
    follower2?.stop();
    vi.useRealTimers();
    channels.clear();
  });

  describe('Initialization', () => {
    it('should create lead SyncManager', () => {
      lead = new SyncManager({
        displayId: 'pwa-lead',
        syncConfig: makeSyncConfig(true),
      });

      expect(lead.isLead).toBe(true);
      expect(lead.displayId).toBe('pwa-lead');
    });

    it('should create follower SyncManager', () => {
      follower1 = new SyncManager({
        displayId: 'pwa-follower1',
        syncConfig: makeSyncConfig(false),
      });

      expect(follower1.isLead).toBe(false);
    });

    it('should start and open BroadcastChannel', () => {
      lead = new SyncManager({
        displayId: 'pwa-lead',
        syncConfig: makeSyncConfig(true),
      });
      lead.start();

      expect(lead.channel).not.toBeNull();
      expect(lead.getStatus().started).toBe(true);
    });

    it('should stop and close BroadcastChannel', () => {
      lead = new SyncManager({
        displayId: 'pwa-lead',
        syncConfig: makeSyncConfig(true),
      });
      lead.start();
      lead.stop();

      expect(lead.channel).toBeNull();
      expect(lead.getStatus().started).toBe(false);
    });
  });

  describe('Heartbeat', () => {
    it('should discover followers via heartbeat', async () => {
      lead = new SyncManager({
        displayId: 'pwa-lead',
        syncConfig: makeSyncConfig(true),
      });
      follower1 = new SyncManager({
        displayId: 'pwa-f1',
        syncConfig: makeSyncConfig(false),
      });

      lead.start();
      follower1.start();

      // Initial heartbeat is sent on start()
      await tick();

      expect(lead.followers.size).toBe(1);
      expect(lead.followers.has('pwa-f1')).toBe(true);
    });

    it('should discover multiple followers', async () => {
      lead = new SyncManager({
        displayId: 'pwa-lead',
        syncConfig: makeSyncConfig(true),
      });
      follower1 = new SyncManager({
        displayId: 'pwa-f1',
        syncConfig: makeSyncConfig(false),
      });
      follower2 = new SyncManager({
        displayId: 'pwa-f2',
        syncConfig: makeSyncConfig(false),
      });

      lead.start();
      follower1.start();
      follower2.start();

      await tick();

      expect(lead.followers.size).toBe(2);
    });
  });

  describe('Layout Change Protocol', () => {
    it('should send layout-change to followers', async () => {
      const onLayoutChange = vi.fn();

      lead = new SyncManager({
        displayId: 'pwa-lead',
        syncConfig: makeSyncConfig(true),
      });
      follower1 = new SyncManager({
        displayId: 'pwa-f1',
        syncConfig: makeSyncConfig(false),
        onLayoutChange,
      });

      lead.start();
      follower1.start();
      await tick();

      // Lead requests layout change (don't await — follower will report ready)
      const changePromise = lead.requestLayoutChange('100');

      await tick();

      // Follower should receive layout-change callback
      expect(onLayoutChange).toHaveBeenCalledWith('100', expect.any(Number));

      // Simulate follower reporting ready
      follower1.reportReady('100');
      await tick();

      // Advance timers for switchDelay
      vi.advanceTimersByTime(100);
      await changePromise;
    });

    it('should call onLayoutShow on both lead and follower', async () => {
      const leadOnShow = vi.fn();
      const followerOnShow = vi.fn();

      lead = new SyncManager({
        displayId: 'pwa-lead',
        syncConfig: makeSyncConfig(true),
        onLayoutShow: leadOnShow,
      });
      follower1 = new SyncManager({
        displayId: 'pwa-f1',
        syncConfig: makeSyncConfig(false),
        onLayoutShow: followerOnShow,
        onLayoutChange: () => {
          // Immediately report ready when layout change is requested
          setTimeout(() => follower1.reportReady('100'), 5);
        },
      });

      lead.start();
      follower1.start();
      await tick();

      const changePromise = lead.requestLayoutChange('100');

      // Wait for follower to process and report ready
      vi.advanceTimersByTime(10);
      await tick();

      // Wait for switchDelay
      vi.advanceTimersByTime(100);
      await changePromise;

      expect(leadOnShow).toHaveBeenCalledWith('100');
      expect(followerOnShow).toHaveBeenCalledWith('100');
    });

    it('should proceed after timeout if follower is unresponsive', async () => {
      const leadOnShow = vi.fn();

      lead = new SyncManager({
        displayId: 'pwa-lead',
        syncConfig: makeSyncConfig(true),
        onLayoutShow: leadOnShow,
      });
      follower1 = new SyncManager({
        displayId: 'pwa-f1',
        syncConfig: makeSyncConfig(false),
        // Follower does NOT report ready (simulates unresponsive)
        onLayoutChange: () => {},
      });

      lead.start();
      follower1.start();
      await tick();

      const changePromise = lead.requestLayoutChange('200');

      // Advance past ready timeout (10s) + switch delay
      vi.advanceTimersByTime(11000);
      await tick();
      await changePromise;

      // Lead should show anyway after timeout
      expect(leadOnShow).toHaveBeenCalledWith('200');
    });

    it('should proceed immediately with no followers', async () => {
      const leadOnShow = vi.fn();

      lead = new SyncManager({
        displayId: 'pwa-lead',
        syncConfig: makeSyncConfig(true),
        onLayoutShow: leadOnShow,
      });

      lead.start();
      await tick();

      const changePromise = lead.requestLayoutChange('300');

      // Just switch delay, no follower waiting
      vi.advanceTimersByTime(100);
      await changePromise;

      expect(leadOnShow).toHaveBeenCalledWith('300');
    });
  });

  describe('Video Start', () => {
    it('should send video-start signal to followers', async () => {
      const onVideoStart = vi.fn();

      lead = new SyncManager({
        displayId: 'pwa-lead',
        syncConfig: makeSyncConfig(true),
      });
      follower1 = new SyncManager({
        displayId: 'pwa-f1',
        syncConfig: makeSyncConfig(false),
        onVideoStart,
      });

      lead.start();
      follower1.start();
      await tick();

      const videoPromise = lead.requestVideoStart('100', 'region-1');

      // Wait for videoPauseDelay
      vi.advanceTimersByTime(20);
      await videoPromise;

      expect(onVideoStart).toHaveBeenCalledWith('100', 'region-1');
    });
  });

  describe('Status', () => {
    it('should report accurate status', async () => {
      lead = new SyncManager({
        displayId: 'pwa-lead',
        syncConfig: makeSyncConfig(true),
      });
      follower1 = new SyncManager({
        displayId: 'pwa-f1',
        syncConfig: makeSyncConfig(false),
      });

      lead.start();
      follower1.start();
      await tick();

      const status = lead.getStatus();
      expect(status.started).toBe(true);
      expect(status.isLead).toBe(true);
      expect(status.followers).toBe(1);
      expect(status.followerDetails).toHaveLength(1);
      expect(status.followerDetails[0].displayId).toBe('pwa-f1');
    });
  });

  describe('Edge Cases', () => {
    it('follower should not process requestLayoutChange', async () => {
      follower1 = new SyncManager({
        displayId: 'pwa-f1',
        syncConfig: makeSyncConfig(false),
      });
      follower1.start();

      // Should not throw, just warn and return
      await follower1.requestLayoutChange('100');
    });

    it('should ignore own messages', async () => {
      const onLayoutChange = vi.fn();

      lead = new SyncManager({
        displayId: 'pwa-lead',
        syncConfig: makeSyncConfig(true),
        onLayoutChange,
      });

      lead.start();
      await tick();

      // Lead should not receive its own heartbeat as a follower
      expect(lead.followers.size).toBe(0);
    });
  });

  describe('Stats/Logs Delegation', () => {
    it('follower receives stats-ack after lead calls ack()', () => {
      const onStatsAck = vi.fn();
      const onStatsReport = vi.fn((_id, _xml, ack) => ack());

      lead = new SyncManager({
        displayId: 'pwa-lead',
        syncConfig: makeSyncConfig(true),
        onStatsReport,
      });
      follower1 = new SyncManager({
        displayId: 'pwa-f1',
        syncConfig: makeSyncConfig(false),
        onStatsAck,
      });
      lead.start();
      follower1.start();

      follower1.reportStats('<stats>test</stats>');

      expect(onStatsReport).toHaveBeenCalledWith(
        'pwa-f1',
        '<stats>test</stats>',
        expect.any(Function),
      );
      expect(onStatsAck).toHaveBeenCalledWith('pwa-f1');
    });

    it('no ack when lead does not call ack() (CMS failure)', () => {
      const onStatsAck = vi.fn();
      const onStatsReport = vi.fn((_id, _xml, _ack) => { /* no ack */ });

      lead = new SyncManager({
        displayId: 'pwa-lead',
        syncConfig: makeSyncConfig(true),
        onStatsReport,
      });
      follower1 = new SyncManager({
        displayId: 'pwa-f1',
        syncConfig: makeSyncConfig(false),
        onStatsAck,
      });
      lead.start();
      follower1.start();

      follower1.reportStats('<stats>test</stats>');

      expect(onStatsReport).toHaveBeenCalled();
      expect(onStatsAck).not.toHaveBeenCalled();
    });

    it('lead ignores stats-report from itself (self-message guard)', () => {
      const onStatsReport = vi.fn();

      lead = new SyncManager({
        displayId: 'pwa-lead',
        syncConfig: makeSyncConfig(true),
        onStatsReport,
      });
      lead.start();

      // Simulate: lead sends a stats-report with its own displayId
      // The _handleMessage guard should reject it (msg.displayId === this.displayId)
      lead._send({
        type: 'stats-report',
        displayId: 'pwa-lead',
        statsXml: '<stats>self</stats>',
      });

      expect(onStatsReport).not.toHaveBeenCalled();
    });

    it('logs delegation works same as stats', () => {
      const onLogsAck = vi.fn();
      const onLogsReport = vi.fn((_id, _xml, ack) => ack());

      lead = new SyncManager({
        displayId: 'pwa-lead',
        syncConfig: makeSyncConfig(true),
        onLogsReport,
      });
      follower1 = new SyncManager({
        displayId: 'pwa-f1',
        syncConfig: makeSyncConfig(false),
        onLogsAck,
      });
      lead.start();
      follower1.start();

      follower1.reportLogs('<logs>test-logs</logs>');

      expect(onLogsReport).toHaveBeenCalledWith(
        'pwa-f1',
        '<logs>test-logs</logs>',
        expect.any(Function),
      );
      expect(onLogsAck).toHaveBeenCalledWith('pwa-f1');
    });
  });
});
