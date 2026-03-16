// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * LayoutPool - Maintains a pool of pre-built layout containers
 * for instant layout transitions.
 *
 * Instead of tearing down and rebuilding the DOM on every layout switch,
 * the pool keeps up to `maxSize` layout containers alive. The current
 * layout is marked 'hot' (visible); pre-loaded layouts are 'warm' (hidden).
 * When transitioning, visibility is swapped instantly - no DOM rebuild.
 *
 * Pool entries:
 *   layoutId -> { container, layout, regions, blobUrls, mediaUrlCache, status, lastAccess }
 *
 * Status: 'hot' (currently visible) or 'warm' (preloaded, hidden)
 */

import { createLogger } from '@xiboplayer/utils';

const log = createLogger('LayoutPool');

export class LayoutPool {
  /**
   * @param {number} maxSize - Maximum number of layouts to keep in pool (default: 2)
   */
  constructor(maxSize = 2) {
    /** @type {Map<number, Object>} */
    this.layouts = new Map();
    this.maxSize = maxSize;
    /** @type {number|null} */
    this.hotLayoutId = null;
  }

  /**
   * Check if a layout is in the pool
   * @param {number} layoutId
   * @returns {boolean}
   */
  has(layoutId) {
    return this.layouts.has(layoutId);
  }

  /**
   * Get a pool entry
   * @param {number} layoutId
   * @returns {Object|undefined}
   */
  get(layoutId) {
    return this.layouts.get(layoutId);
  }

  /**
   * Add a layout entry to the pool.
   * If pool is full, evicts the least-recently-used warm entry.
   *
   * @param {number} layoutId
   * @param {Object} entry - Pool entry
   * @param {HTMLElement} entry.container - Layout container DOM element
   * @param {Object} entry.layout - Parsed layout object
   * @param {Map} entry.regions - Region map (regionId => region state)
   * @param {Set<string>} entry.blobUrls - Tracked blob URLs for this layout
   * @param {Map} [entry.mediaUrlCache] - Media URL cache (fileId => url)
   */
  add(layoutId, entry) {
    // If already in pool, update in place
    if (this.layouts.has(layoutId)) {
      const existing = this.layouts.get(layoutId);
      Object.assign(existing, entry);
      existing.lastAccess = Date.now();
      return;
    }

    // If pool is full, evict LRU warm entry
    if (this.layouts.size >= this.maxSize) {
      this.evictLRU();
    }

    entry.status = 'warm';
    entry.lastAccess = Date.now();
    this.layouts.set(layoutId, entry);
    log.info(`Added layout ${layoutId} to pool (size: ${this.layouts.size}/${this.maxSize})`);
  }

  /**
   * Mark a layout as active (visible).
   * The previous hot layout is demoted to warm.
   * @param {number} layoutId
   */
  setHot(layoutId) {
    // Demote previous hot layout to warm
    if (this.hotLayoutId !== null && this.layouts.has(this.hotLayoutId)) {
      this.layouts.get(this.hotLayoutId).status = 'warm';
    }

    if (this.layouts.has(layoutId)) {
      const entry = this.layouts.get(layoutId);
      entry.status = 'hot';
      entry.lastAccess = Date.now();
    }

    this.hotLayoutId = layoutId;
  }

  /**
   * Evict a specific layout from the pool.
   * Releases video/audio resources, revokes blob URLs, and removes the container from the DOM.
   * @param {number} layoutId
   */
  evict(layoutId) {
    const entry = this.layouts.get(layoutId);
    if (!entry) return;

    log.info(`Evicting layout ${layoutId} from pool`);

    // Stop any active region timers
    if (entry.regions) {
      for (const [regionId, region] of entry.regions) {
        if (region.timer) {
          clearTimeout(region.timer);
          region.timer = null;
        }
      }
    }

    // Release all video/audio resources BEFORE removing from DOM.
    // Removing a <video> with an active src leaks decoded frame buffers.
    if (entry.container) {
      LayoutPool.releaseMediaElements(entry.container);
    }

    // Revoke blob URLs
    if (entry.blobUrls && entry.blobUrls.size > 0) {
      entry.blobUrls.forEach(url => {
        URL.revokeObjectURL(url);
      });
      log.info(`Revoked ${entry.blobUrls.size} blob URLs for layout ${layoutId}`);
    }

    // Revoke media URL cache blob URLs
    if (entry.mediaUrlCache) {
      for (const [fileId, blobUrl] of entry.mediaUrlCache) {
        if (blobUrl && typeof blobUrl === 'string' && blobUrl.startsWith('blob:')) {
          URL.revokeObjectURL(blobUrl);
        }
      }
    }

    // Remove container from DOM
    if (entry.container && entry.container.parentNode) {
      entry.container.remove();
    }

    this.layouts.delete(layoutId);

    // Clear hot reference if this was the hot layout
    if (this.hotLayoutId === layoutId) {
      this.hotLayoutId = null;
    }
  }

