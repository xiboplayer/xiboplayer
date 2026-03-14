// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
import { describe, it, expect } from 'vitest';
import { computeStagger } from './choreography.js';

const opts = (choreography, position, totalDisplays = 4, staggerMs = 150) =>
  ({ choreography, position, totalDisplays, staggerMs });

describe('computeStagger', () => {
  describe('simultaneous (default)', () => {
    it('returns 0 for simultaneous', () => {
      expect(computeStagger(opts('simultaneous', 0))).toBe(0);
      expect(computeStagger(opts('simultaneous', 3))).toBe(0);
    });

    it('returns 0 when no choreography', () => {
      expect(computeStagger(opts(null, 2))).toBe(0);
      expect(computeStagger(opts(undefined, 2))).toBe(0);
      expect(computeStagger(opts('', 2))).toBe(0);
    });

    it('returns 0 for single display', () => {
      expect(computeStagger(opts('wave-right', 0, 1, 150))).toBe(0);
    });

    it('returns 0 when staggerMs is 0', () => {
      expect(computeStagger(opts('wave-right', 2, 4, 0))).toBe(0);
    });
  });

  describe('wave-right', () => {
    it('staggers left to right', () => {
      expect(computeStagger(opts('wave-right', 0))).toBe(0);
      expect(computeStagger(opts('wave-right', 1))).toBe(150);
      expect(computeStagger(opts('wave-right', 2))).toBe(300);
      expect(computeStagger(opts('wave-right', 3))).toBe(450);
    });
  });

  describe('wave-left', () => {
    it('staggers right to left', () => {
      expect(computeStagger(opts('wave-left', 0))).toBe(450);
      expect(computeStagger(opts('wave-left', 1))).toBe(300);
      expect(computeStagger(opts('wave-left', 2))).toBe(150);
      expect(computeStagger(opts('wave-left', 3))).toBe(0);
    });
  });

  describe('center-out', () => {
    it('explodes from center (even count)', () => {
      // 4 displays: center = 1.5
      // pos 0: |0-1.5| = 1.5 → round(1.5)*150 = 2*150 = 300
      // pos 1: |1-1.5| = 0.5 → round(0.5)*150 = 1*150 = 150  (JS rounds .5 up)
      // pos 2: |2-1.5| = 0.5 → round(0.5)*150 = 1*150 = 150
      // pos 3: |3-1.5| = 1.5 → round(1.5)*150 = 2*150 = 300
      expect(computeStagger(opts('center-out', 0))).toBe(300);
      expect(computeStagger(opts('center-out', 1))).toBe(150);
      expect(computeStagger(opts('center-out', 2))).toBe(150);
      expect(computeStagger(opts('center-out', 3))).toBe(300);
    });

    it('explodes from center (odd count)', () => {
      // 5 displays: center = 2
      // pos 0: |0-2| = 2 → 2*100 = 200
      // pos 1: |1-2| = 1 → 1*100 = 100
      // pos 2: |2-2| = 0 → 0*100 = 0
      // pos 3: |3-2| = 1 → 1*100 = 100
      // pos 4: |4-2| = 2 → 2*100 = 200
      expect(computeStagger(opts('center-out', 0, 5, 100))).toBe(200);
      expect(computeStagger(opts('center-out', 1, 5, 100))).toBe(100);
      expect(computeStagger(opts('center-out', 2, 5, 100))).toBe(0);
      expect(computeStagger(opts('center-out', 3, 5, 100))).toBe(100);
      expect(computeStagger(opts('center-out', 4, 5, 100))).toBe(200);
    });
  });

  describe('outside-in', () => {
    it('implodes from edges (odd count)', () => {
      // 5 displays: center = 2, maxDist = 2
      // pos 0: (2 - |0-2|) = (2-2) = 0 → 0*100 = 0
      // pos 1: (2 - |1-2|) = (2-1) = 1 → 1*100 = 100
      // pos 2: (2 - |2-2|) = (2-0) = 2 → 2*100 = 200
      // pos 3: (2 - |3-2|) = (2-1) = 1 → 1*100 = 100
      // pos 4: (2 - |4-2|) = (2-2) = 0 → 0*100 = 0
      expect(computeStagger(opts('outside-in', 0, 5, 100))).toBe(0);
      expect(computeStagger(opts('outside-in', 1, 5, 100))).toBe(100);
      expect(computeStagger(opts('outside-in', 2, 5, 100))).toBe(200);
      expect(computeStagger(opts('outside-in', 3, 5, 100))).toBe(100);
      expect(computeStagger(opts('outside-in', 4, 5, 100))).toBe(0);
    });
  });

  describe('random', () => {
    it('returns a value within range', () => {
      const delay = computeStagger(opts('random', 2));
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(3 * 150); // last * staggerMs
    });
  });

  describe('unknown choreography', () => {
    it('returns 0 for unrecognized name', () => {
      expect(computeStagger(opts('zigzag', 2))).toBe(0);
    });
  });
});
