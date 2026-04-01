// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, beforeEach } from 'vitest';
import { LayoutBlacklist } from './layout-blacklist.js';

describe('LayoutBlacklist', () => {
  let bl;

  beforeEach(() => {
    bl = new LayoutBlacklist(3);
  });

  describe('recordFailure', () => {
    it('tracks failure count', () => {
      const result = bl.recordFailure(1, 'render error');
      expect(result.failures).toBe(1);
      expect(result.blacklisted).toBe(false);
    });

    it('blacklists after threshold consecutive failures', () => {
      bl.recordFailure(1, 'error');
      bl.recordFailure(1, 'error');
      const result = bl.recordFailure(1, 'error');
      expect(result.blacklisted).toBe(true);
      expect(result.failures).toBe(3);
    });

    it('does not blacklist below threshold', () => {
      bl.recordFailure(1, 'error');
      bl.recordFailure(1, 'error');
      expect(bl.isBlacklisted(1)).toBe(false);
    });

    it('tracks different layouts independently', () => {
      bl.recordFailure(1, 'error');
      bl.recordFailure(1, 'error');
      bl.recordFailure(1, 'error');
      bl.recordFailure(2, 'error');
      expect(bl.isBlacklisted(1)).toBe(true);
      expect(bl.isBlacklisted(2)).toBe(false);
    });

    it('handles string layout IDs by converting to number', () => {
      bl.recordFailure('42', 'error');
      bl.recordFailure('42', 'error');
      bl.recordFailure('42', 'error');
      expect(bl.isBlacklisted(42)).toBe(true);
    });
  });

  describe('recordSuccess', () => {
    it('removes layout from blacklist', () => {
      bl.recordFailure(1, 'error');
      bl.recordFailure(1, 'error');
      bl.recordFailure(1, 'error');
      expect(bl.isBlacklisted(1)).toBe(true);

      const wasBlacklisted = bl.recordSuccess(1);
      expect(wasBlacklisted).toBe(true);
      expect(bl.isBlacklisted(1)).toBe(false);
    });

    it('returns false for never-failed layout', () => {
      expect(bl.recordSuccess(999)).toBe(false);
    });

    it('resets failure counter', () => {
      bl.recordFailure(1, 'error');
      bl.recordFailure(1, 'error');
      bl.recordSuccess(1);

      // Failures should restart from 0
      const result = bl.recordFailure(1, 'new error');
      expect(result.failures).toBe(1);
      expect(result.blacklisted).toBe(false);
    });
  });

  describe('getBlacklistedIds', () => {
    it('returns empty array when no blacklisted layouts', () => {
      expect(bl.getBlacklistedIds()).toEqual([]);
    });

    it('returns only blacklisted layouts', () => {
      for (let i = 0; i < 3; i++) bl.recordFailure(10, 'error');
      for (let i = 0; i < 3; i++) bl.recordFailure(20, 'error');
      bl.recordFailure(30, 'error'); // only 1 failure, not blacklisted

      const ids = bl.getBlacklistedIds();
      expect(ids).toContain(10);
      expect(ids).toContain(20);
      expect(ids).not.toContain(30);
    });
  });

  describe('reset', () => {
    it('clears all entries', () => {
      for (let i = 0; i < 3; i++) bl.recordFailure(1, 'error');
      expect(bl.size).toBe(1);

      const cleared = bl.reset();
      expect(cleared).toBe(1);
      expect(bl.size).toBe(0);
      expect(bl.isBlacklisted(1)).toBe(false);
    });

    it('returns 0 when already empty', () => {
      expect(bl.reset()).toBe(0);
    });
  });

  describe('custom threshold', () => {
    it('respects threshold=1', () => {
      const strict = new LayoutBlacklist(1);
      const result = strict.recordFailure(1, 'error');
      expect(result.blacklisted).toBe(true);
    });

    it('respects threshold=5', () => {
      const lenient = new LayoutBlacklist(5);
      for (let i = 0; i < 4; i++) lenient.recordFailure(1, 'error');
      expect(lenient.isBlacklisted(1)).toBe(false);
      lenient.recordFailure(1, 'error');
      expect(lenient.isBlacklisted(1)).toBe(true);
    });
  });
});
