// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Rate-limit + default-layout interleave behaviour.
 *
 * Documents the contract between `ScheduleManager._getLayoutsAt()` and
 * the queue built by `buildScheduleQueue()` when some or all scheduled
 * layouts hit `maxPlaysPerHour`.
 *
 * Current contract (what these tests lock in as regression guards):
 *
 *   Live path (`getCurrentLayouts()`):
 *     - ALL rate-limited  → default layout returned
 *     - SOME rate-limited → surviving layout(s) returned, default NOT
 *                           interleaved in the immediate answer
 *     - NO default + all rate-limited → empty array
 *
 *   Pre-computed queue (`buildScheduleQueue()`):
 *     - Interleaves the default layout at each tick where no layout is
 *       playable due to rate limits, until one becomes playable again
 *
 * Refs #357 (field-reported "stuck on one ad" when rate-limit rotation
 * collapses). If the live-path semantics change — e.g. to interleave
 * default between surviving layouts in the 2-of-3 case — these tests
 * should be updated with explicit rationale, not silently relaxed.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ScheduleManager } from './schedule.js';
import { buildScheduleQueue } from './timeline.js';

describe('maxPlaysPerHour + default-layout interleave', () => {
  let sm;

  beforeEach(() => {
    sm = new ScheduleManager();
  });

  // Build three rate-limited layouts + a default layout.
  // All windows are wide-open (2026-01-01 → 2027-01-01) and unconditional.
  const makeSchedule = ({ withDefault = true } = {}) => ({
    default: withDefault ? '0' : null,
    layouts: [
      { id: '100', file: '100', priority: 5, scheduleid: '1',
        maxPlaysPerHour: 2, isGeoAware: false, geoLocation: '',
        criteria: [], fromdt: '2026-01-01 00:00:00', todt: '2027-01-01 00:00:00' },
      { id: '200', file: '200', priority: 5, scheduleid: '2',
        maxPlaysPerHour: 2, isGeoAware: false, geoLocation: '',
        criteria: [], fromdt: '2026-01-01 00:00:00', todt: '2027-01-01 00:00:00' },
      { id: '300', file: '300', priority: 5, scheduleid: '3',
        maxPlaysPerHour: 2, isGeoAware: false, geoLocation: '',
        criteria: [], fromdt: '2026-01-01 00:00:00', todt: '2027-01-01 00:00:00' }
    ],
    campaigns: []
  });

  // Saturate a layout's play history so `canPlayLayout` returns false.
  // Uses real `recordPlay` so the sliding-window logic is exercised, not
  // mocked around.
  const saturate = (layoutId, maxPlaysPerHour) => {
    for (let i = 0; i < maxPlaysPerHour; i++) {
      sm.recordPlay(layoutId);
    }
  };

  describe('live path — getCurrentLayouts()', () => {
    it('returns default when ALL scheduled layouts are rate-limited', () => {
      sm.setSchedule(makeSchedule({ withDefault: true }));

      saturate('100', 2);
      saturate('200', 2);
      saturate('300', 2);

      const layouts = sm.getCurrentLayouts();
      expect(layouts).toEqual(['0']);
    });

    it('returns surviving layouts when SOME are rate-limited (does NOT interleave default)', () => {
      sm.setSchedule(makeSchedule({ withDefault: true }));

      saturate('100', 2);
      saturate('200', 2);
      // 300 NOT saturated — it survives

      const layouts = sm.getCurrentLayouts();
      expect(layouts).toContain('300');
      expect(layouts).not.toContain('100');
      expect(layouts).not.toContain('200');
      expect(layouts).not.toContain('0'); // ← locks in: no interleave in live path
    });

    it('returns empty when all rate-limited and no default layout', () => {
      sm.setSchedule(makeSchedule({ withDefault: false }));

      saturate('100', 2);
      saturate('200', 2);
      saturate('300', 2);

      const layouts = sm.getCurrentLayouts();
      expect(layouts).toEqual([]);
    });

    it('returns all layouts when none are rate-limited', () => {
      sm.setSchedule(makeSchedule({ withDefault: true }));

      // No plays recorded — all three fully available
      const layouts = sm.getCurrentLayouts();
      expect(new Set(layouts)).toEqual(new Set(['100', '200', '300']));
      expect(layouts).not.toContain('0');
    });
  });

  describe('pre-computed queue — buildScheduleQueue()', () => {
    it('interleaves default layout into the queue when all scheduled layouts deplete', () => {
      // 3 layouts each allowed 2 plays/hour. After all six slots are
      // consumed within the simulated period, the queue builder MUST
      // fall back to the default layout.
      const allLayouts = [
        { file: '100', priority: 5, maxPlaysPerHour: 2, duration: 60 },
        { file: '200', priority: 5, maxPlaysPerHour: 2, duration: 60 },
        { file: '300', priority: 5, maxPlaysPerHour: 2, duration: 60 }
      ];
      const durations = new Map([
        ['100', 60], ['200', 60], ['300', 60], ['0', 60]
      ]);

      const { queue, periodSeconds } = buildScheduleQueue(allLayouts, durations, {
        defaultLayout: '0',
        defaultDuration: 60
      });

      expect(queue.length).toBeGreaterThan(0);
      expect(periodSeconds).toBeGreaterThan(0);

      const seenDefault = queue.some(entry => entry.layoutId === '0');
      expect(seenDefault).toBe(true);

      // Sanity: each rate-limited layout appears at most maxPlaysPerHour
      // times per simulated hour of the queue.
      for (const layoutFile of ['100', '200', '300']) {
        const plays = queue.filter(e => e.layoutId === layoutFile).length;
        // Queue period can be multi-hour (LCM-based) — cap the
        // expectation at a generous upper bound to avoid coupling to
        // exact period length.
        expect(plays).toBeLessThanOrEqual(Math.ceil(periodSeconds / 1800) * 2);
      }
    });

    it('omits default when no rate-limited layout deplets within the period', () => {
      // Unlimited layouts — default should not appear (it's only a
      // fallback, not a scheduled entry).
      const allLayouts = [
        { file: '100', priority: 5, maxPlaysPerHour: 0, duration: 60 },
        { file: '200', priority: 5, maxPlaysPerHour: 0, duration: 60 }
      ];
      const durations = new Map([['100', 60], ['200', 60]]);

      const { queue } = buildScheduleQueue(allLayouts, durations, {
        defaultLayout: '0',
        defaultDuration: 60
      });

      expect(queue.length).toBeGreaterThan(0);
      expect(queue.every(e => e.layoutId !== '0')).toBe(true);
    });

    it('produces a queue that contains ONLY default when no scheduled layouts exist', () => {
      const { queue } = buildScheduleQueue([], new Map(), {
        defaultLayout: '0',
        defaultDuration: 45
      });

      expect(queue).toHaveLength(1);
      expect(queue[0]).toEqual({ layoutId: '0', duration: 45 });
    });
  });
});
