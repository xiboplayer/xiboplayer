// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
import { describe, it, expect, beforeEach } from 'vitest';
import { OverlayScheduler } from './overlays.js';

function makeOverlay(overrides = {}) {
  return {
    file: 100,
    fromdt: '2026-01-01T00:00:00',
    todt: '2026-12-31T23:59:59',
    priority: 0,
    ...overrides,
  };
}

describe('OverlayScheduler', () => {
  let scheduler;

  beforeEach(() => {
    scheduler = new OverlayScheduler();
  });

  // ── Constructor ────────────────────────────────────────────────

  describe('constructor', () => {
    it('initializes with empty overlays', () => {
      expect(scheduler.overlays).toEqual([]);
      expect(scheduler.displayProperties).toEqual({});
    });
  });

  // ── setOverlays ───────────────────────────────────────────────

  describe('setOverlays', () => {
    it('stores overlay list', () => {
      scheduler.setOverlays([makeOverlay()]);
      expect(scheduler.overlays).toHaveLength(1);
    });

    it('handles null/undefined', () => {
      scheduler.setOverlays(null);
      expect(scheduler.overlays).toEqual([]);
    });

    it('replaces previous overlays', () => {
      scheduler.setOverlays([makeOverlay({ file: 1 })]);
      scheduler.setOverlays([makeOverlay({ file: 2 }), makeOverlay({ file: 3 })]);
      expect(scheduler.overlays).toHaveLength(2);
      expect(scheduler.overlays[0].file).toBe(2);
    });
  });

  // ── isTimeActive ──────────────────────────────────────────────

  describe('isTimeActive', () => {
    it('returns true when now is within time window', () => {
      const overlay = makeOverlay({
        fromdt: '2026-03-01T00:00:00',
        todt: '2026-03-31T23:59:59',
      });
      const now = new Date('2026-03-15T12:00:00');
      expect(scheduler.isTimeActive(overlay, now)).toBe(true);
    });

    it('returns false when now is before fromdt', () => {
      const overlay = makeOverlay({ fromdt: '2026-06-01T00:00:00' });
      const now = new Date('2026-05-01T12:00:00');
      expect(scheduler.isTimeActive(overlay, now)).toBe(false);
    });

    it('returns false when now is after todt', () => {
      const overlay = makeOverlay({ todt: '2026-01-01T00:00:00' });
      const now = new Date('2026-06-01T12:00:00');
      expect(scheduler.isTimeActive(overlay, now)).toBe(false);
    });

    it('returns true when no time bounds set', () => {
      const overlay = { file: 1 }; // no fromdt/todt
      expect(scheduler.isTimeActive(overlay, new Date())).toBe(true);
    });

    it('supports toDt (camelCase) alias', () => {
      const overlay = { file: 1, fromDt: '2026-01-01', toDt: '2026-12-31' };
      expect(scheduler.isTimeActive(overlay, new Date('2026-06-15'))).toBe(true);
    });
  });

  // ── getCurrentOverlays ────────────────────────────────────────

  describe('getCurrentOverlays', () => {
    it('returns empty array when no overlays set', () => {
      expect(scheduler.getCurrentOverlays()).toEqual([]);
    });

    it('returns only overlays within time window', () => {
      scheduler.setOverlays([
        makeOverlay({ file: 1, fromdt: '2026-01-01', todt: '2026-06-30' }),
        makeOverlay({ file: 2, fromdt: '2026-07-01', todt: '2026-12-31' }),
      ]);

      // Mock Date to be in Q1
      const origDate = global.Date;
      global.Date = class extends origDate {
        constructor(...args) {
          if (args.length === 0) return new origDate('2026-03-15T12:00:00');
          return new origDate(...args);
        }
      };

      const active = scheduler.getCurrentOverlays();
      expect(active).toHaveLength(1);
      expect(active[0].file).toBe(1);

      global.Date = origDate;
    });

    it('sorts by priority descending', () => {
      scheduler.setOverlays([
        makeOverlay({ file: 1, priority: 5 }),
        makeOverlay({ file: 2, priority: 10 }),
        makeOverlay({ file: 3, priority: 1 }),
      ]);

      // All overlays are within 2026 time window
      const origDate = global.Date;
      global.Date = class extends origDate {
        constructor(...args) {
          if (args.length === 0) return new origDate('2026-06-15T12:00:00');
          return new origDate(...args);
        }
      };

      const active = scheduler.getCurrentOverlays();
      expect(active[0].priority).toBe(10);
      expect(active[1].priority).toBe(5);
      expect(active[2].priority).toBe(1);

      global.Date = origDate;
    });

    it('defaults priority to 0 when not set', () => {
      scheduler.setOverlays([
        makeOverlay({ file: 1 }), // no priority
        makeOverlay({ file: 2, priority: 5 }),
      ]);

      const origDate = global.Date;
      global.Date = class extends origDate {
        constructor(...args) {
          if (args.length === 0) return new origDate('2026-06-15T12:00:00');
          return new origDate(...args);
        }
      };

      const active = scheduler.getCurrentOverlays();
      expect(active[0].file).toBe(2); // priority 5 first
      expect(active[1].file).toBe(1); // priority 0

      global.Date = origDate;
    });

    it('filters by geo-fence when isGeoAware', () => {
      const mockScheduleManager = {
        isWithinGeoFence: () => false,
        isTimeActive: (item, now) => {
          const from = item.fromdt ? new Date(item.fromdt) : null;
          const to = item.todt ? new Date(item.todt) : null;
          if (from && now < from) return false;
          if (to && now > to) return false;
          return true;
        },
      };
      scheduler.setScheduleManager(mockScheduleManager);

      scheduler.setOverlays([
        makeOverlay({ file: 1, isGeoAware: true, geoLocation: { lat: 41, lng: 2 } }),
        makeOverlay({ file: 2 }), // not geo-aware
      ]);

      const origDate = global.Date;
      global.Date = class extends origDate {
        constructor(...args) {
          if (args.length === 0) return new origDate('2026-06-15T12:00:00');
          return new origDate(...args);
        }
      };

      const active = scheduler.getCurrentOverlays();
      expect(active).toHaveLength(1);
      expect(active[0].file).toBe(2);

      global.Date = origDate;
    });
  });

  // ── getOverlayByFile ──────────────────────────────────────────

  describe('getOverlayByFile', () => {
    it('finds overlay by file ID', () => {
      scheduler.setOverlays([makeOverlay({ file: 42 })]);
      expect(scheduler.getOverlayByFile(42)).not.toBeNull();
      expect(scheduler.getOverlayByFile(42).file).toBe(42);
    });

    it('returns null for unknown file', () => {
      expect(scheduler.getOverlayByFile(999)).toBeNull();
    });
  });

  // ── shouldCheckOverlays ───────────────────────────────────────

  describe('shouldCheckOverlays', () => {
    it('returns true when no last check', () => {
      expect(scheduler.shouldCheckOverlays(null)).toBe(true);
      expect(scheduler.shouldCheckOverlays(undefined)).toBe(true);
    });

    it('returns true after 60+ seconds', () => {
      const lastCheck = Date.now() - 61000;
      expect(scheduler.shouldCheckOverlays(lastCheck)).toBe(true);
    });

    it('returns false within 60 seconds', () => {
      const lastCheck = Date.now() - 30000;
      expect(scheduler.shouldCheckOverlays(lastCheck)).toBe(false);
    });
  });

  // ── clear ───────────────────────────────────

  describe('clear', () => {
    it('removes all overlays', () => {
      scheduler.setOverlays([makeOverlay()]);
      scheduler.clear();
      expect(scheduler.overlays).toHaveLength(0);
    });
  });
});
