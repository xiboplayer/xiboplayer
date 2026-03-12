// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Integration tests - Schedule + Interrupt Scheduler
 * Tests the integration between @xiboplayer/schedule and interrupt processing
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ScheduleManager } from '@xiboplayer/schedule';
import { InterruptScheduler } from './interrupts.js';

describe('Schedule + Interrupt Integration', () => {
  let scheduleManager;
  let interruptScheduler;

  beforeEach(() => {
    interruptScheduler = new InterruptScheduler();
    scheduleManager = new ScheduleManager({ interruptScheduler });
  });

  // Helper to create mock schedule
  const createSchedule = (layouts) => ({
    layouts: layouts.map((l, idx) => ({
      id: l.id || idx + 1,
      file: l.file || idx + 100,
      duration: l.duration || 60,
      shareOfVoice: l.shareOfVoice || 0,
      priority: l.priority || 0,
      fromdt: l.fromdt || '2026-01-01 00:00:00',
      todt: l.todt || '2027-01-01 00:00:00',
      maxPlaysPerHour: l.maxPlaysPerHour || 0
    }))
  });

  describe('Basic interrupt integration', () => {
    it('should process interrupts automatically', () => {
      const schedule = createSchedule([
        { file: 10, duration: 60, shareOfVoice: 10 }, // Interrupt
        { file: 20, duration: 60, shareOfVoice: 0 }   // Normal
      ]);

      scheduleManager.setSchedule(schedule);
      const layouts = scheduleManager.getCurrentLayouts();

      // Should have both interrupts and normal layouts
      expect(layouts.length).toBeGreaterThan(0);

      const interruptCount = layouts.filter(f => f === 10).length;
      const normalCount = layouts.filter(f => f === 20).length;

      // 10% = 360s / 60s = 6 interrupt plays
      expect(interruptCount).toBe(6);

      // Remaining 3240s / 60s = 54 normal plays
      expect(normalCount).toBe(54);
    });

    it('should work without interrupt scheduler', () => {
      // Create schedule manager without interrupt scheduler
      const basicManager = new ScheduleManager();
      const schedule = createSchedule([
        { file: 10, duration: 60, shareOfVoice: 10 },
        { file: 20, duration: 60, shareOfVoice: 0 }
      ]);

      basicManager.setSchedule(schedule);
      const layouts = basicManager.getCurrentLayouts();

      // Without interrupt scheduler, both layouts treated equally
      expect(layouts).toContain(10);
      expect(layouts).toContain(20);
    });

    it('should handle schedule with only normal layouts', () => {
      const schedule = createSchedule([
        { file: 10, duration: 60, shareOfVoice: 0 },
        { file: 20, duration: 60, shareOfVoice: 0 }
      ]);

      scheduleManager.setSchedule(schedule);
      const layouts = scheduleManager.getCurrentLayouts();

      // Should return both files
      expect(layouts).toContain(10);
      expect(layouts).toContain(20);
    });

    it('should handle schedule with only interrupts', () => {
      const schedule = createSchedule([
        { file: 10, duration: 60, shareOfVoice: 100 }
      ]);

      scheduleManager.setSchedule(schedule);
      const layouts = scheduleManager.getCurrentLayouts();

      // Should fill hour with interrupts
      expect(layouts.length).toBeGreaterThan(0);
      expect(layouts.every(f => f === 10)).toBe(true);
    });
  });

  describe('Priority + Interrupts', () => {
    it('should respect priority before processing interrupts', () => {
      const schedule = createSchedule([
        { file: 10, duration: 60, shareOfVoice: 10, priority: 5 },  // Lower priority interrupt
        { file: 20, duration: 60, shareOfVoice: 0, priority: 10 }   // Higher priority normal
      ]);

      scheduleManager.setSchedule(schedule);
      const layouts = scheduleManager.getCurrentLayouts();

      // Only priority 10 should be included
      expect(layouts.every(f => f === 20)).toBe(true);
    });

    it('should process interrupts among same-priority layouts', () => {
      const schedule = createSchedule([
        { file: 10, duration: 60, shareOfVoice: 25, priority: 10 }, // Interrupt
        { file: 20, duration: 60, shareOfVoice: 25, priority: 10 }, // Interrupt
        { file: 30, duration: 60, shareOfVoice: 0, priority: 10 }   // Normal
      ]);

      scheduleManager.setSchedule(schedule);
      const layouts = scheduleManager.getCurrentLayouts();

      const int1Count = layouts.filter(f => f === 10).length;
      const int2Count = layouts.filter(f => f === 20).length;
      const normalCount = layouts.filter(f => f === 30).length;

      // Each interrupt: 25% = 900s / 60s = 15 plays
      expect(int1Count).toBe(15);
      expect(int2Count).toBe(15);

      // Remaining: 1800s / 60s = 30 normal plays
      expect(normalCount).toBe(30);
    });
  });

  describe('Campaigns + Interrupts', () => {
    it('should process interrupts from campaigns', () => {
      scheduleManager.setSchedule({
        campaigns: [
          {
            id: 1,
            priority: 10,
            fromdt: '2026-01-01 00:00:00',
            todt: '2027-01-01 00:00:00',
            layouts: [
              { file: 10, duration: 60, shareOfVoice: 10 },
              { file: 20, duration: 60, shareOfVoice: 0 }
            ]
          }
        ]
      });

      const layouts = scheduleManager.getCurrentLayouts();

      const interruptCount = layouts.filter(f => f === 10).length;
      const normalCount = layouts.filter(f => f === 20).length;

      // Interrupt: 10% = 360s / 60s = 6 plays
      expect(interruptCount).toBe(6);

      // Normal fills remaining time
      expect(normalCount).toBeGreaterThan(0);
    });

    it('should handle mixed campaigns and standalone interrupts', () => {
      scheduleManager.setSchedule({
        campaigns: [
          {
            id: 1,
            priority: 10,
            fromdt: '2026-01-01 00:00:00',
            todt: '2027-01-01 00:00:00',
            layouts: [
              { file: 10, duration: 60, shareOfVoice: 0 } // Normal in campaign
            ]
          }
        ],
        layouts: [
          {
            id: 2,
            file: 20,
            duration: 60,
            shareOfVoice: 10, // Interrupt standalone
            priority: 10,
            fromdt: '2026-01-01 00:00:00',
            todt: '2027-01-01 00:00:00'
          }
        ]
      });

      const layouts = scheduleManager.getCurrentLayouts();

      const normalCount = layouts.filter(f => f === 10).length;
      const interruptCount = layouts.filter(f => f === 20).length;

      // Both should be present
      expect(normalCount).toBeGreaterThan(0);
      expect(interruptCount).toBeGreaterThan(0);

      // Interrupt: 10% = 6 plays
      expect(interruptCount).toBe(6);
    });
  });

  describe('Time-based filtering + Interrupts', () => {
    it('should filter out-of-date interrupts', () => {
      const schedule = createSchedule([
        { file: 10, duration: 60, shareOfVoice: 50, todt: '2020-01-01 00:00:00' }, // Expired interrupt
        { file: 20, duration: 60, shareOfVoice: 0 } // Active normal
      ]);

      scheduleManager.setSchedule(schedule);
      const layouts = scheduleManager.getCurrentLayouts();

      // Only normal layout should be present
      expect(layouts.every(f => f === 20)).toBe(true);
    });

    it('should handle dayparting with interrupts', () => {
      const now = new Date();
      const currentHour = now.getHours();
      const fromTime = new Date();
      fromTime.setHours(currentHour - 1, 0, 0, 0);
      const toTime = new Date();
      toTime.setHours(currentHour + 1, 0, 0, 0);

      scheduleManager.setSchedule({
        layouts: [
          {
            id: 1,
            file: 10,
            duration: 60,
            shareOfVoice: 20,
            priority: 0,
            fromdt: fromTime.toISOString(),
            todt: toTime.toISOString(),
            recurrenceType: 'Week',
            recurrenceRepeatsOn: '1,2,3,4,5,6,7' // All days
          },
          {
            id: 2,
            file: 20,
            duration: 60,
            shareOfVoice: 0,
            priority: 0,
            fromdt: fromTime.toISOString(),
            todt: toTime.toISOString()
          }
        ]
      });

      const layouts = scheduleManager.getCurrentLayouts();

      // Should have both layouts
      expect(layouts.length).toBeGreaterThan(0);

      const interruptCount = layouts.filter(f => f === 10).length;

      // 20% = 720s / 60s = 12 plays
      expect(interruptCount).toBe(12);
    });
  });

  describe('maxPlaysPerHour + Interrupts', () => {
    it('should respect maxPlaysPerHour for normal layouts', () => {
      const schedule = createSchedule([
        { file: 10, duration: 60, shareOfVoice: 10 }, // Interrupt
        { file: 20, duration: 60, shareOfVoice: 0, maxPlaysPerHour: 5 } // Normal with limit
      ]);

      scheduleManager.setSchedule(schedule);

      // Record plays to trigger maxPlaysPerHour
      for (let i = 0; i < 5; i++) {
        scheduleManager.recordPlay(2); // Layout ID 2
      }

      const layouts = scheduleManager.getCurrentLayouts();

      // Normal layout should be filtered out
      const normalCount = layouts.filter(f => f === 20).length;
      expect(normalCount).toBe(0);

      // Only interrupts should remain
      expect(layouts.every(f => f === 10)).toBe(true);
    });
  });

  describe('Real-world scenarios', () => {
    it('should handle typical digital signage with 5% ads', () => {
      const schedule = createSchedule([
        { file: 100, duration: 120, shareOfVoice: 5 },   // 5% ads
        { file: 200, duration: 120, shareOfVoice: 0 },   // Content 1
        { file: 300, duration: 120, shareOfVoice: 0 }    // Content 2
      ]);

      scheduleManager.setSchedule(schedule);
      const layouts = scheduleManager.getCurrentLayouts();

      const adCount = layouts.filter(f => f === 100).length;
      const adDuration = adCount * 120;

      // 5% of hour = 180 seconds (may overshoot slightly due to rounding)
      expect(adDuration).toBeGreaterThanOrEqual(180);
      expect(adDuration).toBeLessThan(300); // Reasonable upper bound

      // Should have content layouts
      expect(layouts.filter(f => f === 200).length).toBeGreaterThan(0);
      expect(layouts.filter(f => f === 300).length).toBeGreaterThan(0);
    });

    it('should handle lunch hour with special promotions', () => {
      const schedule = createSchedule([
        { file: 1000, duration: 30, shareOfVoice: 20 }, // Lunch specials: 20%
        { file: 2000, duration: 120, shareOfVoice: 0 }  // Regular menu
      ]);

      scheduleManager.setSchedule(schedule);
      const layouts = scheduleManager.getCurrentLayouts();

      const specialCount = layouts.filter(f => f === 1000).length;
      const specialDuration = specialCount * 30;

      // 20% of hour = 720 seconds
      expect(specialDuration).toBe(720);

      // Should have regular content
      expect(layouts.filter(f => f === 2000).length).toBeGreaterThan(0);
    });

    it('should handle emergency alerts (high shareOfVoice)', () => {
      const schedule = createSchedule([
        { file: 9999, duration: 60, shareOfVoice: 75 }, // Emergency alert: 75%
        { file: 1000, duration: 60, shareOfVoice: 0 }   // Normal content
      ]);

      scheduleManager.setSchedule(schedule);
      const layouts = scheduleManager.getCurrentLayouts();

      const alertCount = layouts.filter(f => f === 9999).length;
      const contentCount = layouts.filter(f => f === 1000).length;

      // Alert: 75% = 2700s / 60s = 45 plays
      expect(alertCount).toBe(45);

      // Content: 25% = 900s / 60s = 15 plays
      expect(contentCount).toBe(15);
    });
  });
});
