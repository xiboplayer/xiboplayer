/**
 * RendererLite Interactive Control (XIC) Tests
 *
 * Tests for the XIC event handlers: interactiveTrigger, widgetExpire,
 * widgetExtendDuration, widgetSetDuration.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RendererLite } from './renderer-lite.js';

/**
 * Create a minimal RendererLite instance with stubbed DOM and methods.
 */
function createRenderer() {
  const container = document.createElement('div');
  const renderer = new RendererLite(
    { cmsUrl: 'http://localhost', hardwareKey: 'test' },
    container,
    { logLevel: 'silent' }
  );

  // Stub methods that touch DOM or async operations
  renderer.renderWidget = vi.fn();
  renderer.stopWidget = vi.fn();
  renderer.checkLayoutComplete = vi.fn();
  renderer._startRegionCycle = vi.fn();
  renderer.navigateToWidget = vi.fn();

  return renderer;
}

/**
 * Populate renderer with a fake region containing widgets.
 */
function addRegion(renderer, regionId, widgets) {
  renderer.regions.set(regionId, {
    element: document.createElement('div'),
    config: { id: regionId },
    widgets,
    currentIndex: 0,
    timer: null,
    width: 100,
    height: 100,
    complete: false,
    isDrawer: false,
    widgetElements: new Map()
  });
}

describe('RendererLite XIC', () => {
  let renderer;

  beforeEach(() => {
    renderer = createRenderer();
    addRegion(renderer, 'region-1', [
      { id: 'w1', type: 'text', duration: 10, options: {} },
      { id: 'w2', type: 'image', duration: 20, options: {} },
      { id: 'w3', type: 'video', duration: 30, options: {} }
    ]);
  });

  describe('_findRegionByWidgetId', () => {
    it('should find a widget in main regions', () => {
      const result = renderer._findRegionByWidgetId('w2');
      expect(result).not.toBeNull();
      expect(result.regionId).toBe('region-1');
      expect(result.widgetIndex).toBe(1);
      expect(result.widget.id).toBe('w2');
      expect(result.regionMap).toBe(renderer.regions);
    });

    it('should return null for unknown widget', () => {
      const result = renderer._findRegionByWidgetId('w-unknown');
      expect(result).toBeNull();
    });

    it('should find a widget in overlay regions', () => {
      const overlayRegions = new Map();
      overlayRegions.set('overlay-r1', {
        element: document.createElement('div'),
        config: { id: 'overlay-r1' },
        widgets: [{ id: 'ow1', type: 'text', duration: 5, options: {} }],
        currentIndex: 0,
        timer: null,
        width: 50,
        height: 50,
        complete: false,
        isDrawer: false,
        widgetElements: new Map()
      });
      renderer.activeOverlays.set(100, { regions: overlayRegions });

      const result = renderer._findRegionByWidgetId('ow1');
      expect(result).not.toBeNull();
      expect(result.regionId).toBe('overlay-r1');
      expect(result.widgetIndex).toBe(0);
      expect(result.regionMap).toBe(overlayRegions);
    });
  });

  describe('_handleInteractiveTrigger', () => {
    it('should call navigateToWidget when target exists', () => {
      renderer.emit('interactiveTrigger', { targetId: 'w2', triggerCode: 'btn1' });
      expect(renderer.navigateToWidget).toHaveBeenCalledWith('w2');
    });

    it('should not call navigateToWidget when target is unknown', () => {
      renderer.emit('interactiveTrigger', { targetId: 'w-missing', triggerCode: 'btn1' });
      expect(renderer.navigateToWidget).not.toHaveBeenCalled();
    });
  });

  describe('_handleWidgetExpire', () => {
    it('should clear timer, stop widget, and advance region', () => {
      const region = renderer.regions.get('region-1');
      region.timer = setTimeout(() => {}, 99999);
      region.currentIndex = 0;

      renderer.emit('widgetExpire', { widgetId: 'w1' });

      expect(region.timer).toBeNull();
      expect(renderer.stopWidget).toHaveBeenCalledWith('region-1', 0);
      expect(renderer._startRegionCycle).toHaveBeenCalled();
    });

    it('should do nothing for unknown widget', () => {
      renderer.emit('widgetExpire', { widgetId: 'w-missing' });
      expect(renderer.stopWidget).not.toHaveBeenCalled();
    });
  });

  describe('_handleWidgetExtendDuration', () => {
    it('should clear existing timer and re-arm with extended duration', () => {
      vi.useFakeTimers();
      const region = renderer.regions.get('region-1');
      region.timer = setTimeout(() => {}, 99999);

      renderer.emit('widgetExtendDuration', { widgetId: 'w1', duration: 15 });

      // Timer should be re-armed (not null)
      expect(region.timer).not.toBeNull();
      // stopWidget should NOT have been called yet (timer hasn't fired)
      expect(renderer.stopWidget).not.toHaveBeenCalled();

      // Advance time to fire the new timer
      vi.advanceTimersByTime(15000);
      expect(renderer.stopWidget).toHaveBeenCalledWith('region-1', 0);

      vi.useRealTimers();
    });

    it('should do nothing for unknown widget', () => {
      renderer.emit('widgetExtendDuration', { widgetId: 'w-missing', duration: 10 });
      expect(renderer.stopWidget).not.toHaveBeenCalled();
    });
  });

  describe('_handleWidgetSetDuration', () => {
    it('should clear existing timer and set absolute duration', () => {
      vi.useFakeTimers();
      const region = renderer.regions.get('region-1');
      region.timer = setTimeout(() => {}, 99999);

      renderer.emit('widgetSetDuration', { widgetId: 'w2', duration: 5 });

      expect(region.timer).not.toBeNull();
      expect(renderer.stopWidget).not.toHaveBeenCalled();

      vi.advanceTimersByTime(5000);
      // w2 is at index 1, but the region's currentIndex determines what gets stopped
      expect(renderer.stopWidget).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('should do nothing for unknown widget', () => {
      renderer.emit('widgetSetDuration', { widgetId: 'w-missing', duration: 10 });
      expect(renderer.stopWidget).not.toHaveBeenCalled();
    });
  });

  describe('_advanceRegion', () => {
    it('should increment currentIndex and call _startRegionCycle', () => {
      const region = renderer.regions.get('region-1');
      region.currentIndex = 0;

      renderer._advanceRegion('region-1', renderer.regions);

      expect(region.currentIndex).toBe(1);
      expect(renderer._startRegionCycle).toHaveBeenCalled();
    });

    it('should wrap around at end of widget list', () => {
      const region = renderer.regions.get('region-1');
      region.currentIndex = 2; // last widget

      renderer._advanceRegion('region-1', renderer.regions);

      expect(region.currentIndex).toBe(0);
      expect(renderer._startRegionCycle).toHaveBeenCalled();
    });
  });
});
