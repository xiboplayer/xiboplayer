/**
 * Timeline Calculator Tests
 *
 * Tests for calculateTimeline() — walks a pre-built queue to produce
 * time-stamped playback predictions for the overlay.
 */

import { describe, it, expect } from 'vitest';
import { calculateTimeline, parseLayoutDuration } from './timeline.js';

// Fixed "now" for deterministic tests
const NOW = new Date('2026-03-03T10:00:00Z');

// ── Tests ────────────────────────────────────────────────────────

describe('calculateTimeline', () => {
  describe('Basic queue walking', () => {
    it('should produce entries from a single-entry queue', () => {
      const queue = [{ layoutId: '100.xlf', duration: 30 }];

      const timeline = calculateTimeline(queue, 0, {
        from: NOW, hours: 0.1,
      });

      expect(timeline.length).toBeGreaterThan(0);
      expect(timeline[0].layoutFile).toBe('100.xlf');
      expect(timeline[0].duration).toBe(30);
      expect(timeline[0].isDefault).toBe(false);
    });

    it('should tag default layout entries', () => {
      const queue = [{ layoutId: 'default.xlf', duration: 45 }];

      const timeline = calculateTimeline(queue, 0, {
        from: NOW, hours: 0.1,
        defaultLayout: 'default.xlf',
      });

      expect(timeline[0].layoutFile).toBe('default.xlf');
      expect(timeline[0].isDefault).toBe(true);
      expect(timeline[0].duration).toBe(45);
    });

    it('should cycle through multiple queue entries', () => {
      const queue = [
        { layoutId: '100.xlf', duration: 30 },
        { layoutId: '200.xlf', duration: 45 },
      ];

      const timeline = calculateTimeline(queue, 0, {
        from: NOW, hours: 0.1,
      });

      const files = timeline.map(e => e.layoutFile);
      expect(files).toContain('100.xlf');
      expect(files).toContain('200.xlf');
      // Should alternate
      expect(files[0]).toBe('100.xlf');
      expect(files[1]).toBe('200.xlf');
      expect(files[2]).toBe('100.xlf');
    });

    it('should use live durations map over queue baked-in durations', () => {
      const queue = [{ layoutId: '100.xlf', duration: 60 }]; // queue says 60s
      const durations = new Map([['100.xlf', 300]]); // video metadata says 300s

      const timeline = calculateTimeline(queue, 0, {
        from: NOW, hours: 0.5, durations,
      });

      expect(timeline[0].duration).toBe(300);
      // Only ~6 entries in 30min at 300s each, not 30 at 60s
      expect(timeline.length).toBeLessThanOrEqual(7);
    });

    it('should fall back to queue duration when not in durations map', () => {
      const queue = [{ layoutId: '100.xlf', duration: 45 }];
      const durations = new Map(); // empty

      const timeline = calculateTimeline(queue, 0, {
        from: NOW, hours: 0.1, durations,
      });

      expect(timeline[0].duration).toBe(45);
    });

    it('should start from the given queue position', () => {
      const queue = [
        { layoutId: '100.xlf', duration: 30 },
        { layoutId: '200.xlf', duration: 30 },
        { layoutId: '300.xlf', duration: 30 },
      ];

      const timeline = calculateTimeline(queue, 2, {
        from: NOW, hours: 0.1,
      });

      expect(timeline[0].layoutFile).toBe('300.xlf');
      expect(timeline[1].layoutFile).toBe('100.xlf');
      expect(timeline[2].layoutFile).toBe('200.xlf');
    });

    it('should wrap queue position when past end', () => {
      const queue = [
        { layoutId: '100.xlf', duration: 30 },
        { layoutId: '200.xlf', duration: 30 },
      ];

      const timeline = calculateTimeline(queue, 5, {
        from: NOW, hours: 0.1,
      });

      // 5 % 2 = 1, so starts at 200.xlf
      expect(timeline[0].layoutFile).toBe('200.xlf');
      expect(timeline[1].layoutFile).toBe('100.xlf');
    });
  });

  describe('currentLayoutStartedAt (remaining time adjustment)', () => {
    it('should adjust first entry duration to remaining time', () => {
      const queue = [{ layoutId: '100.xlf', duration: 60 }];

      // Layout started 20 seconds ago → 40 seconds remaining
      const startedAt = new Date(NOW.getTime() - 20000);

      const timeline = calculateTimeline(queue, 0, {
        from: NOW, hours: 0.5,
        currentLayoutStartedAt: startedAt,
      });

      expect(timeline[0].duration).toBe(40); // 60 - 20 = 40
    });

    it('should clamp remaining time to at least 1 second', () => {
      const queue = [{ layoutId: '100.xlf', duration: 30 }];

      // Layout started 60 seconds ago but duration is only 30 → already overdue
      const startedAt = new Date(NOW.getTime() - 60000);

      const timeline = calculateTimeline(queue, 0, {
        from: NOW, hours: 0.1,
        currentLayoutStartedAt: startedAt,
      });

      expect(timeline[0].duration).toBeGreaterThanOrEqual(1);
    });

    it('should only adjust first entry, not subsequent', () => {
      const queue = [{ layoutId: '100.xlf', duration: 60 }];
      const startedAt = new Date(NOW.getTime() - 20000);

      const timeline = calculateTimeline(queue, 0, {
        from: NOW, hours: 0.1,
        currentLayoutStartedAt: startedAt,
      });

      expect(timeline[0].duration).toBe(40);
      expect(timeline[1].duration).toBe(60); // Full duration
    });
  });

  describe('Time boundaries', () => {
    it('should not produce entries beyond the simulation window', () => {
      const queue = [{ layoutId: '100.xlf', duration: 30 }];

      const timeline = calculateTimeline(queue, 0, {
        from: NOW, hours: 1,
      });

      const endOfWindow = new Date(NOW.getTime() + 3600000);
      for (const entry of timeline) {
        expect(entry.startTime.getTime()).toBeLessThan(endOfWindow.getTime());
      }
    });

    it('should produce continuous timeline (no gaps between entries)', () => {
      const queue = [
        { layoutId: '100.xlf', duration: 30 },
        { layoutId: '200.xlf', duration: 45 },
      ];

      const timeline = calculateTimeline(queue, 0, {
        from: NOW, hours: 0.5,
      });

      for (let i = 1; i < timeline.length; i++) {
        expect(timeline[i].startTime.getTime()).toBe(timeline[i - 1].endTime.getTime());
      }
    });

    it('should handle a large number of entries without exceeding 500 cap', () => {
      const queue = [{ layoutId: '100.xlf', duration: 5 }]; // 5s = many entries

      const timeline = calculateTimeline(queue, 0, {
        from: NOW, hours: 2,
      });

      expect(timeline.length).toBeLessThanOrEqual(500);
    });
  });

  describe('Determinism', () => {
    it('should produce identical output for identical inputs', () => {
      const queue = [
        { layoutId: '100.xlf', duration: 30 },
        { layoutId: '200.xlf', duration: 45 },
      ];

      const t1 = calculateTimeline(queue, 0, { from: NOW, hours: 1 });
      const t2 = calculateTimeline(queue, 0, { from: NOW, hours: 1 });

      expect(t1.length).toBe(t2.length);
      for (let i = 0; i < t1.length; i++) {
        expect(t1[i].layoutFile).toBe(t2[i].layoutFile);
        expect(t1[i].startTime.getTime()).toBe(t2[i].startTime.getTime());
        expect(t1[i].endTime.getTime()).toBe(t2[i].endTime.getTime());
        expect(t1[i].duration).toBe(t2[i].duration);
      }
    });

    it('should produce DIFFERENT output when "from" time changes', () => {
      const queue = [{ layoutId: '100.xlf', duration: 30 }];

      const t1 = calculateTimeline(queue, 0, { from: NOW, hours: 1 });
      const laterNow = new Date(NOW.getTime() + 300000); // 5 min later
      const t2 = calculateTimeline(queue, 0, { from: laterNow, hours: 1 });

      // Start times must differ because the anchor moved
      expect(t1[0].startTime.getTime()).not.toBe(t2[0].startTime.getTime());
    });

    it('should produce DIFFERENT output when position changes', () => {
      const queue = [
        { layoutId: '100.xlf', duration: 30 },
        { layoutId: '200.xlf', duration: 30 },
      ];

      const t1 = calculateTimeline(queue, 0, { from: NOW, hours: 0.1 });
      const t2 = calculateTimeline(queue, 1, { from: NOW, hours: 0.1 });

      expect(t1[0].layoutFile).toBe('100.xlf');
      expect(t2[0].layoutFile).toBe('200.xlf');
    });
  });

  describe('Edge cases', () => {
    it('should return empty array for empty queue', () => {
      const timeline = calculateTimeline([], 0, { from: NOW, hours: 1 });
      expect(timeline).toEqual([]);
    });

    it('should return empty array for null queue', () => {
      const timeline = calculateTimeline(null, 0, { from: NOW, hours: 1 });
      expect(timeline).toEqual([]);
    });

    it('should handle mixed default and scheduled entries in queue', () => {
      const queue = [
        { layoutId: '100.xlf', duration: 30 },
        { layoutId: 'default.xlf', duration: 60 },
      ];

      const timeline = calculateTimeline(queue, 0, {
        from: NOW, hours: 0.1,
        defaultLayout: 'default.xlf',
      });

      expect(timeline[0].isDefault).toBe(false);
      expect(timeline[1].isDefault).toBe(true);
    });
  });
});

