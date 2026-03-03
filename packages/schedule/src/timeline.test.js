/**
 * Timeline Calculator Tests
 *
 * Tests for calculateTimeline() — the pure simulation function that produces
 * deterministic playback predictions from schedule + durations.
 */

import { describe, it, expect } from 'vitest';
import { calculateTimeline, parseLayoutDuration } from './timeline.js';

// ── Helpers ──────────────────────────────────────────────────────

/** Create a mock schedule with getAllLayoutsAtTime() support */
function createMockSchedule({ layouts = [], defaultLayout = null, playHistory = null } = {}) {
  return {
    schedule: { default: defaultLayout },
    playHistory: playHistory || new Map(),
    getAllLayoutsAtTime(time) {
      const t = time.getTime();
      return layouts.filter(l => {
        const from = new Date(l.fromdt).getTime();
        const to = new Date(l.todt).getTime();
        return t >= from && t < to;
      });
    },
    getLayoutsAtTime(time) {
      return this.getAllLayoutsAtTime(time).map(l => l.file);
    },
  };
}

function hoursFromNow(h) {
  return new Date(Date.now() + h * 3600000).toISOString();
}

// Fixed "now" for deterministic tests
const NOW = new Date('2026-03-03T10:00:00Z');

function fixedDate(isoTime) {
  return new Date(isoTime);
}

// ── Tests ────────────────────────────────────────────────────────

