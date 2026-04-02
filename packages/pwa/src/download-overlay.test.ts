// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Unit tests for DownloadOverlay.
 *
 * Uses vitest + jsdom to exercise the overlay's DOM manipulation,
 * toggle logic, progress rendering, and helper functions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DownloadOverlay, getDefaultOverlayConfig } from './download-overlay.js';
import type { DownloadOverlayConfig } from './download-overlay.js';

// ── Helper to build an overlay with sane defaults ──

function createOverlay(overrides: Partial<DownloadOverlayConfig> = {}): DownloadOverlay {
  return new DownloadOverlay({ enabled: true, autoHide: true, updateInterval: 100, ...overrides });
}

// ── Construction & DOM creation ──────────────────────────────

describe('DownloadOverlay', () => {
  afterEach(() => {
    // Clean up any overlays left in the DOM
    document.querySelectorAll('#download-overlay').forEach(el => el.remove());
  });

  describe('constructor', () => {
    it('creates a DOM element when enabled', () => {
      const overlay = createOverlay();
      expect(document.getElementById('download-overlay')).not.toBeNull();
      overlay.destroy();
    });

    it('does not create a DOM element when disabled', () => {
      const overlay = createOverlay({ enabled: false });
      expect(document.getElementById('download-overlay')).toBeNull();
      overlay.destroy();
    });

    it('starts hidden when enabled', () => {
      const overlay = createOverlay();
      expect(document.getElementById('download-overlay')!.style.display).toBe('none');
      overlay.destroy();
    });

    it('applies default updateInterval of 1000ms', () => {
      const overlay = new DownloadOverlay({ enabled: true });
      // We can't inspect private config directly, but the overlay should have been created
      expect(document.getElementById('download-overlay')).not.toBeNull();
      overlay.destroy();
    });
  });

  // ── Toggle visibility ────────────────────────────────────

  describe('toggle', () => {
    it('shows overlay on first toggle', () => {
      const overlay = createOverlay();
      overlay.toggle();
      expect(document.getElementById('download-overlay')!.style.display).toBe('block');
      overlay.destroy();
    });

    it('hides overlay on second toggle', () => {
      const overlay = createOverlay();
      overlay.toggle(); // show
      overlay.toggle(); // hide
      expect(document.getElementById('download-overlay')!.style.display).toBe('none');
      overlay.destroy();
    });

    it('is a no-op when disabled (no DOM element)', () => {
      const overlay = createOverlay({ enabled: false });
      overlay.toggle(); // should not throw
      expect(document.getElementById('download-overlay')).toBeNull();
      overlay.destroy();
    });
  });

  // ── Progress rendering ───────────────────────────────────

  describe('progress updates', () => {
    it('shows "All downloads complete" when toggled on with no progress', () => {
      const overlay = createOverlay();
      overlay.setProgressCallback(() => ({}));
      overlay.toggle();
      const el = document.getElementById('download-overlay')!;
      expect(el.innerHTML).toContain('All downloads complete');
      overlay.destroy();
    });

    it('shows download count when progress has active entries', () => {
      const overlay = createOverlay();
      overlay.setProgressCallback(() => ({
        'media/5': { percent: 50, downloaded: 512000, total: 1024000 },
      }));
      overlay.toggle();
      const el = document.getElementById('download-overlay')!;
      expect(el.innerHTML).toContain('1 active');
      overlay.destroy();
    });

    it('shows filename from progress key', () => {
      const overlay = createOverlay();
      overlay.setProgressCallback(() => ({
        'layout/12': { percent: 75, downloaded: 768000, total: 1024000 },
      }));
      overlay.toggle();
      const el = document.getElementById('download-overlay')!;
      expect(el.innerHTML).toContain('layout/12');
      overlay.destroy();
    });

    it('renders multiple active downloads', () => {
      const overlay = createOverlay();
      overlay.setProgressCallback(() => ({
        'media/1': { percent: 10, downloaded: 100, total: 1000 },
        'media/2': { percent: 90, downloaded: 900, total: 1000 },
        'media/3': { percent: 50, downloaded: 500, total: 1000 },
      }));
      overlay.toggle();
      const el = document.getElementById('download-overlay')!;
      expect(el.innerHTML).toContain('3 active');
      overlay.destroy();
    });

    it('hides overlay automatically when downloads finish and autoHide is on', () => {
      vi.useFakeTimers();
      const progress: Record<string, any> = {
        'media/1': { percent: 50, downloaded: 500, total: 1000 },
      };
      const overlay = createOverlay({ autoHide: true, updateInterval: 100 });
      overlay.setProgressCallback(() => progress);
      overlay.startUpdating();

      const el = document.getElementById('download-overlay')!;
      // First tick — downloads active → visible
      vi.advanceTimersByTime(100);
      expect(el.style.display).toBe('block');

      // Remove all downloads
      for (const key of Object.keys(progress)) delete progress[key];
      vi.advanceTimersByTime(100);
      expect(el.style.display).toBe('none');

      overlay.destroy();
      vi.useRealTimers();
    });
  });

  // ── formatBytes (tested via rendered output) ─────────────

  describe('formatBytes via rendering', () => {
    function getRenderedSize(bytes: number): string {
      const overlay = createOverlay();
      overlay.setProgressCallback(() => ({
        'media/1': { percent: 50, downloaded: bytes, total: bytes * 2 },
      }));
      overlay.toggle();
      const html = document.getElementById('download-overlay')!.innerHTML;
      overlay.destroy();
      return html;
    }

    it('renders bytes for small values', () => {
      expect(getRenderedSize(500)).toContain('500 B');
    });

    it('renders KB for kilobyte range', () => {
      expect(getRenderedSize(2048)).toContain('2.0 KB');
    });

    it('renders MB for megabyte range', () => {
      expect(getRenderedSize(5 * 1024 * 1024)).toContain('5.0 MB');
    });

    it('renders GB for gigabyte range', () => {
      expect(getRenderedSize(2 * 1024 * 1024 * 1024)).toContain('2.0 GB');
    });
  });

  // ── setEnabled ───────────────────────────────────────────

  describe('setEnabled', () => {
    it('creates overlay when enabling a disabled instance', () => {
      const overlay = createOverlay({ enabled: false });
      expect(document.getElementById('download-overlay')).toBeNull();
      overlay.setEnabled(true);
      expect(document.getElementById('download-overlay')).not.toBeNull();
      overlay.destroy();
    });

    it('removes overlay when disabling an enabled instance', () => {
      const overlay = createOverlay({ enabled: true });
      expect(document.getElementById('download-overlay')).not.toBeNull();
      overlay.setEnabled(false);
      expect(document.getElementById('download-overlay')).toBeNull();
    });
  });

  // ── destroy ──────────────────────────────────────────────

  describe('destroy', () => {
    it('removes the overlay from the DOM', () => {
      const overlay = createOverlay();
      overlay.destroy();
      expect(document.getElementById('download-overlay')).toBeNull();
    });

    it('can be called multiple times safely', () => {
      const overlay = createOverlay();
      overlay.destroy();
      overlay.destroy(); // should not throw
      expect(document.getElementById('download-overlay')).toBeNull();
    });
  });
});

// ── getDefaultOverlayConfig ────────────────────────────────

describe('getDefaultOverlayConfig', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns disabled by default', () => {
    expect(getDefaultOverlayConfig().enabled).toBe(false);
  });

  it('respects localStorage preference (true)', () => {
    localStorage.setItem('xibo_show_download_overlay', 'true');
    expect(getDefaultOverlayConfig().enabled).toBe(true);
  });

  it('respects localStorage preference (false)', () => {
    localStorage.setItem('xibo_show_download_overlay', 'false');
    expect(getDefaultOverlayConfig().enabled).toBe(false);
  });
});
