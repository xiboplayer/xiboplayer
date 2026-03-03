/**
 * LayoutPool Test Suite
 *
 * Tests for the layout preload pool: add, get, evict, LRU, clear.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LayoutPool } from './layout-pool.js';

describe('LayoutPool', () => {
  let pool;

  // Mock URL.revokeObjectURL (not available in jsdom)
  beforeEach(() => {
    pool = new LayoutPool(2);

    if (!global.URL.revokeObjectURL) {
      global.URL.revokeObjectURL = vi.fn();
    } else {
      vi.spyOn(URL, 'revokeObjectURL');
    }
  });

  /**
   * Helper: create a mock pool entry
   */
  function createMockEntry(layoutId) {
    const container = document.createElement('div');
    container.id = `layout_${layoutId}`;
    document.body.appendChild(container);

    return {
      container,
      layout: { width: 1920, height: 1080, duration: 60, bgcolor: '#000', regions: [] },
      regions: new Map(),
      blobUrls: new Set()
    };
  }

  describe('constructor', () => {
    it('should initialize with default maxSize of 2', () => {
      const defaultPool = new LayoutPool();
      expect(defaultPool.maxSize).toBe(2);
      expect(defaultPool.size).toBe(0);
      expect(defaultPool.hotLayoutId).toBeNull();
    });

    it('should accept custom maxSize', () => {
      const customPool = new LayoutPool(5);
      expect(customPool.maxSize).toBe(5);
    });
  });

  describe('has()', () => {
    it('should return false for empty pool', () => {
      expect(pool.has(1)).toBe(false);
    });

    it('should return true after adding a layout', () => {
      pool.add(1, createMockEntry(1));
      expect(pool.has(1)).toBe(true);
    });

    it('should return false for non-existent layout', () => {
      pool.add(1, createMockEntry(1));
      expect(pool.has(2)).toBe(false);
    });
  });

  describe('get()', () => {
    it('should return undefined for empty pool', () => {
      expect(pool.get(1)).toBeUndefined();
    });

    it('should return the entry after adding', () => {
      const entry = createMockEntry(1);
      pool.add(1, entry);
      const retrieved = pool.get(1);
      expect(retrieved).toBeTruthy();
      expect(retrieved.layout).toEqual(entry.layout);
      expect(retrieved.status).toBe('warm');
    });
  });

  describe('add()', () => {
    it('should add entry as warm status', () => {
      pool.add(1, createMockEntry(1));
      const entry = pool.get(1);
      expect(entry.status).toBe('warm');
      expect(entry.lastAccess).toBeGreaterThan(0);
    });

    it('should set pool size correctly', () => {
      pool.add(1, createMockEntry(1));
      expect(pool.size).toBe(1);

      pool.add(2, createMockEntry(2));
      expect(pool.size).toBe(2);
    });

    it('should update in place when adding same layout ID', () => {
      const entry1 = createMockEntry(1);
      entry1.layout.duration = 30;
      pool.add(1, entry1);

      const entry2 = createMockEntry(1);
      entry2.layout.duration = 60;
      pool.add(1, entry2);

      expect(pool.size).toBe(1);
      expect(pool.get(1).layout.duration).toBe(60);
    });

    it('should evict LRU warm entry when pool is full', () => {
      pool.add(1, createMockEntry(1));
      pool.add(2, createMockEntry(2));

      // Pool is full (maxSize=2), adding a third should evict the oldest warm
      pool.add(3, createMockEntry(3));

      expect(pool.size).toBe(2);
      expect(pool.has(1)).toBe(false); // Oldest evicted
      expect(pool.has(2)).toBe(true);
      expect(pool.has(3)).toBe(true);
    });
  });

  describe('setHot()', () => {
    it('should mark entry as hot', () => {
      pool.add(1, createMockEntry(1));
      pool.setHot(1);

      expect(pool.get(1).status).toBe('hot');
      expect(pool.hotLayoutId).toBe(1);
    });

    it('should demote previous hot entry to warm', () => {
      pool.add(1, createMockEntry(1));
      pool.add(2, createMockEntry(2));

      pool.setHot(1);
      expect(pool.get(1).status).toBe('hot');

      pool.setHot(2);
      expect(pool.get(1).status).toBe('warm');
      expect(pool.get(2).status).toBe('hot');
      expect(pool.hotLayoutId).toBe(2);
    });
  });

  describe('evict()', () => {
    it('should remove entry from pool', () => {
      pool.add(1, createMockEntry(1));
      pool.evict(1);

      expect(pool.has(1)).toBe(false);
      expect(pool.size).toBe(0);
    });

    it('should revoke blob URLs on eviction', () => {
      const entry = createMockEntry(1);
      entry.blobUrls.add('blob:test-1');
      entry.blobUrls.add('blob:test-2');

      pool.add(1, entry);
      pool.evict(1);

      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-1');
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-2');
    });

    it('should remove container from DOM', () => {
      const entry = createMockEntry(1);
      pool.add(1, entry);

      expect(entry.container.parentNode).toBeTruthy();
      pool.evict(1);
      expect(entry.container.parentNode).toBeNull();
    });

    it('should clear hot reference if evicting hot layout', () => {
      pool.add(1, createMockEntry(1));
      pool.setHot(1);
      expect(pool.hotLayoutId).toBe(1);

      pool.evict(1);
      expect(pool.hotLayoutId).toBeNull();
    });

    it('should do nothing for non-existent layout', () => {
      // Should not throw
      pool.evict(999);
      expect(pool.size).toBe(0);
    });

    it('should clear region timers on eviction', () => {
      const entry = createMockEntry(1);
      const mockTimer = setTimeout(() => {}, 99999);
      const clearSpy = vi.spyOn(global, 'clearTimeout');

      entry.regions.set('r1', {
        timer: mockTimer,
        element: document.createElement('div'),
        widgets: [],
        widgetElements: new Map()
      });

      pool.add(1, entry);
      pool.evict(1);

      expect(clearSpy).toHaveBeenCalledWith(mockTimer);
      clearSpy.mockRestore();
    });
  });

  describe('evictLRU()', () => {
    it('should evict oldest warm entry', () => {
      const entry1 = createMockEntry(1);
      const entry2 = createMockEntry(2);

      // Use deterministic timestamps to ensure entry1 is older
      let time = 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => time);

      pool.add(1, entry1);
      time = 2000;
      pool.add(2, entry2);

      // entry1 has lastAccess=1000, entry2 has lastAccess=2000
      // evictLRU should evict entry1 (oldest warm)
      pool.evictLRU();

      expect(pool.has(1)).toBe(false);
      expect(pool.has(2)).toBe(true);

      vi.restoreAllMocks();
    });

    it('should not evict hot entry', () => {
      pool.add(1, createMockEntry(1));
      pool.add(2, createMockEntry(2));
      pool.setHot(1);

      // Only warm entries can be evicted
      pool.evictLRU();

      expect(pool.has(1)).toBe(true); // Hot - preserved
      expect(pool.has(2)).toBe(false); // Warm - evicted
    });

    it('should do nothing if no warm entries', () => {
      pool.add(1, createMockEntry(1));
      pool.setHot(1);

      // Only hot entry exists - nothing to evict
      pool.evictLRU();
      expect(pool.size).toBe(1);
    });
  });

  describe('clearWarm()', () => {
    it('should clear all warm entries', () => {
      pool.add(1, createMockEntry(1));
      pool.add(2, createMockEntry(2));
      pool.setHot(1);

      const count = pool.clearWarm();

      expect(count).toBe(1);
      expect(pool.has(1)).toBe(true); // Hot - preserved
      expect(pool.has(2)).toBe(false); // Warm - cleared
    });

    it('should return 0 when no warm entries', () => {
      pool.add(1, createMockEntry(1));
      pool.setHot(1);

      const count = pool.clearWarm();
      expect(count).toBe(0);
    });

    it('should clear all entries when all are warm', () => {
      pool.add(1, createMockEntry(1));
      pool.add(2, createMockEntry(2));

      const count = pool.clearWarm();

      expect(count).toBe(2);
      expect(pool.size).toBe(0);
    });
  });

  describe('clear()', () => {
    it('should clear all entries including hot', () => {
      pool.add(1, createMockEntry(1));
      pool.add(2, createMockEntry(2));
      pool.setHot(1);

      pool.clear();

      expect(pool.size).toBe(0);
      expect(pool.hotLayoutId).toBeNull();
      expect(pool.has(1)).toBe(false);
      expect(pool.has(2)).toBe(false);
    });

    it('should work on empty pool', () => {
      pool.clear();
      expect(pool.size).toBe(0);
    });
  });

  describe('size', () => {
    it('should track pool size accurately', () => {
      expect(pool.size).toBe(0);

      pool.add(1, createMockEntry(1));
      expect(pool.size).toBe(1);

      pool.add(2, createMockEntry(2));
      expect(pool.size).toBe(2);

      pool.evict(1);
      expect(pool.size).toBe(1);

      pool.clear();
      expect(pool.size).toBe(0);
    });
  });

  describe('LRU eviction under pressure', () => {
    it('should evict oldest warm when adding beyond maxSize', () => {
      // maxSize=2, add 3 layouts
      pool.add(1, createMockEntry(1));
      pool.add(2, createMockEntry(2));

      // Add third - should evict layout 1 (oldest)
      pool.add(3, createMockEntry(3));

      expect(pool.size).toBe(2);
      expect(pool.has(1)).toBe(false);
      expect(pool.has(2)).toBe(true);
      expect(pool.has(3)).toBe(true);
    });

    it('should preserve hot layout during LRU eviction', () => {
      pool.add(1, createMockEntry(1));
      pool.setHot(1);
      pool.add(2, createMockEntry(2));

      // Pool is full (1=hot, 2=warm). Adding 3 should evict 2 (warm), not 1 (hot)
      pool.add(3, createMockEntry(3));

      expect(pool.size).toBe(2);
      expect(pool.has(1)).toBe(true); // Hot - preserved
      expect(pool.has(2)).toBe(false); // Warm - evicted
      expect(pool.has(3)).toBe(true); // Newly added
    });
  });
});
