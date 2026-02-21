/**
 * Tests for StatsCollector and formatStats
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StatsCollector, formatStats } from './stats-collector.js';

describe('StatsCollector', () => {
  let collector;

  beforeEach(async () => {
    collector = new StatsCollector();
    await collector.init();
    await collector.clearAllStats();
  });

  afterEach(async () => {
    if (collector && collector.db) {
      await collector.clearAllStats();
      collector.db.close();
    }
  });

  describe('constructor and initialization', () => {
    it('should create a new collector', () => {
      const c = new StatsCollector();
      expect(c).toBeDefined();
      expect(c.db).toBeNull();
      expect(c.inProgressStats).toBeInstanceOf(Map);
    });

    it('should initialize IndexedDB', async () => {
      const c = new StatsCollector();
      await c.init();
      expect(c.db).toBeDefined();
      expect(c.db.name).toBe('xibo-player-stats');
      c.db.close();
    });

    it('should be idempotent (safe to call init multiple times)', async () => {
      await collector.init();
      await collector.init();
      expect(collector.db).toBeDefined();
    });

    it('should handle missing IndexedDB gracefully', async () => {
      const originalIndexedDB = global.indexedDB;
      global.indexedDB = undefined;

      const c = new StatsCollector();
      await expect(c.init()).rejects.toThrow('IndexedDB not available');

      global.indexedDB = originalIndexedDB;
    });
  });

  describe('layout tracking', () => {
    it('should start tracking a layout', async () => {
      await collector.startLayout(123, 456);

      const key = 'layout-123';
      expect(collector.inProgressStats.has(key)).toBe(true);

      const stat = collector.inProgressStats.get(key);
      expect(stat.type).toBe('layout');
      expect(stat.layoutId).toBe(123);
      expect(stat.scheduleId).toBe(456);
      expect(stat.start).toBeInstanceOf(Date);
      expect(stat.end).toBeNull();
      expect(stat.count).toBe(1);
      expect(stat.submitted).toBe(0);
    });

    it('should warn on duplicate start', async () => {
      await collector.startLayout(123, 456);
      await collector.startLayout(123, 456);

      // Should still have only one entry
      expect(collector.inProgressStats.size).toBe(1);
    });

    it('should end tracking a layout', async () => {
      await collector.startLayout(123, 456);

      // Wait a bit to ensure duration > 0
      await new Promise(resolve => setTimeout(resolve, 100));

      await collector.endLayout(123, 456);

      // Should be removed from in-progress
      const key = 'layout-123';
      expect(collector.inProgressStats.has(key)).toBe(false);

      // Should be saved to database
      const stats = await collector.getAllStats();
      expect(stats.length).toBe(1);
      expect(stats[0].type).toBe('layout');
      expect(stats[0].layoutId).toBe(123);
      expect(stats[0].scheduleId).toBe(456);
      expect(stats[0].duration).toBeGreaterThanOrEqual(0); // Allow 0 for fast execution
      expect(stats[0].end).toBeInstanceOf(Date);
    });

    it('should handle end without start', async () => {
      // Should not throw
      await collector.endLayout(999, 888);

      const stats = await collector.getAllStats();
      expect(stats.length).toBe(0);
    });

    it('should calculate duration correctly', async () => {
      await collector.startLayout(123, 456);

      // Wait 1 second
      await new Promise(resolve => setTimeout(resolve, 1000));

      await collector.endLayout(123, 456);

      const stats = await collector.getAllStats();
      expect(stats[0].duration).toBeGreaterThanOrEqual(1);
      expect(stats[0].duration).toBeLessThan(2);
    });

    it('should track multiple layouts simultaneously', async () => {
      await collector.startLayout(123, 456);
      await collector.startLayout(789, 456);

      expect(collector.inProgressStats.size).toBe(2);

      await collector.endLayout(123, 456);
      expect(collector.inProgressStats.size).toBe(1);

      await collector.endLayout(789, 456);
      expect(collector.inProgressStats.size).toBe(0);

      const stats = await collector.getAllStats();
      expect(stats.length).toBe(2);
    });
  });

  describe('widget tracking', () => {
    it('should start tracking a widget', async () => {
      await collector.startWidget(111, 123, 456);

      const key = 'media-111-123';
      expect(collector.inProgressStats.has(key)).toBe(true);

      const stat = collector.inProgressStats.get(key);
      expect(stat.type).toBe('media');
      expect(stat.mediaId).toBe(111);
      expect(stat.layoutId).toBe(123);
      expect(stat.scheduleId).toBe(456);
      expect(stat.start).toBeInstanceOf(Date);
      expect(stat.end).toBeNull();
    });

    it('should end tracking a widget', async () => {
      await collector.startWidget(111, 123, 456);

      await new Promise(resolve => setTimeout(resolve, 100));

      await collector.endWidget(111, 123, 456);

      const key = 'media-111-123';
      expect(collector.inProgressStats.has(key)).toBe(false);

      const stats = await collector.getAllStats();
      expect(stats.length).toBe(1);
      expect(stats[0].type).toBe('media');
      expect(stats[0].mediaId).toBe(111);
      expect(stats[0].duration).toBeGreaterThanOrEqual(0); // Allow 0 for fast execution
    });

    it('should handle multiple widgets in same layout', async () => {
      await collector.startWidget(111, 123, 456);
      await collector.startWidget(222, 123, 456);
      await collector.startWidget(333, 123, 456);

      expect(collector.inProgressStats.size).toBe(3);

      await collector.endWidget(111, 123, 456);
      await collector.endWidget(222, 123, 456);
      await collector.endWidget(333, 123, 456);

      const stats = await collector.getAllStats();
      expect(stats.length).toBe(3);
      expect(stats.every(s => s.type === 'media')).toBe(true);
    });
  });

  describe('event tracking', () => {
    it('should record an event stat', async () => {
      await collector.recordEvent('touch', 123, 456, 789);

      const stats = await collector.getAllStats();
      expect(stats.length).toBe(1);
      expect(stats[0].type).toBe('event');
      expect(stats[0].tag).toBe('touch');
      expect(stats[0].layoutId).toBe(123);
      expect(stats[0].widgetId).toBe(456);
      expect(stats[0].scheduleId).toBe(789);
      expect(stats[0].duration).toBe(0);
      expect(stats[0].count).toBe(1);
      expect(stats[0].submitted).toBe(0);
      expect(stats[0].start).toBeInstanceOf(Date);
      expect(stats[0].end).toBeInstanceOf(Date);
    });

    it('should record multiple events', async () => {
      await collector.recordEvent('touch', 123, 456, 789);
      await collector.recordEvent('webhook', 123, 456, 789);
      await collector.recordEvent('touch', 123, 457, 789);

      const stats = await collector.getAllStats();
      expect(stats.length).toBe(3);
      expect(stats.every(s => s.type === 'event')).toBe(true);
    });

    it('should not store event in inProgressStats', async () => {
      await collector.recordEvent('touch', 123, 456, 789);

      expect(collector.inProgressStats.size).toBe(0);
    });

    it('should be retrievable for submission', async () => {
      await collector.recordEvent('touch', 123, 456, 789);

      const stats = await collector.getStatsForSubmission();
      expect(stats.length).toBe(1);
      expect(stats[0].type).toBe('event');
      expect(stats[0].tag).toBe('touch');
    });

    it('should handle missing db gracefully', async () => {
      const c = new StatsCollector();
      // Should not throw
      await c.recordEvent('touch', 123, 456, 789);
    });

    it('should coexist with layout and widget stats', async () => {
      await collector.startLayout(123, 789);
      await collector.endLayout(123, 789);
      await collector.startWidget(111, 123, 789);
      await collector.endWidget(111, 123, 789);
      await collector.recordEvent('touch', 123, 456, 789);

      const stats = await collector.getAllStats();
      expect(stats.length).toBe(3);
      expect(stats.some(s => s.type === 'layout')).toBe(true);
      expect(stats.some(s => s.type === 'media')).toBe(true);
      expect(stats.some(s => s.type === 'event')).toBe(true);
    });
  });

  describe('stats submission flow', () => {
    it('should get unsubmitted stats', async () => {
      // Create some stats
      await collector.startLayout(123, 456);
      await collector.endLayout(123, 456);

      await collector.startLayout(789, 456);
      await collector.endLayout(789, 456);

      const stats = await collector.getStatsForSubmission();
      expect(stats.length).toBe(2);
      expect(stats.every(s => s.submitted === 0)).toBe(true);
    });

    it('should respect limit parameter', async () => {
      // Create 5 stats
      for (let i = 0; i < 5; i++) {
        await collector.startLayout(100 + i, 456);
        await collector.endLayout(100 + i, 456);
      }

      const stats = await collector.getStatsForSubmission(3);
      expect(stats.length).toBe(3);
    });

    it('should return empty array when no unsubmitted stats', async () => {
      const stats = await collector.getStatsForSubmission();
      expect(stats).toEqual([]);
    });

    it('should clear submitted stats', async () => {
      // Create stats
      await collector.startLayout(123, 456);
      await collector.endLayout(123, 456);

      await collector.startLayout(789, 456);
      await collector.endLayout(789, 456);

      // Get stats
      const stats = await collector.getStatsForSubmission();
      expect(stats.length).toBe(2);

      // Clear them
      await collector.clearSubmittedStats(stats);

      // Verify they're gone
      const remaining = await collector.getAllStats();
      expect(remaining.length).toBe(0);
    });

    it('should handle clearing empty array', async () => {
      await collector.clearSubmittedStats([]);
      // Should not throw
    });

    it('should handle clearing null', async () => {
      await collector.clearSubmittedStats(null);
      // Should not throw
    });
  });

  describe('edge cases', () => {
    it('should handle operations without initialization', async () => {
      const c = new StatsCollector();

      // Should not throw, but should log warnings
      await c.startLayout(123, 456);
      await c.endLayout(123, 456);
      await c.startWidget(111, 123, 456);
      await c.endWidget(111, 123, 456);

      const stats = await c.getStatsForSubmission();
      expect(stats).toEqual([]);
    });

    it('should handle interrupted playback', async () => {
      // Start layout but never end it
      await collector.startLayout(123, 456);

      // Create a new collector (simulating app restart)
      const newCollector = new StatsCollector();
      await newCollector.init();

      // Should still be able to track new stats
      await newCollector.startLayout(789, 456);
      await newCollector.endLayout(789, 456);

      const stats = await newCollector.getAllStats();
      expect(stats.length).toBe(1);
      expect(stats[0].layoutId).toBe(789);

      newCollector.db.close();
    });

    it('should handle invalid stat IDs in clearSubmittedStats', async () => {
      const invalidStats = [
        { id: null, layoutId: 123 },
        { id: undefined, layoutId: 456 },
        { layoutId: 789 } // No id property
      ];

      // Should not throw
      await collector.clearSubmittedStats(invalidStats);
    });
  });

  describe('database operations', () => {
    it('should get all stats', async () => {
      // Create mixed stats
      await collector.startLayout(123, 456);
      await collector.endLayout(123, 456);

      await collector.startWidget(111, 123, 456);
      await collector.endWidget(111, 123, 456);

      const stats = await collector.getAllStats();
      expect(stats.length).toBe(2);
      expect(stats.some(s => s.type === 'layout')).toBe(true);
      expect(stats.some(s => s.type === 'media')).toBe(true);
    });

    it('should clear all stats', async () => {
      // Create stats
      await collector.startLayout(123, 456);
      await collector.endLayout(123, 456);

      await collector.startWidget(111, 123, 456);
      await collector.endWidget(111, 123, 456);

      await collector.clearAllStats();

      const stats = await collector.getAllStats();
      expect(stats.length).toBe(0);
      expect(collector.inProgressStats.size).toBe(0);
    });
  });
});

describe('formatStats', () => {
  it('should format empty stats', () => {
    const xml = formatStats([]);
    expect(xml).toBe('<stats></stats>');
  });

  it('should format null stats', () => {
    const xml = formatStats(null);
    expect(xml).toBe('<stats></stats>');
  });

  it('should format layout stat', () => {
    const stats = [{
      type: 'layout',
      layoutId: 123,
      scheduleId: 456,
      start: new Date('2026-02-10T12:00:00Z'),
      end: new Date('2026-02-10T12:05:00Z'),
      duration: 300,
      count: 1
    }];

    const xml = formatStats(stats);
    expect(xml).toContain('<stats>');
    expect(xml).toContain('</stats>');
    expect(xml).toContain('type="layout"');
    expect(xml).toContain('layoutid="123"');
    expect(xml).toContain('scheduleid="456"');
    expect(xml).toContain('duration="300"');
    expect(xml).toContain('count="1"');
    expect(xml).toContain('fromdt=');
    expect(xml).toContain('todt=');
  });

  it('should format media stat', () => {
    const stats = [{
      type: 'media',
      mediaId: 789,
      layoutId: 123,
      scheduleId: 456,
      start: new Date('2026-02-10T12:00:00Z'),
      end: new Date('2026-02-10T12:01:00Z'),
      duration: 60,
      count: 1
    }];

    const xml = formatStats(stats);
    expect(xml).toContain('type="media"');
    expect(xml).toContain('mediaid="789"');
    expect(xml).toContain('layoutid="123"');
    expect(xml).toContain('duration="60"');
  });

  it('should format multiple stats', () => {
    const stats = [
      {
        type: 'layout',
        layoutId: 123,
        scheduleId: 456,
        start: new Date('2026-02-10T12:00:00Z'),
        end: new Date('2026-02-10T12:05:00Z'),
        duration: 300,
        count: 1
      },
      {
        type: 'media',
        mediaId: 789,
        layoutId: 123,
        scheduleId: 456,
        start: new Date('2026-02-10T12:00:00Z'),
        end: new Date('2026-02-10T12:01:00Z'),
        duration: 60,
        count: 1
      }
    ];

    const xml = formatStats(stats);
    const statCount = (xml.match(/<stat /g) || []).length;
    expect(statCount).toBe(2);
  });

  it('should escape XML special characters', () => {
    const stats = [{
      type: 'layout',
      layoutId: 123,
      scheduleId: 456,
      start: new Date('2026-02-10T12:00:00Z'),
      end: new Date('2026-02-10T12:00:00Z'),
      duration: 0,
      count: 1
    }];

    const xml = formatStats(stats);
    // Should not contain unescaped characters
    expect(xml).not.toContain('&amp;amp;');
    expect(xml).not.toContain('&lt;lt;');
  });

  it('should format dates correctly', () => {
    const stats = [{
      type: 'layout',
      layoutId: 123,
      scheduleId: 456,
      start: new Date('2026-02-10T12:34:56Z'),
      end: new Date('2026-02-10T12:35:56Z'),
      duration: 60,
      count: 1
    }];

    const xml = formatStats(stats);
    // Should contain date in YYYY-MM-DD HH:MM:SS format
    expect(xml).toMatch(/fromdt="\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}"/);
    expect(xml).toMatch(/todt="\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}"/);
  });

  it('should format event stat', () => {
    const stats = [{
      type: 'event',
      tag: 'touch',
      layoutId: 123,
      widgetId: 456,
      scheduleId: 789,
      start: new Date('2026-02-10T12:00:00Z'),
      end: new Date('2026-02-10T12:00:00Z'),
      duration: 0,
      count: 1
    }];

    const xml = formatStats(stats);
    expect(xml).toContain('type="event"');
    expect(xml).toContain('tag="touch"');
    expect(xml).toContain('widgetid="456"');
    expect(xml).toContain('layoutid="123"');
    expect(xml).toContain('scheduleid="789"');
    expect(xml).toContain('duration="0"');
  });

  it('should escape XML in event tag', () => {
    const stats = [{
      type: 'event',
      tag: 'touch&click<script>',
      layoutId: 123,
      widgetId: 456,
      scheduleId: 789,
      start: new Date('2026-02-10T12:00:00Z'),
      end: new Date('2026-02-10T12:00:00Z'),
      duration: 0,
      count: 1
    }];

    const xml = formatStats(stats);
    expect(xml).toContain('tag="touch&amp;click&lt;script&gt;"');
  });

  it('should handle missing end date', () => {
    const stats = [{
      type: 'layout',
      layoutId: 123,
      scheduleId: 456,
      start: new Date('2026-02-10T12:00:00Z'),
      end: null,
      duration: 0,
      count: 1
    }];

    const xml = formatStats(stats);
    // Should use start date for both fromdt and todt
    expect(xml).toContain('fromdt=');
    expect(xml).toContain('todt=');
  });

  it('should include widgetId for media stats with no mediaId (native widgets)', () => {
    const stats = [{
      type: 'media',
      mediaId: null,
      widgetId: 42,
      layoutId: 123,
      scheduleId: 456,
      start: new Date('2026-02-10T12:00:00Z'),
      end: new Date('2026-02-10T12:01:00Z'),
      duration: 60,
      count: 1
    }];

    const xml = formatStats(stats);
    expect(xml).toContain('type="media"');
    expect(xml).toContain('widgetid="42"');
    expect(xml).not.toContain('mediaid=');
  });

  it('should include both mediaid and widgetid for library widgets', () => {
    const stats = [{
      type: 'media',
      mediaId: 789,
      widgetId: 42,
      layoutId: 123,
      scheduleId: 456,
      start: new Date('2026-02-10T12:00:00Z'),
      end: new Date('2026-02-10T12:01:00Z'),
      duration: 60,
      count: 1
    }];

    const xml = formatStats(stats);
    expect(xml).toContain('mediaid="789"');
    expect(xml).toContain('widgetid="42"');
  });
});

describe('_splitAtHourBoundaries', () => {
  let collector;

  beforeEach(async () => {
    collector = new StatsCollector();
    await collector.init();
  });

  afterEach(() => {
    if (collector?.db) collector.db.close();
  });

  it('should not split a stat within the same hour', () => {
    const stat = {
      type: 'layout', layoutId: 1, scheduleId: 1, count: 1, submitted: 0,
      start: new Date('2026-02-10T12:10:00Z'),
      end: new Date('2026-02-10T12:50:00Z'),
      duration: 2400
    };
    const parts = collector._splitAtHourBoundaries(stat);
    expect(parts).toHaveLength(1);
    expect(parts[0].duration).toBe(2400);
  });

  it('should split a stat spanning two hours', () => {
    const stat = {
      type: 'layout', layoutId: 1, scheduleId: 1, count: 1, submitted: 0,
      start: new Date('2026-02-10T12:50:00Z'),
      end: new Date('2026-02-10T13:10:00Z'),
      duration: 1200
    };
    const parts = collector._splitAtHourBoundaries(stat);
    expect(parts).toHaveLength(2);
    expect(parts[0].duration).toBe(600);  // 12:50 → 13:00
    expect(parts[1].duration).toBe(600);  // 13:00 → 13:10
    expect(parts[0].end.toISOString()).toBe('2026-02-10T13:00:00.000Z');
    expect(parts[1].start.toISOString()).toBe('2026-02-10T13:00:00.000Z');
  });

  it('should split a stat spanning three hours', () => {
    const stat = {
      type: 'layout', layoutId: 1, scheduleId: 1, count: 1, submitted: 0,
      start: new Date('2026-02-10T11:30:00Z'),
      end: new Date('2026-02-10T13:15:00Z'),
      duration: 6300
    };
    const parts = collector._splitAtHourBoundaries(stat);
    expect(parts).toHaveLength(3);
    expect(parts[0].duration).toBe(1800); // 11:30 → 12:00
    expect(parts[1].duration).toBe(3600); // 12:00 → 13:00
    expect(parts[2].duration).toBe(900);  // 13:00 → 13:15
    // Durations sum to original
    const total = parts.reduce((s, p) => s + p.duration, 0);
    expect(total).toBe(6300);
  });

  it('should split at day boundary (midnight)', () => {
    const stat = {
      type: 'layout', layoutId: 1, scheduleId: 1, count: 1, submitted: 0,
      start: new Date('2026-02-10T23:50:00Z'),
      end: new Date('2026-02-11T00:10:00Z'),
      duration: 1200
    };
    const parts = collector._splitAtHourBoundaries(stat);
    expect(parts).toHaveLength(2);
    expect(parts[0].duration).toBe(600);
    expect(parts[1].duration).toBe(600);
  });

  it('should preserve all stat fields in split records', () => {
    const stat = {
      type: 'media', layoutId: 5, mediaId: 42, scheduleId: 7, count: 1, submitted: 0,
      start: new Date('2026-02-10T12:50:00Z'),
      end: new Date('2026-02-10T13:10:00Z'),
      duration: 1200
    };
    const parts = collector._splitAtHourBoundaries(stat);
    for (const part of parts) {
      expect(part.type).toBe('media');
      expect(part.layoutId).toBe(5);
      expect(part.mediaId).toBe(42);
      expect(part.scheduleId).toBe(7);
      expect(part.count).toBe(1);
      expect(part.submitted).toBe(0);
    }
  });
});