  /**
   * Release all video and audio elements inside a container.
   * Must be called BEFORE removing the container from the DOM —
   * browsers keep decoded frame buffers alive for detached <video> elements
   * that still have a src.
   *
   * @param {HTMLElement} container
   */
  static releaseMediaElements(container) {
    let videoCount = 0;
    let hlsCount = 0;

    container.querySelectorAll('video').forEach(v => {
      // Destroy hls.js instance if attached (stored by renderVideo)
      if (v._hlsInstance) {
        v._hlsInstance.destroy();
        v._hlsInstance = null;
        hlsCount++;
      }
      // Stop MediaStream tracks (webcam/mic)
      if (v._mediaStream) {
        v._mediaStream.getTracks().forEach(t => t.stop());
        v._mediaStream = null;
        v.srcObject = null;
      }
      v.pause();
      v.removeAttribute('src');
      v.load(); // Forces browser to release decoded buffers
      videoCount++;
    });

    container.querySelectorAll('audio').forEach(a => {
      a.pause();
      a.removeAttribute('src');
      a.load();
    });

    // Destroy PDF documents and release GPU canvas backing stores
    container.querySelectorAll('.pdf-widget').forEach(el => {
      if (el._pdfDestroy) el._pdfDestroy();
    });

    if (videoCount > 0) {
      log.info(`Released ${videoCount} video(s)${hlsCount ? ` (${hlsCount} HLS)` : ''}`);
    }
  }

  /**
   * Evict the least-recently-used warm entry.
   * Only warm entries are eligible for eviction (never the hot layout).
   */
  evictLRU() {
    let oldest = null;
    let oldestTime = Infinity;

    for (const [id, entry] of this.layouts) {
      if (entry.status === 'warm' && entry.lastAccess < oldestTime) {
        oldest = id;
        oldestTime = entry.lastAccess;
      }
    }

    if (oldest !== null) {
      this.evict(oldest);
    }
  }

  /**
   * Clear all warm (preloaded) entries, keeping the hot layout.
   * @returns {number} Number of entries cleared
   */
  clearWarm() {
    let count = 0;
    const warmIds = [];

    for (const [id, entry] of this.layouts) {
      if (entry.status === 'warm') {
        warmIds.push(id);
      }
    }

    for (const id of warmIds) {
      this.evict(id);
      count++;
    }

    if (count > 0) {
      log.info(`Cleared ${count} warm layout(s) from pool`);
    }

    return count;
  }

  /**
   * Clear warm entries NOT in the given set of layout IDs.
   * Keeps warm entries that are still scheduled.
   * @param {Set<number>} keepIds - Layout IDs to keep
   * @returns {number} Number of entries cleared
   */
  clearWarmNotIn(keepIds) {
    let count = 0;
    const evictIds = [];

    for (const [id, entry] of this.layouts) {
      if (entry.status === 'warm' && !keepIds.has(id)) {
        evictIds.push(id);
      }
    }

    for (const id of evictIds) {
      this.evict(id);
      count++;
    }

    if (count > 0) {
      log.info(`Cleared ${count} warm layout(s) no longer in schedule`);
    }

    return count;
  }

  /**
   * Get the most recently added layout ID.
   * @returns {number|undefined}
   */
  getLatest() {
    let latest;
    for (const id of this.layouts.keys()) {
      latest = id;
    }
    return latest;
  }

  /**
   * Clear all entries (both hot and warm).
   */
  clear() {
    const ids = Array.from(this.layouts.keys());
    for (const id of ids) {
      this.evict(id);
    }
    this.hotLayoutId = null;
  }

  /**
   * Get the number of entries in the pool.
   * @returns {number}
   */
  get size() {
    return this.layouts.size;
  }
}
