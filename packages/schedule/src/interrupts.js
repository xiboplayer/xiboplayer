// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Interrupt Layout Scheduler (Share of Voice)
 *
 * Implements the shareOfVoice algorithm from upstream electron-player.
 * Interrupts are layouts that must play for a percentage of each hour.
 *
 * Algorithm:
 * 1. Separate interrupts from normal layouts
 * 2. Calculate how many times each interrupt must play per hour
 * 3. Fill remaining time with normal layouts
 * 4. Interleave interrupts and normal layouts evenly
 *
 * Based on: electron-player/src/main/common/scheduleManager.ts (lines 181-321)
 */

import { createLogger } from '@xiboplayer/utils';

const logger = createLogger('schedule:interrupts');

/**
 * Interrupt Scheduler
 * Handles shareOfVoice layouts that must play for a percentage of each hour
 */
export class InterruptScheduler {
  constructor() {
    // Track committed duration per interrupt layout
    this.interruptCommittedDurations = new Map(); // layoutId -> seconds
  }

  /**
   * Check if a layout is an interrupt (has shareOfVoice > 0)
   * @param {Object} layout - Layout object with shareOfVoice property
   * @returns {boolean} True if layout is an interrupt
   */
  isInterrupt(layout) {
    return !!(layout.shareOfVoice && layout.shareOfVoice > 0);
  }

  /**
   * Reset committed duration tracking (call this every hour)
   */
  resetCommittedDurations() {
    this.interruptCommittedDurations.clear();
    logger.debug('Reset interrupt committed durations');
  }

  /**
   * Get committed duration for a layout
   * @param {string} layoutId - Layout ID
   * @returns {number} Committed duration in seconds
   */
  getCommittedDuration(layoutId) {
    return this.interruptCommittedDurations.get(layoutId) || 0;
  }

  /**
   * Add committed duration for a layout
   * @param {string} layoutId - Layout ID
   * @param {number} duration - Duration to add in seconds
   */
  addCommittedDuration(layoutId, duration) {
    const current = this.getCommittedDuration(layoutId);
    this.interruptCommittedDurations.set(layoutId, current + duration);
  }

  /**
   * Check if interrupt layout has satisfied its shareOfVoice requirement
   * @param {Object} layout - Layout with shareOfVoice and duration
   * @returns {boolean} True if satisfied
   */
  isInterruptDurationSatisfied(layout) {
    if (!layout.shareOfVoice) {
      return true; // Not an interrupt
    }

    const layoutId = layout.id || layout.file;
    const requiredSeconds = (layout.shareOfVoice / 100) * 3600; // shareOfVoice is percentage
    const committedSeconds = this.getCommittedDuration(layoutId);

    return committedSeconds >= requiredSeconds;
  }

  /**
   * Calculate how many seconds this interrupt needs to play per hour
   * @param {Object} layout - Layout with shareOfVoice
   * @returns {number} Required seconds per hour
   */
  getRequiredSeconds(layout) {
    if (!layout.shareOfVoice) {
      return 0;
    }
    return (layout.shareOfVoice / 100) * 3600;
  }

  /**
   * Process interrupt layouts and combine with normal layouts
   * Implements the shareOfVoice algorithm from upstream
   *
   * @param {Array} normalLayouts - Normal scheduled layouts
   * @param {Array} interruptLayouts - Interrupt layouts with shareOfVoice
   * @returns {Array} Combined layout loop for the hour
   */
  processInterrupts(normalLayouts, interruptLayouts) {
    if (!interruptLayouts || interruptLayouts.length === 0) {
      logger.debug('No interrupt layouts, returning normal layouts');
      return normalLayouts;
    }

    if (!normalLayouts || normalLayouts.length === 0) {
      logger.warn('No normal layouts available, interrupts will fill entire hour');
      return this.fillHourWithInterrupts(interruptLayouts);
    }

    logger.info(`Processing ${interruptLayouts.length} interrupt layouts with ${normalLayouts.length} normal layouts`);

    // Reset committed durations for this calculation
    for (const layout of interruptLayouts) {
      const layoutId = layout.id || layout.file;
      this.interruptCommittedDurations.set(layoutId, 0);
    }

    const resolvedInterruptLayouts = [];
    let interruptSecondsInHour = 0;
    let index = 0;
    let satisfied = false;

    // Step 1: Build interrupt loop by cycling through interrupts until all are satisfied
    while (!satisfied) {
      // Gone all the way around? Check if all satisfied
      if (index >= interruptLayouts.length) {
        index = 0;

        // Check if all interrupts are satisfied
        let allSatisfied = true;
        for (const layout of interruptLayouts) {
          if (!this.isInterruptDurationSatisfied(layout)) {
            allSatisfied = false;
            break;
          }
        }

        if (allSatisfied) {
          satisfied = true;
          break;
        }
      }

      const currentInterrupt = interruptLayouts[index];

      // If this interrupt is not satisfied, add it to the loop
      if (!this.isInterruptDurationSatisfied(currentInterrupt)) {
        const layoutId = currentInterrupt.id || currentInterrupt.file;
        this.addCommittedDuration(layoutId, currentInterrupt.duration);
        interruptSecondsInHour += currentInterrupt.duration;
        resolvedInterruptLayouts.push(currentInterrupt);
      }

      index++;
    }

    logger.debug(`Resolved ${resolvedInterruptLayouts.length} interrupt plays (${interruptSecondsInHour}s total)`);

    // Step 2: If interrupts fill the entire hour, return only interrupts
    if (interruptSecondsInHour >= 3600) {
      logger.info('Interrupts fill entire hour (>= 3600s), no room for normal layouts');
      return resolvedInterruptLayouts;
    }

    // Step 3: Fill remaining time with normal layouts
    const normalSecondsInHour = 3600 - interruptSecondsInHour;
    const resolvedNormalLayouts = this.fillTimeWithLayouts(normalLayouts, normalSecondsInHour);

    logger.debug(`Resolved ${resolvedNormalLayouts.length} normal plays (${normalSecondsInHour}s target)`);

    // Step 4: Interleave interrupts and normal layouts
    const loop = this.interleaveLayouts(resolvedNormalLayouts, resolvedInterruptLayouts);

    logger.info(`Final loop: ${loop.length} layouts (${resolvedNormalLayouts.length} normal + ${resolvedInterruptLayouts.length} interrupts)`);

    return loop;
  }