// ── parseLayoutDuration Tests ───────────────────────────────────

/** Helper to build minimal XLF strings */
function xlf({ duration = 0, regions = [] } = {}) {
  const regionXml = regions.map(r => {
    const type = r.type ? ` type="${r.type}"` : '';
    const widgets = (r.widgets || []).map(w => {
      const attrs = Object.entries(w).map(([k, v]) => `${k}="${v}"`).join(' ');
      return `<media ${attrs}/>`;
    }).join('');
    return `<region${type}>${widgets}</region>`;
  }).join('');
  return `<layout duration="${duration}">${regionXml}</layout>`;
}

describe('parseLayoutDuration', () => {
  describe('Basic duration parsing', () => {
    it('should return explicit layout duration when set', () => {
      const result = parseLayoutDuration(xlf({ duration: 120 }));
      expect(result).toEqual({ duration: 120, isDynamic: false });
    });

    it('should fallback to 60s when no layout element exists', () => {
      const result = parseLayoutDuration('<invalid/>');
      expect(result).toEqual({ duration: 60, isDynamic: false });
    });

    it('should calculate max region duration from widgets', () => {
      const result = parseLayoutDuration(xlf({
        regions: [
          { widgets: [
            { duration: 30, useDuration: 1 },
            { duration: 20, useDuration: 1 },
          ]},
          { widgets: [
            { duration: 10, useDuration: 1 },
          ]},
        ],
      }));
      // Region 1: 30+20=50, Region 2: 10 → max=50
      expect(result).toEqual({ duration: 50, isDynamic: false });
    });

    it('should estimate 60s for widgets with useDuration=0 and mark as dynamic', () => {
      const result = parseLayoutDuration(xlf({
        regions: [
          { widgets: [{ duration: 0, useDuration: 0, fileId: 'v1' }] },
        ],
      }));
      expect(result).toEqual({ duration: 60, isDynamic: true });
    });

    it('should fallback to 60s when all regions are empty', () => {
      const result = parseLayoutDuration(xlf({ regions: [{ widgets: [] }] }));
      expect(result).toEqual({ duration: 60, isDynamic: false });
    });
  });

  describe('Drawer region skip', () => {
    it('should skip drawer regions entirely', () => {
      const result = parseLayoutDuration(xlf({
        regions: [
          { widgets: [{ duration: 30, useDuration: 1 }] },
          { type: 'drawer', widgets: [{ duration: 300, useDuration: 1 }] },
        ],
      }));
      // Only the non-drawer region counts: 30s
      expect(result).toEqual({ duration: 30, isDynamic: false });
    });

    it('should fallback to 60s when only drawer regions exist', () => {
      const result = parseLayoutDuration(xlf({
        regions: [
          { type: 'drawer', widgets: [{ duration: 120, useDuration: 1 }] },
        ],
      }));
      expect(result).toEqual({ duration: 60, isDynamic: false });
    });
  });

  describe('Canvas region duration (#186)', () => {
    it('should use max widget duration for canvas regions (not sum)', () => {
      const result = parseLayoutDuration(xlf({
        regions: [
          { type: 'canvas', widgets: [
            { duration: 10, useDuration: 1 },
            { duration: 30, useDuration: 1 },
            { duration: 20, useDuration: 1 },
          ]},
        ],
      }));
      // Canvas: max(10, 30, 20) = 30, not sum(10+30+20) = 60
      expect(result).toEqual({ duration: 30, isDynamic: false });
    });

    it('should use sum for normal regions alongside canvas', () => {
      const result = parseLayoutDuration(xlf({
        regions: [
          { type: 'canvas', widgets: [
            { duration: 10, useDuration: 1 },
            { duration: 20, useDuration: 1 },
          ]},
          { widgets: [
            { duration: 15, useDuration: 1 },
            { duration: 25, useDuration: 1 },
          ]},
        ],
      }));
      // Canvas region: max(10, 20) = 20
      // Normal region: sum(15+25) = 40
      // Layout: max(20, 40) = 40
      expect(result).toEqual({ duration: 40, isDynamic: false });
    });
  });

  describe('videoDurations (Phase 2 probing)', () => {
    it('should use probed duration when fileId matches', () => {
      const videoDurations = new Map([['vid1', 45]]);
      const result = parseLayoutDuration(xlf({
        regions: [
          { widgets: [{ duration: 0, useDuration: 0, fileId: 'vid1' }] },
        ],
      }), videoDurations);
      expect(result).toEqual({ duration: 45, isDynamic: false });
    });

    it('should still estimate 60s for unmatched fileIds', () => {
      const videoDurations = new Map([['other', 45]]);
      const result = parseLayoutDuration(xlf({
        regions: [
          { widgets: [{ duration: 0, useDuration: 0, fileId: 'vid1' }] },
        ],
      }), videoDurations);
      expect(result).toEqual({ duration: 60, isDynamic: true });
    });

    it('should return same result when videoDurations has no matching fileIds', () => {
      const without = parseLayoutDuration(xlf({
        regions: [
          { widgets: [
            { duration: 30, useDuration: 1 },
            { duration: 0, useDuration: 0, fileId: 'vid1' },
          ]},
        ],
      }));
      const videoDurations = new Map([['no-match', 99]]);
      const withMap = parseLayoutDuration(xlf({
        regions: [
          { widgets: [
            { duration: 30, useDuration: 1 },
            { duration: 0, useDuration: 0, fileId: 'vid1' },
          ]},
        ],
      }), videoDurations);
      expect(withMap).toEqual(without);
    });

    it('should handle mixed: some probed, some static, some estimated', () => {
      const videoDurations = new Map([['vid1', 90]]);
      const result = parseLayoutDuration(xlf({
        regions: [
          { widgets: [
            { duration: 30, useDuration: 1 },           // Static: 30s
            { duration: 0, useDuration: 0, fileId: 'vid1' },  // Probed: 90s
            { duration: 0, useDuration: 0, fileId: 'vid2' },  // Estimated: 60s
          ]},
        ],
      }), videoDurations);
      // 30 + 90 + 60 = 180, isDynamic=true because vid2 is unprobed
      expect(result).toEqual({ duration: 180, isDynamic: true });
    });

    it('should not mark as dynamic when all videos are probed', () => {
      const videoDurations = new Map([['vid1', 45], ['vid2', 30]]);
      const result = parseLayoutDuration(xlf({
        regions: [
          { widgets: [
            { duration: 10, useDuration: 1 },
            { duration: 0, useDuration: 0, fileId: 'vid1' },
            { duration: 0, useDuration: 0, fileId: 'vid2' },
          ]},
        ],
      }), videoDurations);
      // 10 + 45 + 30 = 85, all resolved
      expect(result).toEqual({ duration: 85, isDynamic: false });
    });
  });
});
