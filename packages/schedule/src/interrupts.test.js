// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Interrupt Scheduler Tests
 * Exhaustive test suite for shareOfVoice interrupt layouts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InterruptScheduler } from './interrupts.js';

describe('InterruptScheduler', () => {
  let scheduler;

  beforeEach(() => {
    scheduler = new InterruptScheduler();
  });

  // Helper to create mock layouts
  const createLayout = (id, duration, shareOfVoice = 0) => ({
    id,
    file: id,
    duration,
    shareOfVoice,
  });

  describe('isInterrupt', () => {
    it('should identify interrupt layouts', () => {
      const interrupt = createLayout('int1', 10, 50);
      const normal = createLayout('norm1', 10, 0);

      expect(scheduler.isInterrupt(interrupt)).toBe(true);
      expect(scheduler.isInterrupt(normal)).toBe(false);
    });

    it('should handle missing shareOfVoice', () => {
      const layout = { id: 'test', duration: 10 };
      expect(scheduler.isInterrupt(layout)).toBe(false);
    });
  });

  describe('getRequiredSeconds', () => {
    it('should calculate required seconds from shareOfVoice percentage', () => {
      expect(scheduler.getRequiredSeconds(createLayout('int1', 10, 10))).toBe(360); // 10% of 3600
      expect(scheduler.getRequiredSeconds(createLayout('int2', 10, 50))).toBe(1800); // 50% of 3600
      expect(scheduler.getRequiredSeconds(createLayout('int3', 10, 100))).toBe(3600); // 100% of 3600
    });

    it('should return 0 for non-interrupt layouts', () => {
      expect(scheduler.getRequiredSeconds(createLayout('norm1', 10, 0))).toBe(0);
    });
  });

  describe('isInterruptDurationSatisfied', () => {
    it('should check if interrupt has met its shareOfVoice requirement', () => {
      const layout = createLayout('int1', 60, 10); // 10% = 360s required

      expect(scheduler.isInterruptDurationSatisfied(layout)).toBe(false);

      // Add some duration
      scheduler.addCommittedDuration('int1', 180);
      expect(scheduler.isInterruptDurationSatisfied(layout)).toBe(false); // 180 < 360

      // Add more to reach requirement
      scheduler.addCommittedDuration('int1', 180);
      expect(scheduler.isInterruptDurationSatisfied(layout)).toBe(true); // 360 >= 360
    });

    it('should always return true for non-interrupt layouts', () => {
      const layout = createLayout('norm1', 10, 0);
      expect(scheduler.isInterruptDurationSatisfied(layout)).toBe(true);
    });
  });

  describe('resetCommittedDurations', () => {
    it('should clear all committed durations', () => {
      scheduler.addCommittedDuration('int1', 100);
      scheduler.addCommittedDuration('int2', 200);

      expect(scheduler.getCommittedDuration('int1')).toBe(100);
      expect(scheduler.getCommittedDuration('int2')).toBe(200);

      scheduler.resetCommittedDurations();

      expect(scheduler.getCommittedDuration('int1')).toBe(0);
      expect(scheduler.getCommittedDuration('int2')).toBe(0);
    });
  });

  describe('separateLayouts', () => {
    it('should separate normal and interrupt layouts', () => {
      const layouts = [
        createLayout('norm1', 10, 0),
        createLayout('int1', 10, 50),
        createLayout('norm2', 20, 0),
        createLayout('int2', 10, 25),
      ];

      const { normalLayouts, interruptLayouts } = scheduler.separateLayouts(layouts);

      expect(normalLayouts).toHaveLength(2);
      expect(interruptLayouts).toHaveLength(2);
      expect(normalLayouts[0].id).toBe('norm1');
      expect(normalLayouts[1].id).toBe('norm2');
      expect(interruptLayouts[0].id).toBe('int1');
      expect(interruptLayouts[1].id).toBe('int2');
    });

    it('should handle all normal layouts', () => {
      const layouts = [
        createLayout('norm1', 10, 0),
        createLayout('norm2', 20, 0),
      ];

      const { normalLayouts, interruptLayouts } = scheduler.separateLayouts(layouts);

      expect(normalLayouts).toHaveLength(2);
      expect(interruptLayouts).toHaveLength(0);
    });

    it('should handle all interrupt layouts', () => {
      const layouts = [
        createLayout('int1', 10, 50),
        createLayout('int2', 10, 25),
      ];

      const { normalLayouts, interruptLayouts } = scheduler.separateLayouts(layouts);

      expect(normalLayouts).toHaveLength(0);
      expect(interruptLayouts).toHaveLength(2);
    });
  });

  describe('fillTimeWithLayouts', () => {
    it('should repeat layouts to fill target duration', () => {
      const layouts = [
        createLayout('l1', 100),
        createLayout('l2', 100),
      ];

      const result = scheduler.fillTimeWithLayouts(layouts, 500);

      // Should cycle through: l1, l2, l1, l2, l1 = 500s
      expect(result).toHaveLength(5);
      expect(result[0].id).toBe('l1');
      expect(result[1].id).toBe('l2');
      expect(result[2].id).toBe('l1');
      expect(result[3].id).toBe('l2');
      expect(result[4].id).toBe('l1');
    });

    it('should handle single layout', () => {
      const layouts = [createLayout('l1', 60)];
      const result = scheduler.fillTimeWithLayouts(layouts, 180);

      expect(result).toHaveLength(3); // 60s * 3 = 180s
      expect(result.every(l => l.id === 'l1')).toBe(true);
    });

    it('should overshoot slightly when layouts do not divide evenly', () => {
      const layouts = [createLayout('l1', 70)];
      const result = scheduler.fillTimeWithLayouts(layouts, 200);

      // Will overshoot: 70 * 3 = 210 > 200
      expect(result).toHaveLength(3);
    });
  });

  describe('processInterrupts - basic scenarios', () => {
    it('should return normal layouts when no interrupts', () => {
      const normal = [
        createLayout('norm1', 100),
        createLayout('norm2', 100),
      ];

      const result = scheduler.processInterrupts(normal, []);

      expect(result).toEqual(normal);
    });

    it('should handle 10% shareOfVoice interrupt', () => {
      const normal = [createLayout('norm1', 60)];
      const interrupts = [createLayout('int1', 60, 10)]; // 10% = 360s

      const result = scheduler.processInterrupts(normal, interrupts);

      // Count how many times each layout appears
      const interruptCount = result.filter(l => l.id === 'int1').length;
      const normalCount = result.filter(l => l.id === 'norm1').length;

      // 360s / 60s = 6 interrupt plays
      expect(interruptCount).toBe(6);

      // Remaining: 3240s / 60s = 54 normal plays
      expect(normalCount).toBe(54);
    });

    it('should handle 50% shareOfVoice interrupt', () => {
      const normal = [createLayout('norm1', 60)];
      const interrupts = [createLayout('int1', 60, 50)]; // 50% = 1800s

      const result = scheduler.processInterrupts(normal, interrupts);

      const interruptCount = result.filter(l => l.id === 'int1').length;
      const normalCount = result.filter(l => l.id === 'norm1').length;

      // 1800s / 60s = 30 interrupt plays
      expect(interruptCount).toBe(30);

      // Remaining: 1800s / 60s = 30 normal plays
      expect(normalCount).toBe(30);
    });

    it('should handle 100% shareOfVoice interrupt (fills entire hour)', () => {
      const normal = [createLayout('norm1', 60)];
      const interrupts = [createLayout('int1', 60, 100)]; // 100% = 3600s

      const result = scheduler.processInterrupts(normal, interrupts);

      const interruptCount = result.filter(l => l.id === 'int1').length;
      const normalCount = result.filter(l => l.id === 'norm1').length;

      // 3600s / 60s = 60 interrupt plays
      expect(interruptCount).toBe(60);

      // No room for normal layouts
      expect(normalCount).toBe(0);
    });
  });

  describe('processInterrupts - multiple interrupts', () => {
    it('should handle two interrupts with different shareOfVoice', () => {
      const normal = [createLayout('norm1', 60)];
      const interrupts = [
        createLayout('int1', 60, 25), // 25% = 900s
        createLayout('int2', 60, 25), // 25% = 900s
      ];

      const result = scheduler.processInterrupts(normal, interrupts);

      const int1Count = result.filter(l => l.id === 'int1').length;
      const int2Count = result.filter(l => l.id === 'int2').length;
      const normalCount = result.filter(l => l.id === 'norm1').length;

      // Each interrupt: 900s / 60s = 15 plays
      expect(int1Count).toBe(15);
      expect(int2Count).toBe(15);

      // Remaining: 1800s / 60s = 30 normal plays
      expect(normalCount).toBe(30);
    });

    it('should handle interrupts that exceed 100% total (fill entire hour)', () => {
      const normal = [createLayout('norm1', 60)];
      const interrupts = [
        createLayout('int1', 60, 60), // 60%
        createLayout('int2', 60, 60), // 60%
      ];

      const result = scheduler.processInterrupts(normal, interrupts);

      const normalCount = result.filter(l => l.id === 'norm1').length;

      // Total > 100%, so no room for normal layouts
      expect(normalCount).toBe(0);
    });
  });

  describe('processInterrupts - edge cases', () => {
    it('should handle shareOfVoice = 0 (treated as normal layout)', () => {
      const normal = [createLayout('norm1', 60)];
      const interrupts = [createLayout('int1', 60, 0)]; // 0% = not really an interrupt

      const result = scheduler.processInterrupts(normal, interrupts);

      // With shareOfVoice=0, it's not treated as interrupt, but it's still in interrupts array
      // The function will process it and try to satisfy 0% requirement (which is already satisfied)
      // So it won't be added to interrupt loop, result is filled with normal layouts
      const normalCount = result.filter(l => l.id === 'norm1').length;
      expect(normalCount).toBeGreaterThan(0); // Should be filled with normal layouts
    });

    it('should handle empty normal layouts (interrupts fill hour)', () => {
      const normal = [];
      const interrupts = [createLayout('int1', 60, 50)]; // 50%

      const result = scheduler.processInterrupts(normal, interrupts);

      // Should fill entire hour with interrupts
      expect(result.length).toBeGreaterThan(0);
      expect(result.every(l => l.id === 'int1')).toBe(true);
    });

    it('should handle different layout durations', () => {
      const normal = [createLayout('norm1', 120)]; // 2 min layouts
      const interrupts = [createLayout('int1', 30, 10)]; // 30s layouts, 10%

      const result = scheduler.processInterrupts(normal, interrupts);

      const interruptCount = result.filter(l => l.id === 'int1').length;

      // 360s / 30s = 12 interrupt plays
      expect(interruptCount).toBe(12);
    });
  });

  describe('processInterrupts - interleaving', () => {
    it('should interleave interrupts evenly with normal layouts', () => {
      const normal = [createLayout('norm1', 60)];
      const interrupts = [createLayout('int1', 60, 10)]; // 10%

      const result = scheduler.processInterrupts(normal, interrupts);

      // Check that interrupts are distributed (not all at start or end)
      const firstHalf = result.slice(0, result.length / 2);
      const secondHalf = result.slice(result.length / 2);

      const firstHalfInterrupts = firstHalf.filter(l => l.id === 'int1').length;
      const secondHalfInterrupts = secondHalf.filter(l => l.id === 'int1').length;

      // Both halves should have some interrupts (roughly equal)
      expect(firstHalfInterrupts).toBeGreaterThan(0);
      expect(secondHalfInterrupts).toBeGreaterThan(0);
    });

    it('should maintain order within normal layouts during interleaving', () => {
      const normal = [
        createLayout('norm1', 60),
        createLayout('norm2', 60),
      ];
      const interrupts = [createLayout('int1', 60, 10)]; // 10%

      const result = scheduler.processInterrupts(normal, interrupts);

      // Extract just the normal layouts from result
      const normalInResult = result.filter(l => l.id.startsWith('norm'));

      // Should cycle norm1, norm2, norm1, norm2, ...
      for (let i = 0; i < normalInResult.length - 1; i += 2) {
        if (normalInResult[i]) {
          expect(normalInResult[i].id).toBe('norm1');
        }
        if (normalInResult[i + 1]) {
          expect(normalInResult[i + 1].id).toBe('norm2');
        }
      }
    });
  });

  describe('processInterrupts - duration validation', () => {
    it('should produce loop that approximates 3600 seconds', () => {
      const normal = [createLayout('norm1', 60)];
      const interrupts = [createLayout('int1', 60, 25)]; // 25%

      const result = scheduler.processInterrupts(normal, interrupts);

      const totalDuration = result.reduce((sum, layout) => sum + layout.duration, 0);

      // Should be close to 3600s (may overshoot slightly)
      expect(totalDuration).toBeGreaterThanOrEqual(3600);
      expect(totalDuration).toBeLessThan(3700); // Allow small overshoot
    });

    it('should handle hour boundary correctly', () => {
      const normal = [createLayout('norm1', 3600)]; // 1 hour layout
      const interrupts = [createLayout('int1', 60, 10)]; // 10% = 6 minutes

      const result = scheduler.processInterrupts(normal, interrupts);

      // Should have 6 minutes of interrupts + remaining time from normal
      const interruptTime = result.filter(l => l.id === 'int1')
        .reduce((sum, l) => sum + l.duration, 0);

      expect(interruptTime).toBe(360); // 6 minutes
    });
  });

  describe('processInterrupts - campaign-like behavior', () => {
    it('should cycle through multiple normal layouts', () => {
      const normal = [
        createLayout('norm1', 60),
        createLayout('norm2', 60),
        createLayout('norm3', 60),
      ];
      const interrupts = [createLayout('int1', 60, 10)]; // 10%

      const result = scheduler.processInterrupts(normal, interrupts);

      const normalInResult = result.filter(l => l.id.startsWith('norm'));

      // Should see all three normal layouts
      expect(normalInResult.some(l => l.id === 'norm1')).toBe(true);
      expect(normalInResult.some(l => l.id === 'norm2')).toBe(true);
      expect(normalInResult.some(l => l.id === 'norm3')).toBe(true);
    });

    it('should cycle through multiple interrupt layouts', () => {
      const normal = [createLayout('norm1', 60)];
      const interrupts = [
        createLayout('int1', 60, 10),
        createLayout('int2', 60, 10),
        createLayout('int3', 60, 10),
      ];

      const result = scheduler.processInterrupts(normal, interrupts);

      const interruptsInResult = result.filter(l => l.id.startsWith('int'));

      // Should see all three interrupts
      expect(interruptsInResult.some(l => l.id === 'int1')).toBe(true);
      expect(interruptsInResult.some(l => l.id === 'int2')).toBe(true);
      expect(interruptsInResult.some(l => l.id === 'int3')).toBe(true);
    });
  });

  describe('processInterrupts - real-world scenarios', () => {
    it('should handle typical advertising scenario (5% ads)', () => {
      const normal = [
        createLayout('content1', 120),
        createLayout('content2', 120),
      ];
      const interrupts = [
        createLayout('ad1', 30, 5), // 5% = 3 minutes of ads per hour
      ];

      const result = scheduler.processInterrupts(normal, interrupts);

      const adDuration = result.filter(l => l.id === 'ad1')
        .reduce((sum, l) => sum + l.duration, 0);

      // Should be 180s (3 minutes)
      expect(adDuration).toBe(180);
    });

    it('should handle multiple ad campaigns with different shareOfVoice', () => {
      const normal = [createLayout('content1', 60)];
      const interrupts = [
        createLayout('premium_ad', 30, 15), // Premium ads: 15%
        createLayout('regular_ad', 30, 10), // Regular ads: 10%
      ];

      const result = scheduler.processInterrupts(normal, interrupts);

      const premiumDuration = result.filter(l => l.id === 'premium_ad')
        .reduce((sum, l) => sum + l.duration, 0);
      const regularDuration = result.filter(l => l.id === 'regular_ad')
        .reduce((sum, l) => sum + l.duration, 0);

      // Premium: 15% of 3600 = 540s
      expect(premiumDuration).toBe(540);

      // Regular: 10% of 3600 = 360s
      expect(regularDuration).toBe(360);
    });

    it('should work with dayparting schedules', () => {
      // Simulate lunch hour with restaurant ads
      const normal = [createLayout('menu', 120)];
      const interrupts = [createLayout('lunch_special', 30, 20)]; // 20% during lunch

      const result = scheduler.processInterrupts(normal, interrupts);

      const specialDuration = result.filter(l => l.id === 'lunch_special')
        .reduce((sum, l) => sum + l.duration, 0);

      // 20% of hour = 720s (12 minutes)
      expect(specialDuration).toBe(720);
    });
  });

  describe('committed duration tracking', () => {
    it('should track committed durations across multiple layouts', () => {
      scheduler.addCommittedDuration('layout1', 100);
      scheduler.addCommittedDuration('layout2', 200);
      scheduler.addCommittedDuration('layout1', 50);

      expect(scheduler.getCommittedDuration('layout1')).toBe(150);
      expect(scheduler.getCommittedDuration('layout2')).toBe(200);
    });

    it('should return 0 for unknown layouts', () => {
      expect(scheduler.getCommittedDuration('unknown')).toBe(0);
    });
  });
});