  /**
   * Fill time with layouts by repeating them until duration is reached
   * @param {Array} layouts - Layouts to use
   * @param {number} targetSeconds - Target duration in seconds
   * @returns {Array} Resolved layout array
   */
  fillTimeWithLayouts(layouts, targetSeconds) {
    const resolved = [];
    let remainingSeconds = targetSeconds;
    let index = 0;

    while (remainingSeconds > 0) {
      if (index >= layouts.length) {
        index = 0; // Loop back
      }

      const layout = layouts[index];
      resolved.push(layout);
      remainingSeconds -= layout.duration;
      index++;
    }

    return resolved;
  }

  /**
   * Fill entire hour with interrupt layouts only
   * @param {Array} interruptLayouts - Interrupt layouts
   * @returns {Array} Layout loop
   */
  fillHourWithInterrupts(interruptLayouts) {
    return this.fillTimeWithLayouts(interruptLayouts, 3600);
  }

  /**
   * Interleave normal and interrupt layouts evenly
   * Based on upstream algorithm (scheduleManager.ts lines 268-316)
   *
   * @param {Array} normalLayouts - Normal layouts
   * @param {Array} interruptLayouts - Interrupt layouts
   * @returns {Array} Interleaved layout array
   */
  interleaveLayouts(normalLayouts, interruptLayouts) {
    const loop = [];
    const pickCount = Math.max(normalLayouts.length, interruptLayouts.length);

    // Calculate pick intervals
    // Normal: ceiling (pick more often from normal)
    // Interrupt: floor (pick less often from interrupts)
    const normalPick = Math.ceil(1.0 * pickCount / normalLayouts.length);
    const interruptPick = Math.floor(1.0 * pickCount / interruptLayouts.length);

    logger.debug(`Interleaving: pickCount=${pickCount}, normalPick=${normalPick}, interruptPick=${interruptPick}`);

    let normalIndex = 0;
    let interruptIndex = 0;
    let totalSecondsAllocated = 0;

    for (let i = 0; i < pickCount; i++) {
      // Pick from normal list
      if (i % normalPick === 0) {
        // Allow wrapping around
        if (normalIndex >= normalLayouts.length) {
          normalIndex = 0;
        }
        loop.push(normalLayouts[normalIndex]);
        totalSecondsAllocated += normalLayouts[normalIndex].duration;
        normalIndex++;
      }

      // Pick from interrupt list (only if we haven't picked them all yet)
      if (i % interruptPick === 0 && interruptIndex < interruptLayouts.length) {
        loop.push(interruptLayouts[interruptIndex]);
        totalSecondsAllocated += interruptLayouts[interruptIndex].duration;
        interruptIndex++;
      }
    }

    // Fill remaining time with normal layouts (due to ceiling/floor rounding)
    while (totalSecondsAllocated < 3600) {
      if (normalIndex >= normalLayouts.length) {
        normalIndex = 0;
      }
      loop.push(normalLayouts[normalIndex]);
      totalSecondsAllocated += normalLayouts[normalIndex].duration;
      normalIndex++;
    }

    logger.debug(`Interleaved ${loop.length} layouts, total duration: ${totalSecondsAllocated}s`);

    return loop;
  }

  /**
   * Separate layouts into normal and interrupt arrays
   * @param {Array} layouts - All layouts
   * @returns {Object} { normalLayouts, interruptLayouts }
   */
  separateLayouts(layouts) {
    const normalLayouts = [];
    const interruptLayouts = [];

    for (const layout of layouts) {
      if (this.isInterrupt(layout)) {
        interruptLayouts.push(layout);
      } else {
        normalLayouts.push(layout);
      }
    }

    return { normalLayouts, interruptLayouts };
  }
}

// Export singleton instance for convenience
export const interruptScheduler = new InterruptScheduler();
