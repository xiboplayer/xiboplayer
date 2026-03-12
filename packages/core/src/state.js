// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Centralized player state
 *
 * Single source of truth for player status, dimensions, and display info.
 * Avoids scattered state across PlayerCore, renderer, and platform layer.
 */

import { EventEmitter } from '@xiboplayer/utils';

export class PlayerState extends EventEmitter {
  constructor() {
    super();
    this.currentLayoutId = null;
    this.currentScheduleId = null;
    this.displayName = '';
    this.hardwareKey = '';
    this.playerType = 'pwa';
    this.displayStatus = 'idle'; // idle | collecting | rendering | error
    this.screenWidth = 0;
    this.screenHeight = 0;
    this.lastCollectionTime = null;
    this.lastHeartbeat = null;
    this.isRegistered = false;
  }

  /**
   * Update a state property and emit change event
   */
  set(key, value) {
    if (this[key] === value) return;
    const old = this[key];
    this[key] = value;
    this.emit('change', key, value, old);
  }

  /**
   * Get snapshot of current state (for status reporting)
   */
  toJSON() {
    return {
      currentLayoutId: this.currentLayoutId,
      currentScheduleId: this.currentScheduleId,
      displayName: this.displayName,
      hardwareKey: this.hardwareKey,
      playerType: this.playerType,
      displayStatus: this.displayStatus,
      screenWidth: this.screenWidth,
      screenHeight: this.screenHeight,
      lastCollectionTime: this.lastCollectionTime,
      lastHeartbeat: this.lastHeartbeat,
      isRegistered: this.isRegistered
    };
  }
}
