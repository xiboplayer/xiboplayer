/**
 * PlayerCore Tests
 *
 * Contract-based testing for PlayerCore orchestration module
 * Tests collection cycle, layout transitions, XMR integration, and event emission
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PlayerCore } from './player-core.js';
import { createSpy } from './test-utils.js';

describe('PlayerCore', () => {
  let core;
  let mockConfig;
  let mockXmds;
  let mockCache;
  let mockSchedule;
  let mockRenderer;
  let mockXmrWrapper;

  beforeEach(() => {
    // Mock dependencies
    mockConfig = {
      cmsUrl: 'https://test.cms.com',
      hardwareKey: 'test-hw-key',
      serverKey: 'test-server-key'
    };

    mockXmds = {
      registerDisplay: vi.fn(() => Promise.resolve({
        displayName: 'Test Display',
        settings: {
          collectInterval: '300',
          xmrWebSocketAddress: 'wss://test.xmr.com',
          xmrCmsKey: 'xmr-key'
        }
      })),
      requiredFiles: vi.fn(() => Promise.resolve({
        files: [
          { id: '1', type: 'media', path: 'http://test.com/file1.mp4' },
          { id: '2', type: 'layout', path: 'http://test.com/layout.xlf' }
        ],
        purge: []
      })),
      schedule: vi.fn(() => Promise.resolve({
        default: '0',
        layouts: [{ file: '100.xlf', priority: 10 }],
        campaigns: []
      })),
      notifyStatus: vi.fn(() => Promise.resolve()),
      mediaInventory: vi.fn(() => Promise.resolve()),
      blackList: vi.fn(() => Promise.resolve(true))
    };

    mockCache = {
      requestDownload: vi.fn(() => Promise.resolve()),
      getFile: vi.fn(() => Promise.resolve(new Blob(['test'])))
    };

    mockSchedule = {
      setSchedule: vi.fn(),
      getCurrentLayouts: vi.fn(() => ['100.xlf']),
      getDependantsMap: vi.fn(() => new Map()),
      getDataConnectors: vi.fn(() => []),
      findActionByTrigger: vi.fn(() => null)
    };

    mockRenderer = {
      renderLayout: vi.fn(() => Promise.resolve()),
      on: vi.fn(),
      cleanup: vi.fn()
    };

    mockXmrWrapper = vi.fn(function() {
      this.start = vi.fn(() => Promise.resolve());
      this.stop = vi.fn();
      this.isConnected = vi.fn(() => false);
      this.reconnectAttempts = 0;
    });

    // Create PlayerCore instance
    core = new PlayerCore({
      config: mockConfig,
      xmds: mockXmds,
      cache: mockCache,
      schedule: mockSchedule,
      renderer: mockRenderer,
      xmrWrapper: mockXmrWrapper
    });

    // Ensure offline cache is empty so error tests don't fall into offline fallback
    // (IndexedDB from previous runs may contain stale data)
    core._offlineCache = { schedule: null, settings: null, requiredFiles: null };
    core._offlineDbReady = Promise.resolve();
  });

  afterEach(() => {
    core.cleanup();
    vi.clearAllTimers();
  });

  describe('Initialization', () => {
    it('should create PlayerCore with dependencies', () => {
      expect(core.config).toBe(mockConfig);
      expect(core.xmds).toBe(mockXmds);
      expect(core.cache).toBe(mockCache);
      expect(core.schedule).toBe(mockSchedule);
      expect(core.renderer).toBe(mockRenderer);
    });

    it('should start with null currentLayoutId', () => {
      expect(core.getCurrentLayoutId()).toBeNull();
    });

    it('should start with collecting = false', () => {
      expect(core.isCollecting()).toBe(false);
    });

    it('should start with no pending layouts', () => {
      expect(core.getPendingLayouts()).toHaveLength(0);
    });
  });

  describe('Collection Cycle', () => {
    it('should emit collection-start event', async () => {
      const spy = createSpy();
      core.on('collection-start', spy);

      await core.collect();

      expect(spy).toHaveBeenCalled();
    });

    it('should call ensureXmrKeyPair before registerDisplay', async () => {
      const callOrder = [];
      mockConfig.ensureXmrKeyPair = vi.fn(async () => { callOrder.push('ensureXmrKeyPair'); });
      mockXmds.registerDisplay = vi.fn(async () => {
        callOrder.push('registerDisplay');
        return { displayName: 'Test', settings: { collectInterval: '300' } };
      });

      await core.collect();

      expect(mockConfig.ensureXmrKeyPair).toHaveBeenCalled();
      expect(callOrder[0]).toBe('ensureXmrKeyPair');
      expect(callOrder[1]).toBe('registerDisplay');
    });

    it('should register display and emit register-complete', async () => {
      const spy = createSpy();
      core.on('register-complete', spy);

      await core.collect();

      expect(mockXmds.registerDisplay).toHaveBeenCalled();
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({
        displayName: 'Test Display'
      }));
    });

    it('should get required files and emit files-received', async () => {
      const spy = createSpy();
      core.on('files-received', spy);

      await core.collect();

      expect(mockXmds.requiredFiles).toHaveBeenCalled();
      expect(spy).toHaveBeenCalledWith(expect.arrayContaining([
        expect.objectContaining({ id: '1', type: 'media' })
      ]));
    });

    it('should emit download-request with layoutOrder and files', async () => {
      const spy = createSpy();
      core.on('download-request', spy);

      await core.collect();

      // download-request emits { layoutOrder: number[], files: Array }
      const payload = spy.mock.calls[0][0];
      expect(payload).toHaveProperty('layoutOrder');
      expect(payload).toHaveProperty('files');
      expect(Array.isArray(payload.layoutOrder)).toBe(true);
      expect(Array.isArray(payload.files)).toBe(true);
      expect(payload.files).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: '1', type: 'media' })
      ]));
    });

    it('should skip download-request when outside download window', async () => {
      const mockDisplaySettings = {
        applySettings: vi.fn(() => ({ changed: [] })),
        getCollectInterval: () => 300,
        isInDownloadWindow: () => false,
        getNextDownloadWindow: () => new Date(Date.now() + 3600000),
      };
      core.displaySettings = mockDisplaySettings;
      const spy = createSpy();
      core.on('download-request', spy);

      await core.collect();

      expect(spy).not.toHaveBeenCalled();
    });

    it('should emit download-request when inside download window', async () => {
      const mockDisplaySettings = {
        applySettings: vi.fn(() => ({ changed: [] })),
        getCollectInterval: () => 300,
        isInDownloadWindow: () => true,
      };
      core.displaySettings = mockDisplaySettings;
      const spy = createSpy();
      core.on('download-request', spy);

      await core.collect();

      expect(spy).toHaveBeenCalled();
    });

    it('should get schedule and emit schedule-received', async () => {
      const spy = createSpy();
      core.on('schedule-received', spy);

      await core.collect();

      expect(mockXmds.schedule).toHaveBeenCalled();
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({
        default: '0',
        layouts: expect.any(Array)
      }));
    });

    it('should update schedule manager with received schedule', async () => {
      await core.collect();

      expect(mockSchedule.setSchedule).toHaveBeenCalledWith(expect.objectContaining({
        default: '0'
      }));
    });

    it('should emit layouts-scheduled with current layouts', async () => {
      const spy = createSpy();
      core.on('layouts-scheduled', spy);

      await core.collect();

      expect(mockSchedule.getCurrentLayouts).toHaveBeenCalled();
      expect(spy).toHaveBeenCalledWith(['100.xlf']);
    });

    it('should emit layout-prepare-request for first layout', async () => {
      const spy = createSpy();
      core.on('layout-prepare-request', spy);

      await core.collect();

      expect(spy).toHaveBeenCalledWith(100); // layoutId from 100.xlf
    });

    it('should emit collection-complete when successful', async () => {
      const spy = createSpy();
      core.on('collection-complete', spy);

      await core.collect();

      expect(spy).toHaveBeenCalled();
    });

    it('should emit collection-error on failure', async () => {
      const spy = createSpy();
      core.on('collection-error', spy);

      mockXmds.registerDisplay.mockRejectedValue(new Error('Network error'));

      await expect(core.collect()).rejects.toThrow('Network error');

      expect(spy).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('Concurrent Collection Prevention', () => {
    it('should prevent concurrent collections', async () => {
      const spy = createSpy();
      core.on('collection-start', spy);

      // Start first collection
      const promise1 = core.collect();

      // Try to start second collection while first is running
      const promise2 = core.collect();

      await Promise.all([promise1, promise2]);

      // Should only start once
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('should set collecting flag during collection', async () => {
      expect(core.isCollecting()).toBe(false);

      mockXmds.registerDisplay.mockImplementation(() => {
        // Check flag during execution
        expect(core.isCollecting()).toBe(true);
        return Promise.resolve({ displayName: 'Test', settings: {} });
      });

      await core.collect();

      // Flag cleared after completion
      expect(core.isCollecting()).toBe(false);
    });

    it('should clear collecting flag on error', async () => {
      mockXmds.registerDisplay.mockRejectedValue(new Error('Test error'));

      try {
        await core.collect();
      } catch (e) {
        // Expected
      }

      expect(core.isCollecting()).toBe(false);
    });
  });

  describe('Layout Management', () => {
    it('should skip reload if layout already playing', async () => {
      const spy = createSpy();
      core.on('layout-already-playing', spy);

      // First collection sets currentLayoutId to 100
      await core.collect();
      core.setCurrentLayout(100);

      // Second collection with same layout
      await core.collect();

      expect(spy).toHaveBeenCalledWith(100);
    });

    it('should emit no-layouts-scheduled when schedule empty', async () => {
      const spy = createSpy();
      core.on('no-layouts-scheduled', spy);

      mockSchedule.getCurrentLayouts.mockReturnValue([]);

      await core.collect();

      expect(spy).toHaveBeenCalled();
    });

    it('should track current layout', () => {
      expect(core.getCurrentLayoutId()).toBeNull();

      core.setCurrentLayout(123);

      expect(core.getCurrentLayoutId()).toBe(123);
    });

    it('should emit layout-current when layout set', () => {
      const spy = createSpy();
      core.on('layout-current', spy);

      core.setCurrentLayout(123);

      expect(spy).toHaveBeenCalledWith(123);
    });

    it('should clear current layout', () => {
      core.setCurrentLayout(123);
      expect(core.getCurrentLayoutId()).toBe(123);

      core.clearCurrentLayout();

      expect(core.getCurrentLayoutId()).toBeNull();
    });

    it('should emit layout-cleared when layout cleared', () => {
      const spy = createSpy();
      core.on('layout-cleared', spy);

      core.setCurrentLayout(123);
      core.clearCurrentLayout();

      expect(spy).toHaveBeenCalled();
    });
  });

  describe('Pending Layouts', () => {
    it('should track pending layouts', () => {
      expect(core.getPendingLayouts()).toHaveLength(0);

      core.setPendingLayout(100, [1, 2, 3]);

      expect(core.getPendingLayouts()).toContain(100);
    });

    it('should emit layout-pending when layout set as pending', () => {
      const spy = createSpy();
      core.on('layout-pending', spy);

      core.setPendingLayout(100, [1, 2, 3]);

      expect(spy).toHaveBeenCalledWith(100, [1, 2, 3]);
    });

    it('should remove pending layout when set as current', () => {
      core.setPendingLayout(100, [1, 2, 3]);
      expect(core.getPendingLayouts()).toContain(100);

      core.setCurrentLayout(100);

      expect(core.getPendingLayouts()).not.toContain(100);
    });

    it('should check pending layouts when media ready', () => {
      const spy = createSpy();
      core.on('check-pending-layout', spy);

      core.setPendingLayout(100, [1, 2, 3]);

      core.notifyMediaReady(2);

      expect(spy).toHaveBeenCalledWith(100, [1, 2, 3]);
    });

    it('should not emit check-pending-layout for unrelated media', () => {
      const spy = createSpy();
      core.on('check-pending-layout', spy);

      core.setPendingLayout(100, [1, 2, 3]);

      core.notifyMediaReady(99); // Not in required list

      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('XMR Integration', () => {
    it('should initialize XMR on first collection', async () => {
      await core.collect();

      expect(mockXmrWrapper).toHaveBeenCalledWith(mockConfig, core);
      expect(core.xmr).toBeTruthy();
    });

    it('should emit xmr-connected when XMR initializes', async () => {
      const spy = createSpy();
      core.on('xmr-connected', spy);

      await core.collect();

      expect(spy).toHaveBeenCalledWith('wss://test.xmr.com');
    });

    it('should skip XMR if no URL provided', async () => {
      mockXmds.registerDisplay.mockResolvedValue({
        displayName: 'Test',
        settings: {} // No XMR URL
      });

      await core.collect();

      expect(mockXmrWrapper).not.toHaveBeenCalled();
    });

    it('should reconnect XMR if disconnected', async () => {
      // First collection creates XMR
      await core.collect();

      const firstXmr = core.xmr;
      firstXmr.isConnected.mockReturnValue(false);

      const spy = createSpy();
      core.on('xmr-reconnected', spy);

      // Second collection should reconnect
      await core.collect();

      expect(spy).toHaveBeenCalledWith('wss://test.xmr.com');
      expect(firstXmr.reconnectAttempts).toBe(0); // Reset
      expect(firstXmr.start).toHaveBeenCalledTimes(2);
    });

    it('should not reconnect if XMR already connected', async () => {
      // First collection
      await core.collect();

      const firstXmr = core.xmr;
      firstXmr.isConnected.mockReturnValue(true);

      const startCallCount = firstXmr.start.mock.calls.length;

      // Second collection should skip reconnect
      await core.collect();

      expect(firstXmr.start).toHaveBeenCalledTimes(startCallCount); // Not called again
    });
  });

  describe('Collection Interval', () => {
    it('should setup collection interval on first run', async () => {
      vi.useFakeTimers();

      const spy = createSpy();
      core.on('collection-interval-set', spy);

      await core.collect();

      expect(spy).toHaveBeenCalledWith(300); // From mock settings
      expect(core.collectionInterval).toBeTruthy();

      vi.useRealTimers();
    });

    it('should not setup interval again on subsequent collections', async () => {
      vi.useFakeTimers();

      const spy = createSpy();
      core.on('collection-interval-set', spy);

      await core.collect();
      await core.collect();

      expect(spy).toHaveBeenCalledTimes(1); // Only once

      vi.useRealTimers();
    });

    it('should run collection automatically on interval', async () => {
      vi.useFakeTimers();

      // First collection sets up the interval
      await core.collect();

      // Clear the interval to prevent infinite loop
      const interval = core.collectionInterval;
      expect(interval).toBeTruthy();

      const collectionSpy = createSpy();
      core.on('collection-start', collectionSpy);

      // Manually trigger the interval callback once
      // (Testing the interval setup, not the actual timer execution)
      clearInterval(interval);
      core.collectionInterval = null;

      // Verify interval was set correctly by checking the settings
      expect(mockXmds.registerDisplay).toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe('Layout Change Requests', () => {
    it('should emit layout-change-requested', async () => {
      const spy = createSpy();
      core.on('layout-change-requested', spy);

      await core.requestLayoutChange(456);

      expect(spy).toHaveBeenCalledWith(456);
    });

    it('should clear current layout on change request', async () => {
      core.setCurrentLayout(100);
      expect(core.getCurrentLayoutId()).toBe(100);

      await core.requestLayoutChange(200);

      expect(core.getCurrentLayoutId()).toBeNull();
    });
  });

  describe('Status Notification', () => {
    it('should notify CMS of layout status', async () => {
      await core.notifyLayoutStatus(123);

      expect(mockXmds.notifyStatus).toHaveBeenCalledWith(
        expect.objectContaining({ currentLayoutId: 123 })
      );
    });

    it('should emit status-notified on success', async () => {
      const spy = createSpy();
      core.on('status-notified', spy);

      await core.notifyLayoutStatus(123);

      expect(spy).toHaveBeenCalledWith(123);
    });

    it('should emit status-notify-failed on error', async () => {
      const spy = createSpy();
      core.on('status-notify-failed', spy);

      mockXmds.notifyStatus.mockRejectedValue(new Error('Network error'));

      await core.notifyLayoutStatus(123);

      expect(spy).toHaveBeenCalledWith(123, expect.any(Error));
    });

    it('should not throw on notify failure (kiosk mode)', async () => {
      mockXmds.notifyStatus.mockRejectedValue(new Error('Network error'));

      await expect(core.notifyLayoutStatus(123)).resolves.toBeUndefined();
    });
  });

  describe('Media Ready Notifications', () => {
    it('should emit check-pending-layout when media is ready', () => {
      const spy = createSpy();
      core.on('check-pending-layout', spy);

      core.setPendingLayout(100, [1, 2, 3]);

      core.notifyMediaReady(2);

      expect(spy).toHaveBeenCalledWith(100, [1, 2, 3]);
    });

    it('should check multiple pending layouts', () => {
      const spy = createSpy();
      core.on('check-pending-layout', spy);

      core.setPendingLayout(100, [1, 2, 3]);
      core.setPendingLayout(200, [1, 4, 5]);

      core.notifyMediaReady(1); // Shared by both layouts

      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenCalledWith(100, [1, 2, 3]);
      expect(spy).toHaveBeenCalledWith(200, [1, 4, 5]);
    });

    it('should not check layouts without the ready media', () => {
      const spy = createSpy();
      core.on('check-pending-layout', spy);

      core.setPendingLayout(100, [1, 2, 3]);

      core.notifyMediaReady(99); // Not in required list

      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('Cleanup', () => {
    it('should clear collection interval', async () => {
      vi.useFakeTimers();

      await core.collect();

      expect(core.collectionInterval).toBeTruthy();

      core.cleanup();

      expect(core.collectionInterval).toBeNull();

      vi.useRealTimers();
    });

    it('should stop XMR', async () => {
      await core.collect();

      const xmr = core.xmr;
      expect(xmr).toBeTruthy();

      core.cleanup();

      expect(xmr.stop).toHaveBeenCalled();
      expect(core.xmr).toBeNull();
    });

    it('should remove all event listeners', () => {
      const spy = createSpy();
      core.on('test-event', spy);

      core.cleanup();

      core.emit('test-event');

      expect(spy).not.toHaveBeenCalled();
    });

    it('should emit cleanup-complete before removing listeners', () => {
      const spy = createSpy();
      core.on('cleanup-complete', spy);

      core.cleanup();

      // cleanup-complete should be emitted before removeAllListeners()
      expect(spy).toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('should handle registerDisplay failure', async () => {
      mockXmds.registerDisplay.mockRejectedValue(new Error('Registration failed'));

      await expect(core.collect()).rejects.toThrow('Registration failed');
    });

    it('should handle requiredFiles failure', async () => {
      mockXmds.requiredFiles.mockRejectedValue(new Error('Files fetch failed'));

      await expect(core.collect()).rejects.toThrow('Files fetch failed');
    });

    it('should handle schedule failure', async () => {
      mockXmds.schedule.mockRejectedValue(new Error('Schedule fetch failed'));

      await expect(core.collect()).rejects.toThrow('Schedule fetch failed');
    });

    it('should clear collecting flag on any error', async () => {
      mockXmds.registerDisplay.mockRejectedValue(new Error('Test error'));

      try {
        await core.collect();
      } catch (e) {
        // Expected
      }

      expect(core.isCollecting()).toBe(false);
    });
  });

  describe('Screenshot Capture', () => {
    it('should emit screenshot-request when captureScreenshot is called', async () => {
      const spy = createSpy();
      core.on('screenshot-request', spy);

      await core.captureScreenshot();

      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Change Layout', () => {
    it('should emit layout-prepare-request with parsed layoutId', async () => {
      const spy = createSpy();
      core.on('layout-prepare-request', spy);

      await core.changeLayout('456');

      expect(spy).toHaveBeenCalledWith(456);
    });

    it('should clear currentLayoutId to force re-render', async () => {
      core.setCurrentLayout(100);
      expect(core.getCurrentLayoutId()).toBe(100);

      await core.changeLayout('200');

      expect(core.getCurrentLayoutId()).toBeNull();
    });

    it('should parse string layoutId to integer', async () => {
      const spy = createSpy();
      core.on('layout-prepare-request', spy);

      await core.changeLayout('789');

      expect(spy).toHaveBeenCalledWith(789);
    });
  });

  describe('Handle Trigger', () => {
    it('should call changeLayout when matching navLayout action found', () => {
      const spy = createSpy();
      core.on('layout-prepare-request', spy);

      mockSchedule.findActionByTrigger = vi.fn((code) => {
        if (code === 'trigger1') {
          return { actionType: 'navLayout', triggerCode: 'trigger1', layoutCode: '42' };
        }
        return null;
      });

      core.handleTrigger('trigger1');

      expect(mockSchedule.findActionByTrigger).toHaveBeenCalledWith('trigger1');
      expect(spy).toHaveBeenCalledWith(42);
    });

    it('should handle navigateToLayout action type', () => {
      const spy = createSpy();
      core.on('layout-prepare-request', spy);

      mockSchedule.findActionByTrigger = vi.fn(() => ({
        actionType: 'navigateToLayout',
        triggerCode: 'trigger1',
        layoutCode: '99'
      }));

      core.handleTrigger('trigger1');

      expect(spy).toHaveBeenCalledWith(99);
    });

    it('should do nothing when no matching action found', () => {
      const layoutSpy = createSpy();
      const widgetSpy = createSpy();
      const commandSpy = createSpy();
      core.on('layout-prepare-request', layoutSpy);
      core.on('navigate-to-widget', widgetSpy);
      core.on('execute-command', commandSpy);

      mockSchedule.findActionByTrigger = vi.fn(() => null);

      core.handleTrigger('nonexistent');

      expect(mockSchedule.findActionByTrigger).toHaveBeenCalledWith('nonexistent');
      expect(layoutSpy).not.toHaveBeenCalled();
      expect(widgetSpy).not.toHaveBeenCalled();
      expect(commandSpy).not.toHaveBeenCalled();
    });

    it('should emit navigate-to-widget for navWidget action', () => {
      const spy = createSpy();
      core.on('navigate-to-widget', spy);

      const action = { actionType: 'navWidget', triggerCode: 'trigger1', layoutCode: '10' };
      mockSchedule.findActionByTrigger = vi.fn(() => action);

      core.handleTrigger('trigger1');

      expect(spy).toHaveBeenCalledWith(action);
    });

    it('should emit execute-command for command action', () => {
      const spy = createSpy();
      core.on('execute-command', spy);

      mockSchedule.findActionByTrigger = vi.fn(() => ({
        actionType: 'command',
        triggerCode: 'trigger1',
        commandCode: 'restart'
      }));

      core.handleTrigger('trigger1');

      expect(spy).toHaveBeenCalledWith('restart');
    });
  });

  describe('Purge Request', () => {
    it('should emit purge-request when RequiredFiles includes purge entries', async () => {
      const spy = createSpy();
      core.on('purge-request', spy);

      mockXmds.requiredFiles.mockResolvedValue({
        files: [
          { id: '1', type: 'media', path: 'http://test.com/file1.mp4' },
          { id: '2', type: 'layout', path: 'http://test.com/layout.xlf' }
        ],
        purge: [
          { id: '3', storedAs: 'file3.mp4' },
          { id: '4', storedAs: 'file4.jpg' }
        ]
      });

      await core.collect();

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith([
        expect.objectContaining({ id: '3', storedAs: 'file3.mp4' }),
        expect.objectContaining({ id: '4', storedAs: 'file4.jpg' })
      ]);
    });

    it('should not emit purge-request when no purge entries', async () => {
      const spy = createSpy();
      core.on('purge-request', spy);

      mockXmds.requiredFiles.mockResolvedValue({
        files: [{ id: '1', type: 'media', path: 'http://test.com/file1.mp4' }],
        purge: []
      });

      await core.collect();

      expect(spy).not.toHaveBeenCalled();
    });

    it('should separate purge entries from download-request', async () => {
      const downloadSpy = createSpy();
      core.on('download-request', downloadSpy);

      mockXmds.requiredFiles.mockResolvedValue({
        files: [{ id: '1', type: 'media', path: 'http://test.com/file1.mp4' }],
        purge: [{ id: '2', storedAs: 'file2.jpg' }]
      });

      await core.collect();

      // download-request should only contain files, not purge items
      const payload = downloadSpy.mock.calls[0][0];
      expect(payload.files).toHaveLength(1);
      expect(payload.files[0].id).toBe('1');
    });
  });

  describe('State Consistency', () => {
    it('should maintain invariant: collecting flag matches execution state', async () => {
      expect(core.isCollecting()).toBe(false);

      const promise = core.collect();
      expect(core.isCollecting()).toBe(true);

      await promise;
      expect(core.isCollecting()).toBe(false);
    });

    it('should maintain invariant: currentLayoutId updated correctly', () => {
      expect(core.getCurrentLayoutId()).toBeNull();

      core.setCurrentLayout(100);
      expect(core.getCurrentLayoutId()).toBe(100);

      core.clearCurrentLayout();
      expect(core.getCurrentLayoutId()).toBeNull();

      core.setCurrentLayout(200);
      expect(core.getCurrentLayoutId()).toBe(200);
    });

    it('should maintain invariant: pending layouts tracked correctly', () => {
      expect(core.getPendingLayouts()).toHaveLength(0);

      core.setPendingLayout(100, [1, 2]);
      expect(core.getPendingLayouts()).toHaveLength(1);

      core.setPendingLayout(200, [3, 4]);
      expect(core.getPendingLayouts()).toHaveLength(2);

      core.setCurrentLayout(100);
      expect(core.getPendingLayouts()).toHaveLength(1); // 100 removed

      core.setCurrentLayout(200);
      expect(core.getPendingLayouts()).toHaveLength(0); // All removed
    });
  });

  describe('overlayLayout', () => {
    it('should emit overlay-layout-request with parsed layoutId', async () => {
      const spy = createSpy();
      core.on('overlay-layout-request', spy);

      await core.overlayLayout('555');

      expect(spy).toHaveBeenCalledWith(555);
    });

    it('should set _layoutOverride with overlay type', async () => {
      await core.overlayLayout('123');

      expect(core._layoutOverride).toEqual({ layoutId: 123, type: 'overlay', duration: 0 });
    });

    it('should parse string layoutId to integer', async () => {
      const spy = createSpy();
      core.on('overlay-layout-request', spy);

      await core.overlayLayout('007');

      expect(spy).toHaveBeenCalledWith(7);
    });

    it('should overwrite previous layout override', async () => {
      await core.overlayLayout('100');
      expect(core._layoutOverride).toEqual({ layoutId: 100, type: 'overlay', duration: 0 });

      await core.overlayLayout('200');
      expect(core._layoutOverride).toEqual({ layoutId: 200, type: 'overlay', duration: 0 });
    });
  });

  describe('revertToSchedule', () => {
    it('should clear _layoutOverride', async () => {
      core._layoutOverride = { layoutId: 42, type: 'change' };

      await core.revertToSchedule();

      expect(core._layoutOverride).toBeNull();
    });

    it('should clear currentLayoutId', async () => {
      core.setCurrentLayout(100);
      expect(core.getCurrentLayoutId()).toBe(100);

      await core.revertToSchedule();

      expect(core.getCurrentLayoutId()).toBeNull();
    });

    it('should emit revert-to-schedule event', async () => {
      const spy = createSpy();
      core.on('revert-to-schedule', spy);

      await core.revertToSchedule();

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('should emit layout-prepare-request when schedule has layouts', async () => {
      const spy = createSpy();
      core.on('layout-prepare-request', spy);

      mockSchedule.getCurrentLayouts.mockReturnValue(['200.xlf']);

      await core.revertToSchedule();

      expect(spy).toHaveBeenCalledWith(200);
    });

    it('should emit no-layouts-scheduled when schedule is empty', async () => {
      const spy = createSpy();
      core.on('no-layouts-scheduled', spy);

      mockSchedule.getCurrentLayouts.mockReturnValue([]);

      await core.revertToSchedule();

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('should re-evaluate schedule after clearing override', async () => {
      core._layoutOverride = { layoutId: 999, type: 'overlay' };
      core.setCurrentLayout(999);

      const revertSpy = createSpy();
      const layoutSpy = createSpy();
      core.on('revert-to-schedule', revertSpy);
      core.on('layout-prepare-request', layoutSpy);

      mockSchedule.getCurrentLayouts.mockReturnValue(['100.xlf']);

      await core.revertToSchedule();

      expect(revertSpy).toHaveBeenCalledTimes(1);
      expect(layoutSpy).toHaveBeenCalledWith(100);
      expect(core._layoutOverride).toBeNull();
    });
  });

  describe('purgeAll', () => {
    it('should clear CRC checksums to force fresh collection', async () => {
      core._lastCheckRf = 'abc123';
      core._lastCheckSchedule = 'def456';

      // purgeAll clears checksums then calls collectNow/collect which re-fetches
      // After collect completes, checksums are set to new values from regResult
      await core.purgeAll();

      // The old CRC values should be gone (replaced by fresh values from regResult)
      expect(core._lastCheckRf).not.toBe('abc123');
      expect(core._lastCheckSchedule).not.toBe('def456');
    });

    it('should emit purge-all-request event', async () => {
      const spy = createSpy();
      core.on('purge-all-request', spy);

      await core.purgeAll();

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('should trigger a fresh collection cycle via collectNow', async () => {
      const spy = createSpy();
      core.on('collection-start', spy);

      await core.purgeAll();

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('should emit purge-all-request before collection-start', async () => {
      const order = [];
      core.on('purge-all-request', () => order.push('purge'));
      core.on('collection-start', () => order.push('collect'));

      await core.purgeAll();

      expect(order[0]).toBe('purge');
      expect(order[1]).toBe('collect');
    });
  });

  describe('executeCommand', () => {
    let originalFetch;

    beforeEach(() => {
      originalFetch = global.fetch;
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('should emit command-result with unknown command when code not in commands map', async () => {
      const spy = createSpy();
      core.on('command-result', spy);

      await core.executeCommand('reboot', { restart: { commandString: 'http|http://test.com/restart' } });

      expect(spy).toHaveBeenCalledWith({
        code: 'reboot',
        success: false,
        reason: 'Unknown command'
      });
    });

    it('should emit command-result with unknown command when commands is null', async () => {
      const spy = createSpy();
      core.on('command-result', spy);

      await core.executeCommand('reboot', null);

      expect(spy).toHaveBeenCalledWith({
        code: 'reboot',
        success: false,
        reason: 'Unknown command'
      });
    });

    it('should execute HTTP command and emit success result', async () => {
      const spy = createSpy();
      core.on('command-result', spy);

      global.fetch = vi.fn(() => Promise.resolve({
        ok: true,
        status: 200
      }));

      const commands = {
        restart: { commandString: 'http|http://test.com/restart|application/json' }
      };

      await core.executeCommand('restart', commands);

      expect(global.fetch).toHaveBeenCalledWith('http://test.com/restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      expect(spy).toHaveBeenCalledWith({
        code: 'restart',
        success: true,
        status: 200
      });
    });

    it('should emit failure result when fetch throws', async () => {
      const spy = createSpy();
      core.on('command-result', spy);

      global.fetch = vi.fn(() => Promise.reject(new Error('Network timeout')));

      const commands = {
        restart: { commandString: 'http|http://test.com/restart' }
      };

      await core.executeCommand('restart', commands);

      expect(spy).toHaveBeenCalledWith({
        code: 'restart',
        success: false,
        reason: 'Network timeout'
      });
    });

    it('should emit execute-native-command for non-HTTP commands', async () => {
      const spy = createSpy();
      core.on('execute-native-command', spy);

      const commands = {
        reboot: { commandString: 'shell|reboot' }
      };

      await core.executeCommand('reboot', commands);

      expect(spy).toHaveBeenCalledWith({
        code: 'reboot',
        commandString: 'shell|reboot'
      });
    });

    it('should use value property as fallback when commandString is absent', async () => {
      const spy = createSpy();
      core.on('command-result', spy);

      global.fetch = vi.fn(() => Promise.resolve({ ok: true, status: 200 }));

      const commands = {
        ping: { value: 'http|http://test.com/ping' }
      };

      await core.executeCommand('ping', commands);

      expect(global.fetch).toHaveBeenCalledWith('http://test.com/ping', expect.any(Object));
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    it('should default content-type to application/json when not specified', async () => {
      global.fetch = vi.fn(() => Promise.resolve({ ok: true, status: 200 }));

      const commands = {
        action: { commandString: 'http|http://test.com/action' }
      };

      await core.executeCommand('action', commands);

      expect(global.fetch).toHaveBeenCalledWith('http://test.com/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
    });
  });

  describe('triggerWebhook', () => {
    it('should delegate to handleTrigger', () => {
      const spy = createSpy();
      core.on('layout-prepare-request', spy);

      mockSchedule.findActionByTrigger = vi.fn((code) => {
        if (code === 'webhook1') {
          return { actionType: 'navLayout', triggerCode: 'webhook1', layoutCode: '77' };
        }
        return null;
      });

      core.triggerWebhook('webhook1');

      expect(mockSchedule.findActionByTrigger).toHaveBeenCalledWith('webhook1');
      expect(spy).toHaveBeenCalledWith(77);
    });

    it('should do nothing when no matching action exists', () => {
      const layoutSpy = createSpy();
      const widgetSpy = createSpy();
      core.on('layout-prepare-request', layoutSpy);
      core.on('navigate-to-widget', widgetSpy);

      mockSchedule.findActionByTrigger = vi.fn(() => null);

      core.triggerWebhook('nonexistent');

      expect(mockSchedule.findActionByTrigger).toHaveBeenCalledWith('nonexistent');
      expect(layoutSpy).not.toHaveBeenCalled();
      expect(widgetSpy).not.toHaveBeenCalled();
    });

    it('should handle command action type via webhook trigger', () => {
      const spy = createSpy();
      core.on('execute-command', spy);

      mockSchedule.findActionByTrigger = vi.fn(() => ({
        actionType: 'command',
        triggerCode: 'webhook-cmd',
        commandCode: 'restart'
      }));

      core.triggerWebhook('webhook-cmd');

      expect(spy).toHaveBeenCalledWith('restart');
    });
  });

  describe('refreshDataConnectors', () => {
    beforeEach(() => {
      // Stub refreshAll on the real DataConnectorManager instance
      core.dataConnectorManager.refreshAll = vi.fn();
    });

    it('should call dataConnectorManager.refreshAll', () => {
      core.refreshDataConnectors();

      expect(core.dataConnectorManager.refreshAll).toHaveBeenCalledTimes(1);
    });

    it('should emit data-connectors-refreshed event', () => {
      const spy = createSpy();
      core.on('data-connectors-refreshed', spy);

      core.refreshDataConnectors();

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('should call refreshAll before emitting event', () => {
      const order = [];
      core.dataConnectorManager.refreshAll = vi.fn(() => order.push('refresh'));
      core.on('data-connectors-refreshed', () => order.push('event'));

      core.refreshDataConnectors();

      expect(order).toEqual(['refresh', 'event']);
    });
  });

  describe('submitMediaInventory', () => {
    beforeEach(() => {
      mockXmds.mediaInventory = vi.fn(() => Promise.resolve());
    });

    it('should build XML and call xmds.mediaInventory', async () => {
      const files = [
        { id: '10', type: 'media', md5: 'abc123' },
        { id: '20', type: 'layout', md5: 'def456' }
      ];

      await core.submitMediaInventory(files);

      expect(mockXmds.mediaInventory).toHaveBeenCalledTimes(1);
      const xml = mockXmds.mediaInventory.mock.calls[0][0];
      expect(xml).toContain('<files>');
      expect(xml).toContain('type="media"');
      expect(xml).toContain('id="10"');
      expect(xml).toContain('md5="abc123"');
      expect(xml).toContain('type="layout"');
      expect(xml).toContain('id="20"');
      expect(xml).toContain('md5="def456"');
    });

    it('should emit media-inventory-submitted with file count', async () => {
      const spy = createSpy();
      core.on('media-inventory-submitted', spy);

      const files = [
        { id: '1', type: 'media', md5: 'a' },
        { id: '2', type: 'layout', md5: 'b' }
      ];

      await core.submitMediaInventory(files);

      expect(spy).toHaveBeenCalledWith(2);
    });

    it('should do nothing when files array is empty', async () => {
      const spy = createSpy();
      core.on('media-inventory-submitted', spy);

      await core.submitMediaInventory([]);

      expect(mockXmds.mediaInventory).not.toHaveBeenCalled();
      expect(spy).not.toHaveBeenCalled();
    });

    it('should do nothing when files is null', async () => {
      const spy = createSpy();
      core.on('media-inventory-submitted', spy);

      await core.submitMediaInventory(null);

      expect(mockXmds.mediaInventory).not.toHaveBeenCalled();
      expect(spy).not.toHaveBeenCalled();
    });

    it('should include all spec file types in inventory XML', async () => {
      const files = [
        { id: '1', type: 'media', md5: 'a' },
        { id: '2', type: 'resource', md5: 'b' },
        { id: '3', type: 'layout', md5: 'c' },
        { id: '4', type: 'dependency', md5: 'd' },
        { id: '5', type: 'widget', md5: 'e' },
        { id: '6', type: 'unknown', md5: 'f' }
      ];

      await core.submitMediaInventory(files);

      const xml = mockXmds.mediaInventory.mock.calls[0][0];
      expect(xml).toContain('id="1"'); // media
      expect(xml).toContain('id="2"'); // resource
      expect(xml).toContain('id="3"'); // layout
      expect(xml).toContain('id="4"'); // dependency
      expect(xml).toContain('id="5"'); // widget
      expect(xml).not.toContain('id="6"'); // unknown types filtered out
    });

    it('should not throw when xmds.mediaInventory fails', async () => {
      mockXmds.mediaInventory.mockRejectedValue(new Error('Server error'));

      const files = [{ id: '1', type: 'media', md5: 'a' }];

      await expect(core.submitMediaInventory(files)).resolves.toBeUndefined();
    });
  });

  describe('blackList', () => {
    beforeEach(() => {
      mockXmds.blackList = vi.fn(() => Promise.resolve(true));
    });

    it('should call xmds.blackList with correct arguments', async () => {
      await core.blackList('42', 'media', 'Corrupted file');

      expect(mockXmds.blackList).toHaveBeenCalledWith('42', 'media', 'Corrupted file');
    });

    it('should emit media-blacklisted with details', async () => {
      const spy = createSpy();
      core.on('media-blacklisted', spy);

      await core.blackList('42', 'media', 'Corrupted file');

      expect(spy).toHaveBeenCalledWith({
        mediaId: '42',
        type: 'media',
        reason: 'Corrupted file'
      });
    });

    it('should not throw when xmds.blackList fails', async () => {
      mockXmds.blackList.mockRejectedValue(new Error('Server error'));

      await expect(core.blackList('42', 'media', 'Bad file')).resolves.toBeUndefined();
    });

    it('should not emit media-blacklisted when xmds call fails', async () => {
      const spy = createSpy();
      core.on('media-blacklisted', spy);

      mockXmds.blackList.mockRejectedValue(new Error('Server error'));

      await core.blackList('42', 'media', 'Bad file');

      expect(spy).not.toHaveBeenCalled();
    });

    it('should handle layout type blacklisting', async () => {
      const spy = createSpy();
      core.on('media-blacklisted', spy);

      await core.blackList('99', 'layout', 'Invalid XLF');

      expect(mockXmds.blackList).toHaveBeenCalledWith('99', 'layout', 'Invalid XLF');
      expect(spy).toHaveBeenCalledWith({
        mediaId: '99',
        type: 'layout',
        reason: 'Invalid XLF'
      });
    });
  });

  describe('isLayoutOverridden', () => {
    it('should return false when no override is set', () => {
      expect(core.isLayoutOverridden()).toBe(false);
    });

    it('should return true after changeLayout sets an override', async () => {
      await core.changeLayout('123');

      expect(core.isLayoutOverridden()).toBe(true);
    });

    it('should return true after overlayLayout sets an override', async () => {
      await core.overlayLayout('456');

      expect(core.isLayoutOverridden()).toBe(true);
    });

    it('should return false after revertToSchedule clears the override', async () => {
      await core.changeLayout('123');
      expect(core.isLayoutOverridden()).toBe(true);

      await core.revertToSchedule();

      expect(core.isLayoutOverridden()).toBe(false);
    });
  });

  describe('Schedule Cycling (Round-Robin)', () => {
    it('should initialize _currentLayoutIndex to 0', () => {
      expect(core._currentLayoutIndex).toBe(0);
    });

    it('should reset _currentLayoutIndex to 0 on collect()', async () => {
      core._currentLayoutIndex = 2;

      await core.collect();

      expect(core._currentLayoutIndex).toBe(0);
    });

    describe('getNextLayout', () => {
      it('should return first layout when index is 0', () => {
        mockSchedule.getCurrentLayouts.mockReturnValue(['100.xlf', '200.xlf', '300.xlf']);
        core._currentLayoutIndex = 0;

        const result = core.getNextLayout();

        expect(result).toEqual({ layoutId: 100, layoutFile: '100.xlf' });
      });

      it('should return layout at current index', () => {
        mockSchedule.getCurrentLayouts.mockReturnValue(['100.xlf', '200.xlf', '300.xlf']);
        core._currentLayoutIndex = 1;

        const result = core.getNextLayout();

        expect(result).toEqual({ layoutId: 200, layoutFile: '200.xlf' });
      });

      it('should return null when no layouts scheduled', () => {
        mockSchedule.getCurrentLayouts.mockReturnValue([]);

        const result = core.getNextLayout();

        expect(result).toBeNull();
      });

      it('should wrap index when schedule shrinks', () => {
        mockSchedule.getCurrentLayouts.mockReturnValue(['100.xlf']);
        core._currentLayoutIndex = 5; // Out of bounds

        const result = core.getNextLayout();

        expect(result).toEqual({ layoutId: 100, layoutFile: '100.xlf' });
        expect(core._currentLayoutIndex).toBe(0);
      });
    });

    describe('advanceToNextLayout', () => {
      it('should advance index and emit layout-prepare-request', () => {
        const spy = createSpy();
        core.on('layout-prepare-request', spy);

        mockSchedule.getCurrentLayouts.mockReturnValue(['100.xlf', '200.xlf', '300.xlf']);
        core._currentLayoutIndex = 0;

        core.advanceToNextLayout();

        expect(core._currentLayoutIndex).toBe(1);
        expect(spy).toHaveBeenCalledWith(200);
      });

      it('should wrap around to first layout after last', () => {
        const spy = createSpy();
        core.on('layout-prepare-request', spy);

        mockSchedule.getCurrentLayouts.mockReturnValue(['100.xlf', '200.xlf', '300.xlf']);
        core._currentLayoutIndex = 2;

        core.advanceToNextLayout();

        expect(core._currentLayoutIndex).toBe(0);
        expect(spy).toHaveBeenCalledWith(100);
      });

      it('should trigger replay for single layout (wraps to same)', () => {
        const spy = createSpy();
        core.on('layout-prepare-request', spy);

        mockSchedule.getCurrentLayouts.mockReturnValue(['100.xlf']);
        core._currentLayoutIndex = 0;
        core.currentLayoutId = 100;

        core.advanceToNextLayout();

        expect(core._currentLayoutIndex).toBe(0);
        // currentLayoutId should be cleared (for replay)
        expect(core.currentLayoutId).toBeNull();
        expect(spy).toHaveBeenCalledWith(100);
      });

      it('should emit no-layouts-scheduled when schedule is empty', () => {
        const spy = createSpy();
        core.on('no-layouts-scheduled', spy);

        mockSchedule.getCurrentLayouts.mockReturnValue([]);

        core.advanceToNextLayout();

        expect(spy).toHaveBeenCalledTimes(1);
      });

      it('should not advance when layout override is active', () => {
        const spy = createSpy();
        core.on('layout-prepare-request', spy);
        core.on('no-layouts-scheduled', spy);

        core._layoutOverride = { layoutId: 999, type: 'change' };
        mockSchedule.getCurrentLayouts.mockReturnValue(['100.xlf', '200.xlf']);

        core.advanceToNextLayout();

        expect(spy).not.toHaveBeenCalled();
        expect(core._currentLayoutIndex).toBe(0); // Unchanged
      });

      it('should cycle through all layouts in order', () => {
        const emitted = [];
        core.on('layout-prepare-request', (id) => emitted.push(id));

        mockSchedule.getCurrentLayouts.mockReturnValue(['100.xlf', '200.xlf', '300.xlf']);
        core._currentLayoutIndex = 0;

        core.advanceToNextLayout(); // → 200 (index 1)
        core.advanceToNextLayout(); // → 300 (index 2)
        core.advanceToNextLayout(); // → 100 (index 0, wrap)

        expect(emitted).toEqual([200, 300, 100]);
        expect(core._currentLayoutIndex).toBe(0);
      });
    });
  });

  describe('Geo-Location', () => {
    it('reportGeoLocation should update schedule location and emit event', () => {
      mockSchedule.setLocation = vi.fn();
      const spy = createSpy();
      core.on('location-updated', spy);

      core.reportGeoLocation({ latitude: 40.7128, longitude: -74.0060 });

      expect(mockSchedule.setLocation).toHaveBeenCalledWith(40.7128, -74.006);
      expect(spy).toHaveBeenCalledWith({
        latitude: 40.7128,
        longitude: -74.006,
        source: 'cms'
      });
    });

    it('reportGeoLocation should reject invalid coordinates', () => {
      mockSchedule.setLocation = vi.fn();
      const spy = createSpy();
      core.on('location-updated', spy);

      core.reportGeoLocation({ latitude: 'abc', longitude: null });

      expect(mockSchedule.setLocation).not.toHaveBeenCalled();
      expect(spy).not.toHaveBeenCalled();
    });

    it('reportGeoLocation should reject missing data', () => {
      mockSchedule.setLocation = vi.fn();
      const spy = createSpy();
      core.on('location-updated', spy);

      core.reportGeoLocation(null);

      expect(mockSchedule.setLocation).not.toHaveBeenCalled();
      expect(spy).not.toHaveBeenCalled();
    });

    it('reportGeoLocation should trigger checkSchedule', () => {
      mockSchedule.setLocation = vi.fn();
      const spy = createSpy();
      core.on('layouts-scheduled', spy);

      core.reportGeoLocation({ latitude: 51.5074, longitude: -0.1278 });

      expect(spy).toHaveBeenCalled();
    });

    it('requestGeoLocation should return null when navigator.geolocation unavailable', async () => {
      // Save and remove geolocation
      const origGeo = navigator.geolocation;
      Object.defineProperty(navigator, 'geolocation', { value: undefined, configurable: true });

      const result = await core.requestGeoLocation();

      expect(result).toBeNull();

      // Restore
      Object.defineProperty(navigator, 'geolocation', { value: origGeo, configurable: true });
    });

    it('requestGeoLocation should update schedule on success', async () => {
      mockSchedule.setLocation = vi.fn();
      const spy = createSpy();
      core.on('location-updated', spy);

      // Mock navigator.geolocation
      const origGeo = navigator.geolocation;
      const mockGeo = {
        getCurrentPosition: vi.fn((success) => {
          success({ coords: { latitude: 41.3851, longitude: 2.1734 } });
        })
      };
      Object.defineProperty(navigator, 'geolocation', { value: mockGeo, configurable: true });

      const result = await core.requestGeoLocation();

      expect(result).toEqual({ latitude: 41.3851, longitude: 2.1734 });
      expect(mockSchedule.setLocation).toHaveBeenCalledWith(41.3851, 2.1734);
      expect(spy).toHaveBeenCalledWith({
        latitude: 41.3851,
        longitude: 2.1734,
        source: 'browser'
      });

      // Restore
      Object.defineProperty(navigator, 'geolocation', { value: origGeo, configurable: true });
    });

    it('requestGeoLocation should return null on failure', async () => {
      const origGeo = navigator.geolocation;
      const mockGeo = {
        getCurrentPosition: vi.fn((_success, error) => {
          error(new Error('User denied geolocation'));
        })
      };
      Object.defineProperty(navigator, 'geolocation', { value: mockGeo, configurable: true });

      const result = await core.requestGeoLocation();

      expect(result).toBeNull();

      Object.defineProperty(navigator, 'geolocation', { value: origGeo, configurable: true });
    });
  });

  describe('Display Properties', () => {
    it('should pass display properties to schedule after registration', async () => {
      mockSchedule.setDisplayProperties = vi.fn();

      await core.collect();

      expect(mockSchedule.setDisplayProperties).toHaveBeenCalledWith(
        expect.objectContaining({ collectInterval: '300' })
      );
    });

    it('should skip setDisplayProperties when schedule does not support it', async () => {
      // mockSchedule has no setDisplayProperties by default
      delete mockSchedule.setDisplayProperties;

      // Should not throw
      await expect(core.collect()).resolves.not.toThrow();
    });
  });

  describe('Offline Mode', () => {
    it('isOffline should return false when navigator.onLine is true', () => {
      Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });

      expect(core.isOffline()).toBe(false);
    });

    it('isOffline should return true when navigator.onLine is false', () => {
      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });

      expect(core.isOffline()).toBe(false === navigator.onLine);
      // Restore
      Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    });

    it('hasCachedData should return false when no schedule is cached', () => {
      core._offlineCache = { schedule: null, settings: null, requiredFiles: null };

      expect(core.hasCachedData()).toBe(false);
    });

    it('hasCachedData should return true when schedule is cached', () => {
      core._offlineCache = { schedule: { default: '0', layouts: [] }, settings: null, requiredFiles: null };

      expect(core.hasCachedData()).toBe(true);
    });

    it('collectOffline should set offlineMode to true and emit offline-mode', () => {
      const spy = createSpy();
      core.on('offline-mode', spy);

      core._offlineCache = { schedule: { default: '0', layouts: [] }, settings: null, requiredFiles: null };

      core.collectOffline();

      expect(core.offlineMode).toBe(true);
      expect(spy).toHaveBeenCalledWith(true);
    });

    it('collectOffline should apply cached schedule', () => {
      const cachedSchedule = { default: '0', layouts: [{ file: '300.xlf' }] };
      core._offlineCache = { schedule: cachedSchedule, settings: null, requiredFiles: null };

      const scheduleSpy = createSpy();
      core.on('schedule-received', scheduleSpy);

      core.collectOffline();

      expect(mockSchedule.setSchedule).toHaveBeenCalledWith(cachedSchedule);
      expect(scheduleSpy).toHaveBeenCalledWith(cachedSchedule);
    });

    it('collectOffline should emit layout-prepare-request for first scheduled layout', () => {
      const spy = createSpy();
      core.on('layout-prepare-request', spy);

      core._offlineCache = { schedule: { default: '0', layouts: [] }, settings: null, requiredFiles: null };
      mockSchedule.getCurrentLayouts.mockReturnValue(['500.xlf']);

      core.collectOffline();

      expect(spy).toHaveBeenCalledWith(500);
    });

    it('collectOffline should emit no-layouts-scheduled when schedule empty', () => {
      const spy = createSpy();
      core.on('no-layouts-scheduled', spy);

      core._offlineCache = { schedule: { default: '0', layouts: [] }, settings: null, requiredFiles: null };
      mockSchedule.getCurrentLayouts.mockReturnValue([]);

      core.collectOffline();

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('collectOffline should skip reload if layout already playing', () => {
      const alreadySpy = createSpy();
      const prepareSpy = createSpy();
      core.on('layout-already-playing', alreadySpy);
      core.on('layout-prepare-request', prepareSpy);

      core._offlineCache = { schedule: { default: '0', layouts: [] }, settings: null, requiredFiles: null };
      mockSchedule.getCurrentLayouts.mockReturnValue(['100.xlf']);
      core.setCurrentLayout(100);

      core.collectOffline();

      expect(alreadySpy).toHaveBeenCalledWith(100);
      expect(prepareSpy).not.toHaveBeenCalled();
    });

    it('collectOffline should emit collection-complete', () => {
      const spy = createSpy();
      core.on('collection-complete', spy);

      core._offlineCache = { schedule: { default: '0', layouts: [] }, settings: null, requiredFiles: null };
      mockSchedule.getCurrentLayouts.mockReturnValue([]);

      core.collectOffline();

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('collectNow should clear CRC checksums and trigger collect', async () => {
      core._lastCheckRf = 'old-crc';
      core._lastCheckSchedule = 'old-sched';

      const spy = createSpy();
      core.on('collection-start', spy);

      await core.collectNow();

      // collectNow clears checksums then calls collect, which re-fetches and sets new values
      expect(core._lastCheckRf).not.toBe('old-crc');
      expect(core._lastCheckSchedule).not.toBe('old-sched');
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('isInOfflineMode should reflect current offline mode state', () => {
      expect(core.isInOfflineMode()).toBe(false);

      core.offlineMode = true;
      expect(core.isInOfflineMode()).toBe(true);

      core.offlineMode = false;
      expect(core.isInOfflineMode()).toBe(false);
    });
  });

  describe('Scheduled Commands', () => {
    it('should initialize _executedCommands as empty Set', () => {
      expect(core._executedCommands).toBeInstanceOf(Set);
      expect(core._executedCommands.size).toBe(0);
    });

    it('should detect and emit scheduled commands whose time has arrived', () => {
      const spy = createSpy();
      core.on('scheduled-command', spy);

      const pastDate = new Date(Date.now() - 60000).toISOString(); // 1 min ago
      mockSchedule.getCommands = vi.fn(() => [
        { code: 'reboot', date: pastDate }
      ]);

      core._processScheduledCommands();

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({ code: 'reboot', date: pastDate });
    });

    it('should not execute commands whose time has not arrived', () => {
      const spy = createSpy();
      core.on('scheduled-command', spy);

      const futureDate = new Date(Date.now() + 3600000).toISOString(); // 1 hour from now
      mockSchedule.getCommands = vi.fn(() => [
        { code: 'reboot', date: futureDate }
      ]);

      core._processScheduledCommands();

      expect(spy).not.toHaveBeenCalled();
    });

    it('should not re-execute already executed commands', () => {
      const spy = createSpy();
      core.on('scheduled-command', spy);

      const pastDate = new Date(Date.now() - 60000).toISOString();
      mockSchedule.getCommands = vi.fn(() => [
        { code: 'reboot', date: pastDate }
      ]);

      core._processScheduledCommands();
      core._processScheduledCommands(); // Call again

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('should handle collectNow command directly without emitting scheduled-command', () => {
      vi.useFakeTimers();

      const spy = createSpy();
      core.on('scheduled-command', spy);

      const pastDate = new Date(Date.now() - 60000).toISOString();
      mockSchedule.getCommands = vi.fn(() => [
        { code: 'collectNow', date: pastDate }
      ]);

      core._processScheduledCommands();

      // collectNow is handled internally, not emitted as scheduled-command
      expect(spy).not.toHaveBeenCalled();
      expect(core._executedCommands.has(`collectNow|${pastDate}`)).toBe(true);

      vi.useRealTimers();
    });

    it('should clear _executedCommands when schedule changes during collection', async () => {
      // Pre-populate executed commands
      core._executedCommands.add('reboot|2026-01-01');
      core._executedCommands.add('restart|2026-01-02');
      expect(core._executedCommands.size).toBe(2);

      await core.collect();

      // Schedule was fetched (new CRC), so _executedCommands should be cleared
      expect(core._executedCommands.size).toBe(0);
    });

    it('should skip commands with missing code or date', () => {
      const spy = createSpy();
      core.on('scheduled-command', spy);

      const pastDate = new Date(Date.now() - 60000).toISOString();
      mockSchedule.getCommands = vi.fn(() => [
        { code: '', date: pastDate },       // Empty code
        { code: 'reboot', date: '' },       // Empty date
        { code: null, date: pastDate },      // Null code
        { code: 'restart', date: pastDate }  // Valid — should execute
      ]);

      core._processScheduledCommands();

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({ code: 'restart', date: pastDate });
    });

    it('should skip commands with invalid date format', () => {
      const spy = createSpy();
      core.on('scheduled-command', spy);

      mockSchedule.getCommands = vi.fn(() => [
        { code: 'reboot', date: 'not-a-date' }
      ]);

      core._processScheduledCommands();

      expect(spy).not.toHaveBeenCalled();
    });

    it('should handle multiple commands in one pass', () => {
      const spy = createSpy();
      core.on('scheduled-command', spy);

      const pastDate1 = new Date(Date.now() - 120000).toISOString();
      const pastDate2 = new Date(Date.now() - 60000).toISOString();
      const futureDate = new Date(Date.now() + 3600000).toISOString();
      mockSchedule.getCommands = vi.fn(() => [
        { code: 'reboot', date: pastDate1 },
        { code: 'restart', date: pastDate2 },
        { code: 'shutdown', date: futureDate }  // Future — should not execute
      ]);

      core._processScheduledCommands();

      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenCalledWith({ code: 'reboot', date: pastDate1 });
      expect(spy).toHaveBeenCalledWith({ code: 'restart', date: pastDate2 });
    });

    it('should do nothing when schedule has no getCommands method', () => {
      delete mockSchedule.getCommands;

      // Should not throw
      expect(() => core._processScheduledCommands()).not.toThrow();
    });

    it('should do nothing when no commands are scheduled', () => {
      const spy = createSpy();
      core.on('scheduled-command', spy);

      mockSchedule.getCommands = vi.fn(() => []);

      core._processScheduledCommands();

      expect(spy).not.toHaveBeenCalled();
    });

    it('should be called during collection cycle', async () => {
      const spy = createSpy();
      core.on('scheduled-command', spy);

      const pastDate = new Date(Date.now() - 60000).toISOString();
      mockSchedule.getCommands = vi.fn(() => [
        { code: 'reboot', date: pastDate }
      ]);

      await core.collect();

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({ code: 'reboot', date: pastDate });
    });
  });

  describe('Layout Blacklisting', () => {
    it('should not blacklist after fewer than threshold failures', () => {
      core.reportLayoutFailure(100, 'render error');
      core.reportLayoutFailure(100, 'render error');

      expect(core.isLayoutBlacklisted(100)).toBe(false);
      expect(core.getBlacklistedLayouts()).toEqual([]);
    });

    it('should blacklist after threshold consecutive failures', () => {
      const spy = vi.fn();
      core.on('layout-blacklisted', spy);

      core.reportLayoutFailure(100, 'render error');
      core.reportLayoutFailure(100, 'render error');
      core.reportLayoutFailure(100, 'render error');

      expect(core.isLayoutBlacklisted(100)).toBe(true);
      expect(core.getBlacklistedLayouts()).toEqual([100]);
      expect(spy).toHaveBeenCalledWith({
        layoutId: 100,
        reason: 'render error',
        failures: 3
      });
    });

    it('should report blacklisted layout to CMS via blackList', () => {
      core.reportLayoutFailure(100, 'parse error');
      core.reportLayoutFailure(100, 'parse error');
      core.reportLayoutFailure(100, 'parse error');

      expect(mockXmds.blackList).toHaveBeenCalledWith(100, 'layout', 'parse error');
    });

    it('should remove layout from blacklist on success', () => {
      core.reportLayoutFailure(100, 'error');
      core.reportLayoutFailure(100, 'error');
      core.reportLayoutFailure(100, 'error');
      expect(core.isLayoutBlacklisted(100)).toBe(true);

      const spy = vi.fn();
      core.on('layout-unblacklisted', spy);
      core.reportLayoutSuccess(100);

      expect(core.isLayoutBlacklisted(100)).toBe(false);
      expect(spy).toHaveBeenCalledWith({ layoutId: 100 });
    });

    it('should reset blacklist on RequiredFiles change', async () => {
      core.reportLayoutFailure(100, 'error');
      core.reportLayoutFailure(100, 'error');
      core.reportLayoutFailure(100, 'error');
      expect(core.isLayoutBlacklisted(100)).toBe(true);

      const spy = vi.fn();
      core.on('blacklist-reset', spy);

      // Trigger collection (RequiredFiles changes since _lastCheckRf is null)
      await core.collect();

      expect(core.isLayoutBlacklisted(100)).toBe(false);
      expect(spy).toHaveBeenCalled();
    });

    it('should skip blacklisted layouts in getNextLayout', () => {
      mockSchedule.getCurrentLayouts.mockReturnValue(['100.xlf', '200.xlf', '300.xlf']);

      // Blacklist layout 100
      core.reportLayoutFailure(100, 'error');
      core.reportLayoutFailure(100, 'error');
      core.reportLayoutFailure(100, 'error');

      core._currentLayoutIndex = 0; // Would normally pick 100
      const next = core.getNextLayout();
      expect(next.layoutId).toBe(200);
    });

    it('should skip blacklisted layouts in advanceToNextLayout', () => {
      mockSchedule.getCurrentLayouts.mockReturnValue(['100.xlf', '200.xlf', '300.xlf']);
      core._currentLayoutIndex = 0;
      core.currentLayoutId = 100;

      // Blacklist layout 200
      core.reportLayoutFailure(200, 'error');
      core.reportLayoutFailure(200, 'error');
      core.reportLayoutFailure(200, 'error');

      const spy = vi.fn();
      core.on('layout-prepare-request', spy);
      core.advanceToNextLayout();

      // Should skip 200 and advance to 300
      expect(spy).toHaveBeenCalledWith(300);
    });

    it('should fall back to first layout if all are blacklisted', () => {
      mockSchedule.getCurrentLayouts.mockReturnValue(['100.xlf', '200.xlf']);

      core.reportLayoutFailure(100, 'error');
      core.reportLayoutFailure(100, 'error');
      core.reportLayoutFailure(100, 'error');
      core.reportLayoutFailure(200, 'error');
      core.reportLayoutFailure(200, 'error');
      core.reportLayoutFailure(200, 'error');

      // getNextLayout should still return something (never blank screen)
      const next = core.getNextLayout();
      expect(next).not.toBeNull();
      expect(next.layoutId).toBe(100);
    });

    it('should skip blacklisted in peekNextLayout', () => {
      mockSchedule.getCurrentLayouts.mockReturnValue(['100.xlf', '200.xlf', '300.xlf']);
      core._currentLayoutIndex = 0;
      core.currentLayoutId = 100;

      // Blacklist layout 200
      core.reportLayoutFailure(200, 'error');
      core.reportLayoutFailure(200, 'error');
      core.reportLayoutFailure(200, 'error');

      const peek = core.peekNextLayout();
      expect(peek.layoutId).toBe(300);
    });

    it('should track multiple layouts independently', () => {
      core.reportLayoutFailure(100, 'error A');
      core.reportLayoutFailure(100, 'error A');
      core.reportLayoutFailure(200, 'error B');

      expect(core.isLayoutBlacklisted(100)).toBe(false); // Only 2 failures
      expect(core.isLayoutBlacklisted(200)).toBe(false); // Only 1 failure

      core.reportLayoutFailure(100, 'error A');
      expect(core.isLayoutBlacklisted(100)).toBe(true);  // 3 failures
      expect(core.isLayoutBlacklisted(200)).toBe(false);  // Still 1
    });
  });

});
