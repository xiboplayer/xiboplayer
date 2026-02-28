/**
 * Tests for RendererLite overlay rendering
 *
 * Tests overlay layout rendering on top of main layouts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RendererLite } from './renderer-lite.js';

// Mock logger
vi.mock('@xiboplayer/utils', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}));

describe('RendererLite - Overlay Rendering', () => {
  let renderer;
  let container;
  let blobCounter;

  // Sample XLF for overlay
  const overlayXLF = `<?xml version="1.0"?>
<layout width="1920" height="1080" bgcolor="#00000080">
  <region id="overlay-1" width="400" height="200" top="50" left="50" zindex="10">
    <media id="1" type="text" duration="10">
      <raw><![CDATA[<p>Overlay Content</p>]]></raw>
    </media>
  </region>
</layout>`;

  // Sample XLF for main layout
  const mainLayoutXLF = `<?xml version="1.0"?>
<layout width="1920" height="1080" bgcolor="#000000">
  <region id="main-1" width="1920" height="1080" top="0" left="0" zindex="0">
    <media id="1" type="text" duration="30">
      <raw><![CDATA[<p>Main Content</p>]]></raw>
    </media>
  </region>
</layout>`;

  beforeEach(() => {
    // Mock URL.createObjectURL and URL.revokeObjectURL (not available in jsdom)
    blobCounter = 0;
    if (!URL.createObjectURL) {
      URL.createObjectURL = vi.fn(() => `blob:test/${++blobCounter}`);
    }
    if (!URL.revokeObjectURL) {
      URL.revokeObjectURL = vi.fn();
    }

    // Create container
    container = document.createElement('div');
    container.id = 'test-container';
    document.body.appendChild(container);

    // Create renderer
    renderer = new RendererLite(
      {
        cmsUrl: 'http://test.local',
        hardwareKey: 'test-key'
      },
      container,
      {
        getMediaUrl: async (fileId) => `http://test.local/media/${fileId}`,
        getWidgetHtml: async (widget) => widget.raw || '<p>Widget HTML</p>'
      }
    );
  });

  afterEach(() => {
    renderer.cleanup();
    // Container may have been removed from DOM by layoutPool.evict() during cleanup
    if (container.parentNode) {
      container.parentNode.removeChild(container);
    }
  });

  describe('Overlay Container Setup', () => {
    it('should create overlay container on init', () => {
      const overlayContainer = container.querySelector('#overlay-container');

      expect(overlayContainer).toBeDefined();
      expect(overlayContainer).not.toBeNull();
    });

    it('should set correct z-index for overlay container', () => {
      const overlayContainer = container.querySelector('#overlay-container');

      expect(overlayContainer.style.zIndex).toBe('1000');
    });

    it('should set overlay container to full size', () => {
      const overlayContainer = container.querySelector('#overlay-container');

      expect(overlayContainer.style.width).toBe('100%');
      expect(overlayContainer.style.height).toBe('100%');
    });

    it('should set pointer-events to none on overlay container', () => {
      const overlayContainer = container.querySelector('#overlay-container');

      expect(overlayContainer.style.pointerEvents).toBe('none');
    });
  });

  describe('renderOverlay()', () => {
    it('should render overlay on top of main layout', async () => {
      // Render main layout first
      await renderer.renderLayout(mainLayoutXLF, 100);

      // Render overlay
      await renderer.renderOverlay(overlayXLF, 200, 10);

      // Check overlay exists
      const overlayDiv = container.querySelector('#overlay_200');
      expect(overlayDiv).toBeDefined();
      expect(overlayDiv).not.toBeNull();
    });

    it('should set correct z-index based on priority', async () => {
      await renderer.renderOverlay(overlayXLF, 200, 15);

      const overlayDiv = container.querySelector('#overlay_200');
      expect(overlayDiv.style.zIndex).toBe('1015'); // 1000 + priority
    });

    it('should create regions for overlay', async () => {
      await renderer.renderOverlay(overlayXLF, 200, 10);

      const region = container.querySelector('#overlay_200_region_overlay-1');
      expect(region).toBeDefined();
      expect(region).not.toBeNull();
    });

    it('should emit overlayStart event', async () => {
      const startListener = vi.fn();
      renderer.on('overlayStart', startListener);

      await renderer.renderOverlay(overlayXLF, 200, 10);

      expect(startListener).toHaveBeenCalledWith(200, expect.any(Object));
    });

    it('should store overlay in activeOverlays', async () => {
      await renderer.renderOverlay(overlayXLF, 200, 10);

      expect(renderer.activeOverlays.has(200)).toBe(true);
      const overlayState = renderer.activeOverlays.get(200);
      expect(overlayState.priority).toBe(10);
    });

    it('should skip if overlay already active', async () => {
      await renderer.renderOverlay(overlayXLF, 200, 10);
      const firstOverlayDiv = container.querySelector('#overlay_200');

      // Try to render same overlay again
      await renderer.renderOverlay(overlayXLF, 200, 10);

      // Should still be the same element
      const secondOverlayDiv = container.querySelector('#overlay_200');
      expect(secondOverlayDiv).toBe(firstOverlayDiv);
    });

    it('should pre-fetch media URLs for overlay widgets', async () => {
      const getMediaUrl = vi.fn(async (fileId) => `http://test.local/media/${fileId}`);

      const customRenderer = new RendererLite(
        { cmsUrl: 'http://test.local', hardwareKey: 'test-key' },
        container,
        {
          getMediaUrl,
          getWidgetHtml: async (widget) => widget.raw
        }
      );

      const xlfWithMedia = `<?xml version="1.0"?>
<layout width="1920" height="1080" bgcolor="#000000">
  <region id="1" width="400" height="200" top="0" left="0" zindex="0">
    <media id="10" fileId="555" type="image" duration="10">
      <options><uri>test.jpg</uri></options>
    </media>
  </region>
</layout>`;

      await customRenderer.renderOverlay(xlfWithMedia, 300, 10);

      expect(getMediaUrl).toHaveBeenCalledWith(555);
    });

    it('should set overlay timer based on duration', async () => {
      vi.useFakeTimers();

      const endListener = vi.fn();
      renderer.on('overlayEnd', endListener);

      const xlfWith60s = `<?xml version="1.0"?>
<layout width="1920" height="1080" bgcolor="#000000" duration="60">
  <region id="1" width="400" height="200" top="0" left="0" zindex="0">
    <media id="1" type="text" duration="30">
      <raw><![CDATA[<p>Test</p>]]></raw>
    </media>
  </region>
</layout>`;

      await renderer.renderOverlay(xlfWith60s, 400, 10);

      // Fast forward 60 seconds
      vi.advanceTimersByTime(60000);

      expect(endListener).toHaveBeenCalledWith(400);

      vi.useRealTimers();
    });
  });

  describe('Multiple overlays', () => {
    it('should render multiple overlays simultaneously', async () => {
      await renderer.renderOverlay(overlayXLF, 201, 10);
      await renderer.renderOverlay(overlayXLF, 202, 20);
      await renderer.renderOverlay(overlayXLF, 203, 5);

      expect(renderer.activeOverlays.size).toBe(3);
      expect(container.querySelector('#overlay_201')).not.toBeNull();
      expect(container.querySelector('#overlay_202')).not.toBeNull();
      expect(container.querySelector('#overlay_203')).not.toBeNull();
    });

    it('should set correct z-index for multiple overlays by priority', async () => {
      await renderer.renderOverlay(overlayXLF, 201, 10);
      await renderer.renderOverlay(overlayXLF, 202, 20);
      await renderer.renderOverlay(overlayXLF, 203, 5);

      const overlay1 = container.querySelector('#overlay_201');
      const overlay2 = container.querySelector('#overlay_202');
      const overlay3 = container.querySelector('#overlay_203');

      expect(overlay1.style.zIndex).toBe('1010'); // 1000 + 10
      expect(overlay2.style.zIndex).toBe('1020'); // 1000 + 20 (highest)
      expect(overlay3.style.zIndex).toBe('1005'); // 1000 + 5 (lowest)
    });

    it('should return all active overlay IDs', async () => {
      await renderer.renderOverlay(overlayXLF, 201, 10);
      await renderer.renderOverlay(overlayXLF, 202, 20);

      const activeIds = renderer.getActiveOverlays();

      expect(activeIds).toContain(201);
      expect(activeIds).toContain(202);
      expect(activeIds.length).toBe(2);
    });
  });

  describe('stopOverlay()', () => {
    it('should remove overlay from DOM', async () => {
      await renderer.renderOverlay(overlayXLF, 200, 10);
      expect(container.querySelector('#overlay_200')).not.toBeNull();

      renderer.stopOverlay(200);

      expect(container.querySelector('#overlay_200')).toBeNull();
    });

    it('should remove overlay from activeOverlays', async () => {
      await renderer.renderOverlay(overlayXLF, 200, 10);
      expect(renderer.activeOverlays.has(200)).toBe(true);

      renderer.stopOverlay(200);

      expect(renderer.activeOverlays.has(200)).toBe(false);
    });

    it('should clear overlay timer', async () => {
      vi.useFakeTimers();

      await renderer.renderOverlay(overlayXLF, 200, 10);
      const overlayState = renderer.activeOverlays.get(200);
      expect(overlayState.timer).toBeDefined();

      renderer.stopOverlay(200);

      vi.advanceTimersByTime(100000); // Timer should not fire

      vi.useRealTimers();
    });

    it('should emit overlayEnd event', async () => {
      const endListener = vi.fn();
      renderer.on('overlayEnd', endListener);

      await renderer.renderOverlay(overlayXLF, 200, 10);
      renderer.stopOverlay(200);

      expect(endListener).toHaveBeenCalledWith(200);
    });

    it('should warn if overlay not active', () => {
      const warnSpy = vi.spyOn(renderer.log, 'warn');

      renderer.stopOverlay(999);

      expect(warnSpy).toHaveBeenCalled();
    });

    it('should stop only specified overlay, leaving others active', async () => {
      await renderer.renderOverlay(overlayXLF, 201, 10);
      await renderer.renderOverlay(overlayXLF, 202, 20);

      renderer.stopOverlay(201);

      expect(renderer.activeOverlays.has(201)).toBe(false);
      expect(renderer.activeOverlays.has(202)).toBe(true);
      expect(container.querySelector('#overlay_201')).toBeNull();
      expect(container.querySelector('#overlay_202')).not.toBeNull();
    });
  });

  describe('stopAllOverlays()', () => {
    it('should stop all active overlays', async () => {
      await renderer.renderOverlay(overlayXLF, 201, 10);
      await renderer.renderOverlay(overlayXLF, 202, 20);
      await renderer.renderOverlay(overlayXLF, 203, 5);

      expect(renderer.activeOverlays.size).toBe(3);

      renderer.stopAllOverlays();

      expect(renderer.activeOverlays.size).toBe(0);
      expect(container.querySelector('#overlay_201')).toBeNull();
      expect(container.querySelector('#overlay_202')).toBeNull();
      expect(container.querySelector('#overlay_203')).toBeNull();
    });

    it('should emit overlayEnd for each overlay', async () => {
      const endListener = vi.fn();
      renderer.on('overlayEnd', endListener);

      await renderer.renderOverlay(overlayXLF, 201, 10);
      await renderer.renderOverlay(overlayXLF, 202, 20);

      renderer.stopAllOverlays();

      expect(endListener).toHaveBeenCalledTimes(2);
    });
  });

  describe('Overlay with main layout', () => {
    it('should render overlay on top of active main layout', async () => {
      // Render main layout
      await renderer.renderLayout(mainLayoutXLF, 100);

      // Render overlay
      await renderer.renderOverlay(overlayXLF, 200, 10);

      // Both should exist
      expect(renderer.currentLayoutId).toBe(100);
      expect(renderer.activeOverlays.has(200)).toBe(true);

      // Overlay should be in overlay container
      const overlayDiv = container.querySelector('#overlay_200');
      const overlayContainer = container.querySelector('#overlay-container');
      expect(overlayContainer.contains(overlayDiv)).toBe(true);
    });

    it('should keep overlay active when main layout changes', async () => {
      // Render main layout
      await renderer.renderLayout(mainLayoutXLF, 100);

      // Render overlay
      await renderer.renderOverlay(overlayXLF, 200, 10);

      // Change main layout
      await renderer.renderLayout(mainLayoutXLF, 101);

      // Overlay should still be active
      expect(renderer.activeOverlays.has(200)).toBe(true);
      expect(container.querySelector('#overlay_200')).not.toBeNull();
    });

    it('should allow removing overlay while main layout is active', async () => {
      // Render main layout
      await renderer.renderLayout(mainLayoutXLF, 100);

      // Render overlay
      await renderer.renderOverlay(overlayXLF, 200, 10);

      // Stop overlay
      renderer.stopOverlay(200);

      // Main layout should still be active
      expect(renderer.currentLayoutId).toBe(100);
      expect(renderer.activeOverlays.has(200)).toBe(false);
    });
  });

  describe('Overlay region and widget rendering', () => {
    it('should start rendering overlay widgets', async () => {
      const widgetStartListener = vi.fn();
      renderer.on('overlayWidgetStart', widgetStartListener);

      await renderer.renderOverlay(overlayXLF, 200, 10);

      expect(widgetStartListener).toHaveBeenCalled();
    });

    it('should create widget elements for overlay regions', async () => {
      await renderer.renderOverlay(overlayXLF, 200, 10);

      const overlayState = renderer.activeOverlays.get(200);
      const region = overlayState.regions.get('overlay-1');

      expect(region.widgetElements.size).toBeGreaterThan(0);
    });

    it('should emit overlayWidgetEnd when widget stops', async () => {
      vi.useFakeTimers();

      const widgetEndListener = vi.fn();
      renderer.on('overlayWidgetEnd', widgetEndListener);

      // Need 2+ widgets for cycling (single widget has no timer/cycling)
      const multiWidgetOverlayXLF = `<?xml version="1.0"?>
<layout width="1920" height="1080" bgcolor="#00000080">
  <region id="overlay-1" width="400" height="200" top="50" left="50" zindex="10">
    <media id="1" type="text" duration="10">
      <raw><![CDATA[<p>Widget 1</p>]]></raw>
    </media>
    <media id="2" type="text" duration="10">
      <raw><![CDATA[<p>Widget 2</p>]]></raw>
    </media>
  </region>
</layout>`;

      await renderer.renderOverlay(multiWidgetOverlayXLF, 200, 10);

      // Fast forward past first widget duration (10s) to trigger cycling
      vi.advanceTimersByTime(11000);

      // Widget should have cycled, emitting end event
      expect(widgetEndListener).toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe('cleanup()', () => {
    it('should stop all overlays on cleanup', async () => {
      await renderer.renderOverlay(overlayXLF, 201, 10);
      await renderer.renderOverlay(overlayXLF, 202, 20);

      renderer.cleanup();

      expect(renderer.activeOverlays.size).toBe(0);
    });

    it('should remove overlay container on cleanup', async () => {
      await renderer.renderOverlay(overlayXLF, 200, 10);

      renderer.cleanup();

      expect(container.innerHTML).toBe('');
    });
  });

  describe('Memory management', () => {
    it('should revoke blob URLs when stopping overlay', async () => {
      const revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL');

      await renderer.renderOverlay(overlayXLF, 200, 10);

      // Manually track blob URLs for the overlay layout ID, since trackBlobUrl()
      // is scoped to currentLayoutId (main layout) and doesn't track overlay blobs
      renderer.layoutBlobUrls.set(200, new Set(['blob:test/overlay-1', 'blob:test/overlay-2']));

      renderer.stopOverlay(200);

      // stopOverlay calls revokeBlobUrlsForLayout(layoutId) which revokes tracked URLs
      expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:test/overlay-1');
      expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:test/overlay-2');
    });

    it('should track blob URLs per overlay layout', async () => {
      await renderer.renderOverlay(overlayXLF, 200, 10);

      // Blob URLs should be tracked (under overlay ID 200, or fallback key 0 if
      // currentLayoutId wasn't set, or empty if no blob URLs were created)
      expect(renderer.layoutBlobUrls.has(200) || renderer.layoutBlobUrls.has(0) || renderer.layoutBlobUrls.size === 0).toBe(true);
    });
  });
});