describe('calculateTimeline', () => {
  describe('Basic scheduling', () => {
    it('should produce entries for a single scheduled layout', () => {
      const schedule = createMockSchedule({
        layouts: [{
          file: '100.xlf', priority: 10, maxPlaysPerHour: 0,
          fromdt: '2026-03-03T09:00:00Z', todt: '2026-03-03T12:00:00Z',
        }],
      });
      const durations = new Map([['100.xlf', 30]]);

      const timeline = calculateTimeline(schedule, durations, {
        from: NOW, hours: 1,
      });

      expect(timeline.length).toBeGreaterThan(0);
      expect(timeline[0].layoutFile).toBe('100.xlf');
      expect(timeline[0].duration).toBe(30);
      expect(timeline[0].isDefault).toBe(false);
    });

    it('should use default layout when no scheduled layouts exist', () => {
      const schedule = createMockSchedule({
        layouts: [],
        defaultLayout: 'default.xlf',
      });
      const durations = new Map([['default.xlf', 45]]);

      const timeline = calculateTimeline(schedule, durations, {
        from: NOW, hours: 0.1,
      });

      expect(timeline.length).toBeGreaterThan(0);
      expect(timeline[0].layoutFile).toBe('default.xlf');
      expect(timeline[0].isDefault).toBe(true);
      expect(timeline[0].duration).toBe(45);
    });

    it('should use fallback duration when layout not in durations map', () => {
      const schedule = createMockSchedule({
        layouts: [{
          file: '100.xlf', priority: 10, maxPlaysPerHour: 0,
          fromdt: '2026-03-03T09:00:00Z', todt: '2026-03-03T12:00:00Z',
        }],
      });
      const durations = new Map(); // No durations known

      const timeline = calculateTimeline(schedule, durations, {
        from: NOW, hours: 0.1, defaultDuration: 42,
      });

      expect(timeline[0].duration).toBe(42);
    });

    it('should round-robin multiple layouts at same priority', () => {
      const schedule = createMockSchedule({
        layouts: [
          { file: '100.xlf', priority: 10, maxPlaysPerHour: 0,
            fromdt: '2026-03-03T09:00:00Z', todt: '2026-03-03T12:00:00Z' },
          { file: '200.xlf', priority: 10, maxPlaysPerHour: 0,
            fromdt: '2026-03-03T09:00:00Z', todt: '2026-03-03T12:00:00Z' },
        ],
      });
      const durations = new Map([['100.xlf', 30], ['200.xlf', 30]]);

      const timeline = calculateTimeline(schedule, durations, {
        from: NOW, hours: 0.1,
      });

      // Both layouts should appear in the timeline
      const files = timeline.map(e => e.layoutFile);
      expect(files).toContain('100.xlf');
      expect(files).toContain('200.xlf');
    });
  });

  describe('Priority handling', () => {
    it('should play higher priority layout over lower priority', () => {
      const schedule = createMockSchedule({
        layouts: [
          { file: 'low.xlf', priority: 5, maxPlaysPerHour: 0,
            fromdt: '2026-03-03T09:00:00Z', todt: '2026-03-03T12:00:00Z' },
          { file: 'high.xlf', priority: 10, maxPlaysPerHour: 0,
            fromdt: '2026-03-03T09:00:00Z', todt: '2026-03-03T12:00:00Z' },
        ],
      });
      const durations = new Map([['low.xlf', 30], ['high.xlf', 30]]);

      const timeline = calculateTimeline(schedule, durations, {
        from: NOW, hours: 0.5,
      });

      // All entries should be high priority
      const uniqueFiles = [...new Set(timeline.map(e => e.layoutFile))];
      expect(uniqueFiles).toEqual(['high.xlf']);
    });

    it('should annotate hidden (overshadowed) layouts', () => {
      const schedule = createMockSchedule({
        layouts: [
          { file: 'low.xlf', priority: 5, maxPlaysPerHour: 0,
            fromdt: '2026-03-03T09:00:00Z', todt: '2026-03-03T12:00:00Z' },
          { file: 'high.xlf', priority: 10, maxPlaysPerHour: 0,
            fromdt: '2026-03-03T09:00:00Z', todt: '2026-03-03T12:00:00Z' },
        ],
      });
      const durations = new Map([['low.xlf', 30], ['high.xlf', 30]]);

      const timeline = calculateTimeline(schedule, durations, {
        from: NOW, hours: 0.1,
      });

      // First entry should have hidden layouts
      expect(timeline[0].hidden).toBeDefined();
      expect(timeline[0].hidden).toEqual(
        expect.arrayContaining([expect.objectContaining({ file: 'low.xlf' })])
      );
    });
  });

  describe('Rate limiting (maxPlaysPerHour)', () => {
    it('should respect maxPlaysPerHour by falling back to lower priority', () => {
      const schedule = createMockSchedule({
        layouts: [
          { file: 'limited.xlf', priority: 10, maxPlaysPerHour: 2,
            fromdt: '2026-03-03T09:00:00Z', todt: '2026-03-03T12:00:00Z' },
          { file: 'filler.xlf', priority: 5, maxPlaysPerHour: 0,
            fromdt: '2026-03-03T09:00:00Z', todt: '2026-03-03T12:00:00Z' },
        ],
      });
      const durations = new Map([['limited.xlf', 30], ['filler.xlf', 30]]);

      const timeline = calculateTimeline(schedule, durations, {
        from: NOW, hours: 1,
      });

      // limited.xlf should appear at most 2 times in the hour
      const limitedPlays = timeline.filter(e => e.layoutFile === 'limited.xlf');
      expect(limitedPlays.length).toBeLessThanOrEqual(2);

      // filler.xlf should fill the gaps
      const fillerPlays = timeline.filter(e => e.layoutFile === 'filler.xlf');
      expect(fillerPlays.length).toBeGreaterThan(0);
    });

    it('should fall back to default when all layouts are rate-limited', () => {
      const schedule = createMockSchedule({
        layouts: [
          { file: 'limited.xlf', priority: 10, maxPlaysPerHour: 1,
            fromdt: '2026-03-03T09:00:00Z', todt: '2026-03-03T12:00:00Z' },
        ],
        defaultLayout: 'default.xlf',
      });
      const durations = new Map([['limited.xlf', 30], ['default.xlf', 30]]);

      const timeline = calculateTimeline(schedule, durations, {
        from: NOW, hours: 1,
      });

      // Should have both limited and default layouts
      const files = [...new Set(timeline.map(e => e.layoutFile))];
      expect(files).toContain('limited.xlf');
      expect(files).toContain('default.xlf');

      // limited.xlf at most once per hour
      const limitedPlays = timeline.filter(e => e.layoutFile === 'limited.xlf');
      expect(limitedPlays.length).toBeLessThanOrEqual(1);
    });
  });

  describe('Time boundaries', () => {
    it('should stop at schedule end time', () => {
      const schedule = createMockSchedule({
        layouts: [{
          file: '100.xlf', priority: 10, maxPlaysPerHour: 0,
          fromdt: '2026-03-03T10:00:00Z', todt: '2026-03-03T10:30:00Z',
        }],
        defaultLayout: 'default.xlf',
      });
      const durations = new Map([['100.xlf', 60], ['default.xlf', 60]]);

      const timeline = calculateTimeline(schedule, durations, {
        from: NOW, hours: 1,
      });

      // After 10:30, should switch to default
      const afterEnd = timeline.filter(e =>
        e.startTime >= new Date('2026-03-03T10:30:00Z')
      );
      for (const entry of afterEnd) {
        expect(entry.layoutFile).toBe('default.xlf');
      }
    });

    it('should not produce entries beyond the simulation window', () => {
      const schedule = createMockSchedule({
        layouts: [{
          file: '100.xlf', priority: 10, maxPlaysPerHour: 0,
          fromdt: '2026-03-03T09:00:00Z', todt: '2026-03-03T14:00:00Z',
        }],
      });
      const durations = new Map([['100.xlf', 30]]);

      const timeline = calculateTimeline(schedule, durations, {
        from: NOW, hours: 1,
      });

      const endOfWindow = new Date(NOW.getTime() + 3600000);
      for (const entry of timeline) {
        expect(entry.startTime.getTime()).toBeLessThan(endOfWindow.getTime());
      }
    });
  });

  describe('currentLayoutStartedAt (remaining time adjustment)', () => {
    it('should adjust first entry duration to remaining time', () => {
      const schedule = createMockSchedule({
        layouts: [{
          file: '100.xlf', priority: 10, maxPlaysPerHour: 0,
          fromdt: '2026-03-03T09:00:00Z', todt: '2026-03-03T12:00:00Z',
        }],
      });
      const durations = new Map([['100.xlf', 60]]);

      // Layout started 20 seconds ago → 40 seconds remaining
      const startedAt = new Date(NOW.getTime() - 20000);

      const timeline = calculateTimeline(schedule, durations, {
        from: NOW, hours: 0.5,
        currentLayoutStartedAt: startedAt,
      });

      expect(timeline[0].duration).toBe(40); // 60 - 20 = 40
    });

    it('should clamp remaining time to at least 1 second', () => {
      const schedule = createMockSchedule({
        layouts: [{
          file: '100.xlf', priority: 10, maxPlaysPerHour: 0,
          fromdt: '2026-03-03T09:00:00Z', todt: '2026-03-03T12:00:00Z',
        }],
      });
      const durations = new Map([['100.xlf', 30]]);

      // Layout started 60 seconds ago but duration is only 30 → already overdue
      const startedAt = new Date(NOW.getTime() - 60000);

      const timeline = calculateTimeline(schedule, durations, {
        from: NOW, hours: 0.1,
        currentLayoutStartedAt: startedAt,
      });

      expect(timeline[0].duration).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Determinism', () => {
    it('should produce identical output for identical inputs', () => {
      const schedule = createMockSchedule({
        layouts: [
          { file: '100.xlf', priority: 10, maxPlaysPerHour: 0,
            fromdt: '2026-03-03T09:00:00Z', todt: '2026-03-03T12:00:00Z' },
          { file: '200.xlf', priority: 10, maxPlaysPerHour: 0,
            fromdt: '2026-03-03T09:00:00Z', todt: '2026-03-03T12:00:00Z' },
        ],
      });
      const durations = new Map([['100.xlf', 30], ['200.xlf', 45]]);

      const t1 = calculateTimeline(schedule, durations, { from: NOW, hours: 1 });
      const t2 = calculateTimeline(schedule, durations, { from: NOW, hours: 1 });

      expect(t1.length).toBe(t2.length);
      for (let i = 0; i < t1.length; i++) {
        expect(t1[i].layoutFile).toBe(t2[i].layoutFile);
        expect(t1[i].startTime.getTime()).toBe(t2[i].startTime.getTime());
        expect(t1[i].endTime.getTime()).toBe(t2[i].endTime.getTime());
        expect(t1[i].duration).toBe(t2[i].duration);
      }
    });

    it('should produce DIFFERENT output when "from" time changes', () => {
      const schedule = createMockSchedule({
        layouts: [{
          file: '100.xlf', priority: 10, maxPlaysPerHour: 0,
          fromdt: '2026-03-03T09:00:00Z', todt: '2026-03-03T12:00:00Z',
        }],
      });
      const durations = new Map([['100.xlf', 30]]);

      const t1 = calculateTimeline(schedule, durations, { from: NOW, hours: 1 });
      const laterNow = new Date(NOW.getTime() + 300000); // 5 min later
      const t2 = calculateTimeline(schedule, durations, { from: laterNow, hours: 1 });

      // Start times must differ because the anchor moved
      expect(t1[0].startTime.getTime()).not.toBe(t2[0].startTime.getTime());
    });
  });

  describe('Edge cases', () => {
    it('should return empty array when no layouts and no default', () => {
      const schedule = createMockSchedule({ layouts: [], defaultLayout: null });
      const durations = new Map();

      const timeline = calculateTimeline(schedule, durations, {
        from: NOW, hours: 1,
      });

      expect(timeline).toEqual([]);
    });

    it('should handle a large number of entries without exceeding 500 cap', () => {
      const schedule = createMockSchedule({
        layouts: [{
          file: '100.xlf', priority: 10, maxPlaysPerHour: 0,
          fromdt: '2026-03-03T09:00:00Z', todt: '2026-03-03T20:00:00Z',
        }],
      });
      const durations = new Map([['100.xlf', 5]]); // 5s = many entries

      const timeline = calculateTimeline(schedule, durations, {
        from: NOW, hours: 2,
      });

      expect(timeline.length).toBeLessThanOrEqual(500);
    });

    it('should produce continuous timeline (no gaps between entries)', () => {
      const schedule = createMockSchedule({
        layouts: [{
          file: '100.xlf', priority: 10, maxPlaysPerHour: 0,
          fromdt: '2026-03-03T09:00:00Z', todt: '2026-03-03T12:00:00Z',
        }],
      });
      const durations = new Map([['100.xlf', 30]]);

      const timeline = calculateTimeline(schedule, durations, {
        from: NOW, hours: 0.5,
      });

      for (let i = 1; i < timeline.length; i++) {
        expect(timeline[i].startTime.getTime()).toBe(timeline[i - 1].endTime.getTime());
      }
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
