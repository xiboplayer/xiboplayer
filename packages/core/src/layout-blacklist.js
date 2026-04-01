// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Layout blacklist — tracks consecutive rendering failures and
 * blacklists layouts that fail repeatedly to prevent crash loops.
 */

import { createLogger } from '@xiboplayer/utils';

const log = createLogger('Blacklist');

export class LayoutBlacklist {
  /**
   * @param {number} [threshold=3] - Consecutive failures before blacklisting
   */
  constructor(threshold = 3) {
    this._entries = new Map();
    this._threshold = threshold;
  }

  /**
   * Record a layout rendering failure.
   * @param {number} layoutId
   * @param {string} reason
   * @returns {{ blacklisted: boolean, failures: number }} Current state after recording
   */
  recordFailure(layoutId, reason) {
    const id = Number(layoutId);
    const entry = this._entries.get(id) || { failures: 0, blacklisted: false, reason: '' };
    entry.failures++;
    entry.reason = reason;

    if (!entry.blacklisted && entry.failures >= this._threshold) {
      entry.blacklisted = true;
      log.warn(`Layout ${id} blacklisted after ${entry.failures} consecutive failures: ${reason}`);
    } else if (!entry.blacklisted) {
      log.info(`Layout ${id} failure ${entry.failures}/${this._threshold}: ${reason}`);
    }

    this._entries.set(id, entry);
    return { blacklisted: entry.blacklisted, failures: entry.failures };
  }

  /**
   * Record a successful layout render. Resets failure counter.
   * @param {number} layoutId
   * @returns {boolean} true if the layout was previously blacklisted (now restored)
   */
  recordSuccess(layoutId) {
    const id = Number(layoutId);
    if (!this._entries.has(id)) return false;

    const was = this._entries.get(id);
    this._entries.delete(id);

    if (was.blacklisted) {
      log.info(`Layout ${id} removed from blacklist (rendered successfully)`);
      return true;
    }
    return false;
  }

  /**
   * Check if a layout is currently blacklisted.
   * @param {number} layoutId
   * @returns {boolean}
   */
  isBlacklisted(layoutId) {
    const entry = this._entries.get(Number(layoutId));
    return entry?.blacklisted === true;
  }

  /**
   * Get all currently blacklisted layout IDs.
   * @returns {number[]}
   */
  getBlacklistedIds() {
    const result = [];
    for (const [id, entry] of this._entries) {
      if (entry.blacklisted) result.push(id);
    }
    return result;
  }

  /**
   * Reset the blacklist. Called when RequiredFiles changes.
   * @returns {number} Number of entries cleared
   */
  reset() {
    const count = this._entries.size;
    if (count > 0) {
      log.info(`Blacklist reset (${count} entries cleared)`);
      this._entries.clear();
    }
    return count;
  }

  get size() {
    return this._entries.size;
  }
}
