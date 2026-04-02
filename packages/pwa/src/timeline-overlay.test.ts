// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Unit tests for TimelineOverlay.
 *
 * Tests visibility toggling, timeline entry rendering, current layout
 * highlighting, duration formatting, and the isTimelineVisible() helper.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TimelineOverlay, isTimelineVisible } from './timeline-overlay.js';

// ── Helpers ─────────────────────────────────────────────────

function makeEntry(overrides: Partial<{
  layoutFile: string;
  startTime: Date;
  endTime: Date;
  duration: number;
  isDefault: boolean;
  hidden: { file: string; priority: number }[];
  missingMedia: string[];
}> = {}) {
  const now = new Date();
  return {
    layoutFile: '42.xlf',
    startTime: now,
    endTime: new Date(now.getTime() + 30000),
    duration: 30,
    isDefault: false,
    ...overrides,
  };
}

function getOverlayEl(): HTMLElement | null {
  return document.getElementById('timeline-overlay');
}

// ── Tests ───────────────────────────────────────────────────

describe('TimelineOverlay', () => {
  afterEach(() => {
    document.querySelectorAll('#timeline-overlay').forEach(el => el.remove());
    vi.useRealTimers();
  });

  // ── Construction ──────────────────────────────────────────

  describe('constructor', () => {
    it('creates the overlay DOM element', () => {
      vi.useFakeTimers();
      const overlay = new TimelineOverlay();
      expect(getOverlayEl()).not.toBeNull();
      overlay.destroy();
    });

    it('starts hidden by default', () => {
      vi.useFakeTimers();
      const overlay = new TimelineOverlay();
      expect(getOverlayEl()!.style.display).toBe('none');
      overlay.destroy();
    });

    it('starts visible when visible=true', () => {
      vi.useFakeTimers();
      const overlay = new TimelineOverlay(true);
      expect(getOverlayEl()!.style.display).not.toBe('none');
      overlay.destroy();
    });
  });

  // ── Toggle ────────────────────────────────────────────────

  describe('toggle', () => {
    it('shows overlay on first toggle', () => {
      vi.useFakeTimers();
      const overlay = new TimelineOverlay(false);
      overlay.toggle();
      expect(getOverlayEl()!.style.display).toBe('block');
      overlay.destroy();
    });

    it('hides overlay on second toggle', () => {
      vi.useFakeTimers();
      const overlay = new TimelineOverlay(false);
      overlay.toggle(); // show
      overlay.toggle(); // hide
      expect(getOverlayEl()!.style.display).toBe('none');
      overlay.destroy();
    });

    it('persists preference to localStorage', () => {
      vi.useFakeTimers();
      localStorage.removeItem('xibo_show_timeline_overlay');
      const overlay = new TimelineOverlay(false);
      overlay.toggle();
      expect(localStorage.getItem('xibo_show_timeline_overlay')).toBe('true');
      overlay.toggle();
      expect(localStorage.getItem('xibo_show_timeline_overlay')).toBe('false');
      overlay.destroy();
    });
  });

  // ── Rendering with no data ────────────────────────────────

  describe('render with no data', () => {
    it('shows "no upcoming layouts" when empty', () => {
      vi.useFakeTimers();
      const overlay = new TimelineOverlay(true);
      // Constructor does not call render() immediately; advance past the 5s refresh interval
      vi.advanceTimersByTime(5000);
      const el = getOverlayEl()!;
      expect(el.innerHTML).toContain('no upcoming layouts');
      overlay.destroy();
    });
  });

  // ── update() with timeline entries ────────────────────────

  describe('update', () => {
    it('renders current layout ID', () => {
      vi.useFakeTimers();
      const overlay = new TimelineOverlay(true);
      overlay.update([makeEntry({ layoutFile: '42.xlf', duration: 30 })], 42, 30);
      const html = getOverlayEl()!.innerHTML;
      expect(html).toContain('#42');
      overlay.destroy();
    });

    it('renders upcoming layout entries', () => {
      vi.useFakeTimers();
      const overlay = new TimelineOverlay(true);
      const entries = [
        makeEntry({ layoutFile: '42.xlf', duration: 30 }),
        makeEntry({ layoutFile: '99.xlf', duration: 60 }),
      ];
      overlay.update(entries, 42, 30);
      const html = getOverlayEl()!.innerHTML;
      // Current is #42, upcoming should include #99
      expect(html).toContain('#99');
      overlay.destroy();
    });

    it('shows scheduled count in header', () => {
      vi.useFakeTimers();
      const overlay = new TimelineOverlay(true);
      const entries = [
        makeEntry({ layoutFile: '42.xlf', duration: 30 }),
        makeEntry({ layoutFile: '99.xlf', duration: 60 }),
        makeEntry({ layoutFile: '7.xlf', duration: 15 }),
      ];
      overlay.update(entries, 42, 30);
      const html = getOverlayEl()!.innerHTML;
      // 1 current + 2 upcoming = 3 scheduled
      expect(html).toContain('3 scheduled');
      overlay.destroy();
    });

    it('marks default layouts with [def]', () => {
      vi.useFakeTimers();
      const overlay = new TimelineOverlay(true);
      overlay.update(
        [makeEntry({ layoutFile: '10.xlf', duration: 60, isDefault: true })],
        null,
      );
      const html = getOverlayEl()!.innerHTML;
      expect(html).toContain('[def]');
      overlay.destroy();
    });

    it('shows missing media warning', () => {
      vi.useFakeTimers();
      const overlay = new TimelineOverlay(true);
      overlay.update(
        [makeEntry({ layoutFile: '10.xlf', duration: 60, missingMedia: ['bg.jpg', 'logo.png'] })],
        null,
      );
      const html = getOverlayEl()!.innerHTML;
      // Should show the warning count
      expect(html).toContain('2');
      overlay.destroy();
    });

    it('shows hidden layout count', () => {
      vi.useFakeTimers();
      const overlay = new TimelineOverlay(true);
      overlay.update(
        [makeEntry({
          layoutFile: '10.xlf',
          duration: 60,
          hidden: [{ file: '20.xlf', priority: 1 }, { file: '30.xlf', priority: 2 }],
        })],
        null,
      );
      const html = getOverlayEl()!.innerHTML;
      expect(html).toContain('+2');
      overlay.destroy();
    });

    it('skips rendering when overlay is hidden', () => {
      vi.useFakeTimers();
      const overlay = new TimelineOverlay(false); // hidden
      overlay.update([makeEntry()], 42, 30);
      // Content should NOT be updated since overlay is hidden
      const html = getOverlayEl()!.innerHTML;
      expect(html).toBe('');
      overlay.destroy();
    });
  });

  // ── setOffline ────────────────────────────────────────────

  describe('setOffline', () => {
    it('shows OFFLINE badge when offline', () => {
      vi.useFakeTimers();
      const overlay = new TimelineOverlay(true);
      overlay.update([makeEntry({ layoutFile: '42.xlf', duration: 30 })], 42, 30);
      overlay.setOffline(true);
      const html = getOverlayEl()!.innerHTML;
      expect(html).toContain('OFFLINE');
      overlay.destroy();
    });

    it('removes OFFLINE badge when back online', () => {
      vi.useFakeTimers();
      const overlay = new TimelineOverlay(true);
      overlay.update([makeEntry({ layoutFile: '42.xlf', duration: 30 })], 42, 30);
      overlay.setOffline(true);
      overlay.setOffline(false);
      const html = getOverlayEl()!.innerHTML;
      expect(html).not.toContain('OFFLINE');
      overlay.destroy();
    });
  });

  // ── Click-to-skip callback ────────────────────────────────

  describe('click-to-skip', () => {
    it('fires onLayoutClick when a non-current layout is clicked', () => {
      vi.useFakeTimers();
      const clickSpy = vi.fn();
      const overlay = new TimelineOverlay(true, clickSpy);
      const entries = [
        makeEntry({ layoutFile: '42.xlf', duration: 30 }),
        makeEntry({ layoutFile: '99.xlf', duration: 60 }),
      ];
      overlay.update(entries, 42, 30);

      // Find the upcoming layout element with data-layout-id="99"
      const el = getOverlayEl()!.querySelector('[data-layout-id="99"]') as HTMLElement;
      expect(el).not.toBeNull();
      el.click();
      expect(clickSpy).toHaveBeenCalledWith(99);
      overlay.destroy();
    });

    it('does not fire onLayoutClick for the current layout', () => {
      vi.useFakeTimers();
      const clickSpy = vi.fn();
      const overlay = new TimelineOverlay(true, clickSpy);
      overlay.update([makeEntry({ layoutFile: '42.xlf', duration: 30 })], 42, 30);

      const el = getOverlayEl()!.querySelector('[data-layout-id="42"]') as HTMLElement;
      expect(el).not.toBeNull();
      el.click();
      expect(clickSpy).not.toHaveBeenCalled();
      overlay.destroy();
    });
  });

  // ── destroy ───────────────────────────────────────────────

  describe('destroy', () => {
    it('removes overlay from DOM and clears timer', () => {
      vi.useFakeTimers();
      const overlay = new TimelineOverlay(true);
      overlay.destroy();
      expect(getOverlayEl()).toBeNull();
    });
  });
});

// ── formatDuration (tested via reimplementation) ────────────

describe('formatDuration (pure logic)', () => {
  function formatDuration(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return m > 0 ? `${m}m ${s.toString().padStart(2, '0')}s` : `${s}s`;
  }

  it('formats seconds only', () => {
    expect(formatDuration(45)).toBe('45s');
  });

  it('formats zero seconds', () => {
    expect(formatDuration(0)).toBe('0s');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(90)).toBe('1m 30s');
  });

  it('pads seconds with leading zero', () => {
    expect(formatDuration(65)).toBe('1m 05s');
  });

  it('handles exact minutes', () => {
    expect(formatDuration(120)).toBe('2m 00s');
  });
});

// ── isTimelineVisible ──────────────────────────────────────

describe('isTimelineVisible', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns false by default', () => {
    expect(isTimelineVisible()).toBe(false);
  });

  it('respects localStorage true', () => {
    localStorage.setItem('xibo_show_timeline_overlay', 'true');
    expect(isTimelineVisible()).toBe(true);
  });

  it('respects localStorage false', () => {
    localStorage.setItem('xibo_show_timeline_overlay', 'false');
    expect(isTimelineVisible()).toBe(false);
  });
});
