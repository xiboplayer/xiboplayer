/**
 * CacheAnalyzer Tests
 *
 * Tests for stale media detection, storage health reporting, and eviction logic.
 * Mock follows the CacheProxy interface (getAllFiles, deleteFiles).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CacheAnalyzer, formatBytes } from './cache-analyzer.js';

describe('CacheAnalyzer', () => {
  let analyzer;
  let mockCache;

  beforeEach(() => {
    // Mock CacheProxy with in-memory file store
    const files = new Map();

    mockCache = {
      getAllFiles: vi.fn(async () => [...files.values()]),
      deleteFiles: vi.fn(async (filesToDelete) => ({
        deleted: filesToDelete.length,
        total: filesToDelete.length,
      })),
      // Helper to add test files
      _files: files,
      _addFile(record) {
        files.set(record.id, record);
      },
    };

    analyzer = new CacheAnalyzer(mockCache);
  });

  describe('formatBytes', () => {
    it('should format bytes correctly', () => {
      expect(formatBytes(0)).toBe('0 B');
      expect(formatBytes(1024)).toBe('1.0 KB');
      expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
      expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB');
      expect(formatBytes(Infinity)).toBe('∞');
    });
  });

  describe('analyze', () => {
    it('should categorize required vs orphaned files', async () => {
      mockCache._addFile({ id: '1', type: 'media', size: 1000, cachedAt: 100 });
      mockCache._addFile({ id: '2', type: 'media', size: 2000, cachedAt: 200 });
      mockCache._addFile({ id: '3', type: 'layout', size: 500, cachedAt: 300 });

      const requiredFiles = [
        { id: '1', type: 'media' },
        { id: '3', type: 'layout' },
      ];

      const report = await analyzer.analyze(requiredFiles);

      expect(report.files.required).toBe(2);
      expect(report.files.orphaned).toBe(1);
      expect(report.files.total).toBe(3);
      expect(report.orphaned).toHaveLength(1);
      expect(report.orphaned[0].id).toBe('2');
      expect(report.orphanedSize).toBe(2000);
    });

    it('should report zero orphaned when all files are required', async () => {
      mockCache._addFile({ id: '1', type: 'media', size: 1000, cachedAt: 100 });
      mockCache._addFile({ id: '2', type: 'media', size: 2000, cachedAt: 200 });

      const requiredFiles = [
        { id: '1', type: 'media' },
        { id: '2', type: 'media' },
      ];

      const report = await analyzer.analyze(requiredFiles);

      expect(report.files.required).toBe(2);
      expect(report.files.orphaned).toBe(0);
      expect(report.orphaned).toHaveLength(0);
      expect(report.orphanedSize).toBe(0);
      expect(report.evicted).toHaveLength(0);
    });

    it('should handle empty cache', async () => {
      const report = await analyzer.analyze([{ id: '1', type: 'media' }]);

      expect(report.files.required).toBe(0);
      expect(report.files.orphaned).toBe(0);
      expect(report.files.total).toBe(0);
    });

    it('should handle empty required files list', async () => {
      mockCache._addFile({ id: '1', type: 'media', size: 5000, cachedAt: 100 });

      const report = await analyzer.analyze([]);

      expect(report.files.required).toBe(0);
      expect(report.files.orphaned).toBe(1);
      expect(report.orphanedSize).toBe(5000);
    });

    it('should sort orphaned files oldest first', async () => {
      mockCache._addFile({ id: 'new', type: 'media', size: 100, cachedAt: 3000 });
      mockCache._addFile({ id: 'old', type: 'media', size: 100, cachedAt: 1000 });
      mockCache._addFile({ id: 'mid', type: 'media', size: 100, cachedAt: 2000 });

      const report = await analyzer.analyze([]);

      expect(report.orphaned[0].id).toBe('old');
      expect(report.orphaned[1].id).toBe('mid');
      expect(report.orphaned[2].id).toBe('new');
    });

    it('should compare IDs as strings for mixed types', async () => {
      mockCache._addFile({ id: '42', type: 'media', size: 100, cachedAt: 100 });

      // RequiredFiles may use numeric IDs
      const report = await analyzer.analyze([{ id: 42, type: 'media' }]);

      expect(report.files.required).toBe(1);
      expect(report.files.orphaned).toBe(0);
    });

    it('should not evict when storage is under threshold', async () => {
      mockCache._addFile({ id: '1', type: 'media', size: 100, cachedAt: 100 });

      // Mock storage at 50% (under default 80% threshold)
      vi.stubGlobal('navigator', {
        storage: {
          estimate: vi.fn(async () => ({ usage: 500, quota: 1000 })),
        },
      });

      const report = await analyzer.analyze([]);

      expect(report.storage.percent).toBe(50);
      expect(report.evicted).toHaveLength(0);

      vi.unstubAllGlobals();
    });

    it('should include storage info in report', async () => {
      vi.stubGlobal('navigator', {
        storage: {
          estimate: vi.fn(async () => ({ usage: 2_000_000_000, quota: 5_000_000_000 })),
        },
      });

      const report = await analyzer.analyze([]);

      expect(report.storage.usage).toBe(2_000_000_000);
      expect(report.storage.quota).toBe(5_000_000_000);
      expect(report.storage.percent).toBe(40);
      expect(report.threshold).toBe(80);

      vi.unstubAllGlobals();
    });

    it('should handle missing storage API gracefully', async () => {
      // No navigator.storage
      vi.stubGlobal('navigator', {});

      const report = await analyzer.analyze([]);

      expect(report.storage.usage).toBe(0);
      expect(report.storage.quota).toBe(Infinity);
      expect(report.storage.percent).toBe(0);
      expect(report.evicted).toHaveLength(0);

      vi.unstubAllGlobals();
    });

    it('should treat widget HTML as required when parent layout is required', async () => {
      mockCache._addFile({ id: '470', type: 'layout', size: 500, cachedAt: 100 });
      mockCache._addFile({ id: '470/213/182', type: 'widget', size: 0, cachedAt: 0 });
      mockCache._addFile({ id: '470/215/184', type: 'widget', size: 0, cachedAt: 0 });
      mockCache._addFile({ id: '99/10/5', type: 'widget', size: 0, cachedAt: 0 });

      const report = await analyzer.analyze([{ id: '470', type: 'layout' }]);

      // Layout 470 + its 2 widgets = 3 required; widget for layout 99 = orphaned
      expect(report.files.required).toBe(3);
      expect(report.files.orphaned).toBe(1);
      expect(report.orphaned[0].id).toBe('99/10/5');
    });

    it('should handle files with missing size or cachedAt', async () => {
      mockCache._addFile({ id: '1', type: 'media' }); // no size, no cachedAt

      const report = await analyzer.analyze([]);

      expect(report.files.orphaned).toBe(1);
      expect(report.orphanedSize).toBe(0);
      expect(report.orphaned[0].size).toBe(0);
      expect(report.orphaned[0].cachedAt).toBe(0);
    });
  });

  describe('eviction', () => {
    it('should evict orphaned files when storage exceeds threshold', async () => {
      mockCache._addFile({ id: 'old', type: 'media', size: 500, cachedAt: 1000 });
      mockCache._addFile({ id: 'newer', type: 'media', size: 300, cachedAt: 2000 });
      mockCache._addFile({ id: 'required', type: 'media', size: 1000, cachedAt: 500 });

      // 90% usage — exceeds 80% threshold
      vi.stubGlobal('navigator', {
        storage: {
          estimate: vi.fn(async () => ({ usage: 9000, quota: 10000 })),
        },
      });

      const report = await analyzer.analyze([{ id: 'required', type: 'media' }]);

      expect(report.evicted.length).toBeGreaterThan(0);
      // Should evict oldest first
      expect(report.evicted[0].id).toBe('old');
      // deleteFiles should be called on the cache proxy
      expect(mockCache.deleteFiles).toHaveBeenCalled();

      vi.unstubAllGlobals();
    });

    it('should stop evicting once enough space is freed', async () => {
      // 3 orphaned files, but only need to free a small amount
      mockCache._addFile({ id: 'a', type: 'media', size: 2000, cachedAt: 1000 });
      mockCache._addFile({ id: 'b', type: 'media', size: 2000, cachedAt: 2000 });
      mockCache._addFile({ id: 'c', type: 'media', size: 2000, cachedAt: 3000 });

      // 85% usage, threshold 80% → need to free 5% of 10000 = 500 bytes
      // First file (2000 bytes) should be enough
      vi.stubGlobal('navigator', {
        storage: {
          estimate: vi.fn(async () => ({ usage: 8500, quota: 10000 })),
        },
      });

      const report = await analyzer.analyze([]);

      expect(report.evicted).toHaveLength(1);
      expect(report.evicted[0].id).toBe('a'); // oldest

      vi.unstubAllGlobals();
    });

    it('should never evict required files', async () => {
      mockCache._addFile({ id: 'keep', type: 'media', size: 5000, cachedAt: 100 });
      mockCache._addFile({ id: 'orphan', type: 'media', size: 100, cachedAt: 200 });

      vi.stubGlobal('navigator', {
        storage: {
          estimate: vi.fn(async () => ({ usage: 9500, quota: 10000 })),
        },
      });

      const report = await analyzer.analyze([{ id: 'keep', type: 'media' }]);

      // Only the orphan can be evicted, even though 'keep' is older and larger
      const evictedIds = report.evicted.map(f => f.id);
      expect(evictedIds).not.toContain('keep');

      vi.unstubAllGlobals();
    });

    it('should respect custom threshold', async () => {
      analyzer = new CacheAnalyzer(mockCache, { threshold: 50 });

      mockCache._addFile({ id: '1', type: 'media', size: 100, cachedAt: 100 });

      // 60% usage — under 80% but over 50%
      vi.stubGlobal('navigator', {
        storage: {
          estimate: vi.fn(async () => ({ usage: 6000, quota: 10000 })),
        },
      });

      const report = await analyzer.analyze([]);

      expect(report.threshold).toBe(50);
      expect(report.evicted.length).toBeGreaterThan(0);

      vi.unstubAllGlobals();
    });
  });
});
