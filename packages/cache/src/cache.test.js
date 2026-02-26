/**
 * Cache Manager Tests
 *
 * Tests for the slimmed-down CacheManager: dependant tracking, getCacheKey,
 * and clearAll. Storage is handled by ContentStore via proxy REST endpoints.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CacheManager } from './cache.js';

describe('CacheManager', () => {
  let manager;

  beforeEach(async () => {
    manager = new CacheManager();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getCacheKey()', () => {
    it('should generate cache key with type and id', () => {
      const key = manager.getCacheKey('media', '123');

      expect(key).toBe('/player/pwa/cache/media/123');
    });

    it('should use filename if provided', () => {
      const key = manager.getCacheKey('media', '123', 'image.jpg');

      expect(key).toBe('/player/pwa/cache/media/image.jpg');
    });

    it('should handle layout type', () => {
      const key = manager.getCacheKey('layout', '100');

      expect(key).toBe('/player/pwa/cache/layout/100');
    });
  });

  describe('Dependant Tracking', () => {
    it('should add a dependant mapping from media to layout', () => {
      manager.addDependant('media1', 'layout1');

      expect(manager.isMediaReferenced('media1')).toBe(true);
    });

    it('should track multiple layouts for same media', () => {
      manager.addDependant('media1', 'layout1');
      manager.addDependant('media1', 'layout2');

      expect(manager.isMediaReferenced('media1')).toBe(true);
    });

    it('should track multiple media for different layouts', () => {
      manager.addDependant('media1', 'layout1');
      manager.addDependant('media2', 'layout1');
      manager.addDependant('media3', 'layout2');

      expect(manager.isMediaReferenced('media1')).toBe(true);
      expect(manager.isMediaReferenced('media2')).toBe(true);
      expect(manager.isMediaReferenced('media3')).toBe(true);
    });

    it('should return false for unreferenced media', () => {
      expect(manager.isMediaReferenced('nonexistent')).toBe(false);
    });

    it('should handle numeric IDs by converting to strings', () => {
      manager.addDependant(42, 100);

      expect(manager.isMediaReferenced(42)).toBe(true);
      expect(manager.isMediaReferenced('42')).toBe(true);
    });

    it('should remove layout dependants and return orphaned media', () => {
      manager.addDependant('media1', 'layout1');
      manager.addDependant('media2', 'layout1');
      manager.addDependant('media3', 'layout1');
      manager.addDependant('media3', 'layout2'); // media3 is shared

      const orphaned = manager.removeLayoutDependants('layout1');

      // media1 and media2 are orphaned (only referenced by layout1)
      expect(orphaned).toContain('media1');
      expect(orphaned).toContain('media2');
      // media3 is NOT orphaned (still referenced by layout2)
      expect(orphaned).not.toContain('media3');
      expect(manager.isMediaReferenced('media3')).toBe(true);
    });

    it('should return empty array when layout has no dependants', () => {
      const orphaned = manager.removeLayoutDependants('nonexistent');

      expect(orphaned).toEqual([]);
    });

    it('should remove media from dependants map when orphaned', () => {
      manager.addDependant('media1', 'layout1');

      const orphaned = manager.removeLayoutDependants('layout1');

      expect(orphaned).toContain('media1');
      expect(manager.isMediaReferenced('media1')).toBe(false);
    });

    it('should not affect other layouts when removing one', () => {
      manager.addDependant('media1', 'layout1');
      manager.addDependant('media2', 'layout2');

      manager.removeLayoutDependants('layout1');

      expect(manager.isMediaReferenced('media1')).toBe(false);
      expect(manager.isMediaReferenced('media2')).toBe(true);
    });

    it('should handle removing same layout twice', () => {
      manager.addDependant('media1', 'layout1');

      const orphaned1 = manager.removeLayoutDependants('layout1');
      const orphaned2 = manager.removeLayoutDependants('layout1');

      expect(orphaned1).toContain('media1');
      expect(orphaned2).toEqual([]);
    });
  });

  describe('clearAll()', () => {
    it('should clear dependants', async () => {
      manager.addDependant('media1', 'layout1');
      manager.addDependant('media2', 'layout2');

      await manager.clearAll();

      expect(manager.isMediaReferenced('media1')).toBe(false);
      expect(manager.isMediaReferenced('media2')).toBe(false);
      expect(manager.dependants.size).toBe(0);
    });
  });
});
