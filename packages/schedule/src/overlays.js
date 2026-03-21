// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Overlay Layout Scheduler
 *
 * Manages overlay layouts that appear on top of main layouts.
 * Based on upstream electron-player implementation.
 *
 * Overlays:
 * - Render on top of main layout (higher z-index)
 * - Have scheduled start/end times
 * - Support priority ordering (multiple overlays)
 * - Support criteria-based display (future)
 * - Support geofencing (future)
 *
 * Reference: upstream_players/electron-player/src/main/xmds/response/schedule/events/overlayLayout.ts
 */

import { createLogger } from '@xiboplayer/utils';
import { evaluateCriteria } from './criteria.js';

const logger = createLogger('schedule:overlays');

/**
 * Overlay Scheduler
 * Handles overlay layouts that display on top of main layouts
 */
export class OverlayScheduler {
  constructor() {
    this.overlays = [];
    this.displayProperties = {};
    this.scheduleManager = null; // Reference to ScheduleManager for geo checks
    logger.debug('OverlayScheduler initialized');
  }

  /**
   * Set reference to ScheduleManager for geo-fence checks
   * @param {ScheduleManager} scheduleManager
   */
  setScheduleManager(scheduleManager) {
    this.scheduleManager = scheduleManager;
  }

  /**
   * Set display properties for criteria evaluation
   * @param {Object} properties
   */
  setDisplayProperties(properties) {
    this.displayProperties = properties || {};
  }

  /**
   * Update overlays from XMDS Schedule response
   * @param {Array} overlays - Overlay objects from XMDS
   */
  setOverlays(overlays) {
    this.overlays = overlays || [];
    logger.info(`Loaded ${this.overlays.length} overlay(s)`);
  }

  /**
   * Get currently active overlays
   * @returns {Array} Active overlay objects sorted by priority (highest first)
   */
  getCurrentOverlays() {
    if (!this.overlays || this.overlays.length === 0) {
      return [];
    }

    const now = new Date();
    const activeOverlays = [];

    for (const overlay of this.overlays) {
      // Check time window
      if (!this.isTimeActive(overlay, now)) {
        logger.debug(`Overlay ${overlay.file} not in time window`);
        continue;
      }

      // Check geo-awareness
      if (overlay.isGeoAware && overlay.geoLocation) {
        if (this.scheduleManager && !this.scheduleManager.isWithinGeoFence(overlay.geoLocation)) {
          logger.debug(`Overlay ${overlay.file} filtered by geofence`);
          continue;
        }
      }

      // Check criteria conditions
      if (overlay.criteria && overlay.criteria.length > 0) {
        if (!evaluateCriteria(overlay.criteria, { now, displayProperties: this.displayProperties })) {
          logger.debug(`Overlay ${overlay.file} filtered by criteria`);
          continue;
        }
      }

      activeOverlays.push(overlay);
    }

    // Sort by priority (highest first)
    activeOverlays.sort((a, b) => {
      const priorityA = a.priority || 0;
      const priorityB = b.priority || 0;
      return priorityB - priorityA;
    });

    if (activeOverlays.length > 0) {
      logger.info(`Active overlays: ${activeOverlays.length}`);
    }

    return activeOverlays;
  }

  /**
   * Check if overlay is within its time window
   * @param {Object} overlay - Overlay object
   * @param {Date} now - Current time
   * @returns {boolean}
   */
  isTimeActive(overlay, now) {
    const from = (overlay.fromdt || overlay.fromDt) ? new Date(overlay.fromdt || overlay.fromDt) : null;
    const to = (overlay.todt || overlay.toDt) ? new Date(overlay.todt || overlay.toDt) : null;

    // Check time bounds
    if (from && now < from) {
      return false;
    }
    if (to && now > to) {
      return false;
    }

    return true;
  }

  /**
   * Check if overlay schedule needs update (every minute)
   * @param {number} lastCheck - Last check timestamp
   * @returns {boolean}
   */
  shouldCheckOverlays(lastCheck) {
    if (!lastCheck) return true;
    const elapsed = Date.now() - lastCheck;
    return elapsed >= 60000; // 1 minute
  }

  /**
   * Get overlay by file ID
   * @param {number} fileId - Layout file ID
   * @returns {Object|null}
   */
  getOverlayByFile(fileId) {
    return this.overlays.find(o => o.file === fileId) || null;
  }

  /**
   * Clear all overlays
   */
  clear() {
    this.overlays = [];
    logger.debug('Cleared all overlays');
  }

}

export const overlayScheduler = new OverlayScheduler();
