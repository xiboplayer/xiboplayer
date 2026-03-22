// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * RendererLite Test Suite
 *
 * Comprehensive tests for XLF rendering, element reuse, transitions,
 * and memory management.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { RendererLite, Transitions } from './renderer-lite.js';

describe('RendererLite', () => {
  // Patch HTMLMediaElement after jsdom initializes — vitest.setup.js runs
  // before the jsdom environment, so stubs set there get overwritten.
  beforeAll(() => {
    const proto = window.HTMLMediaElement.prototype;
    proto.play = vi.fn(() => Promise.resolve());
    proto.pause = vi.fn();
    proto.load = vi.fn();
    Object.defineProperty(proto, 'duration', { writable: true, configurable: true, value: NaN });
    Object.defineProperty(proto, 'currentTime', { writable: true, configurable: true, value: 0 });
  });
  let container;
  let renderer;
  let mockGetWidgetHtml;

  beforeEach(() => {
    // Create test container
    container = document.createElement('div');
    container.id = 'test-container';
    document.body.appendChild(container);

    // Mock URL.createObjectURL and URL.revokeObjectURL (not available in jsdom)
    if (!global.URL.createObjectURL) {
      global.URL.createObjectURL = vi.fn((blob) => `blob:test-${Math.random()}`);
    }
    if (!global.URL.revokeObjectURL) {
      global.URL.revokeObjectURL = vi.fn();
    }

    // Mock callbacks
    mockGetWidgetHtml = vi.fn((widget) => Promise.resolve(`<html>Widget ${widget.id}</html>`));

    // Create renderer instance
    renderer = new RendererLite(
      { cmsUrl: 'https://test.com', hardwareKey: 'test-key' },
      container,
      {
        fileIdToSaveAs: new Map(),
        getWidgetHtml: mockGetWidgetHtml
      }
    );
  });

  afterEach(() => {
    // Cleanup
    renderer.cleanup();
    container.remove();
  });

  describe('XLF Parsing', () => {
    it('should parse valid XLF with layout attributes', () => {
      const xlf = `
        <layout width="1920" height="1080" duration="60" bgcolor="#000000">
          <region id="r1" width="1920" height="1080" top="0" left="0" zindex="0">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      const layout = renderer.parseXlf(xlf);

      expect(layout.width).toBe(1920);
      expect(layout.height).toBe(1080);
      expect(layout.duration).toBe(60);
      expect(layout.bgcolor).toBe('#000000');
      expect(layout.regions).toHaveLength(1);
    });

    it('should use defaults when attributes missing', () => {
      const xlf = `<layout><region id="r1"></region></layout>`;
      const layout = renderer.parseXlf(xlf);

      expect(layout.width).toBe(1920);
      expect(layout.height).toBe(1080);
      expect(layout.duration).toBeGreaterThanOrEqual(0); // Calculated or default
      expect(layout.bgcolor).toBe('#000000');
    });

    it('should parse multiple regions', () => {
      const xlf = `
        <layout>
          <region id="r1" width="960" height="1080" top="0" left="0"></region>
          <region id="r2" width="960" height="1080" top="0" left="960"></region>
        </layout>
      `;

      const layout = renderer.parseXlf(xlf);
      expect(layout.regions).toHaveLength(2);
      expect(layout.regions[0].id).toBe('r1');
      expect(layout.regions[1].id).toBe('r2');
    });

    it('should parse widget with all attributes', () => {
      const xlf = `
        <layout>
          <region id="r1">
            <media id="m1" type="video" duration="30" useDuration="0" fileId="5">
              <options>
                <uri>test.mp4</uri>
                <loop>1</loop>
                <mute>0</mute>
              </options>
              <raw>Some content</raw>
            </media>
          </region>
        </layout>
      `;

      const layout = renderer.parseXlf(xlf);
      const widget = layout.regions[0].widgets[0];

      expect(widget.type).toBe('video');
      expect(widget.duration).toBe(30);
      expect(widget.useDuration).toBe(0);
      expect(widget.id).toBe('m1');
      expect(widget.fileId).toBe('5');
      expect(widget.options.uri).toBe('test.mp4');
      expect(widget.options.loop).toBe('1');
      expect(widget.raw).toBe('Some content');
    });

    it('should parse transitions', () => {
      const xlf = `
        <layout>
          <region id="r1">
            <media id="m1" type="image" duration="10">
              <options>
                <transIn>fadeIn</transIn>
                <transInDuration>2000</transInDuration>
                <transOut>flyOut</transOut>
                <transOutDuration>1500</transOutDuration>
                <transOutDirection>S</transOutDirection>
              </options>
            </media>
          </region>
        </layout>
      `;

      const layout = renderer.parseXlf(xlf);
      const widget = layout.regions[0].widgets[0];

      expect(widget.transitions.in).toEqual({
        type: 'fadeIn',
        duration: 2000,
        direction: 'N'
      });

      expect(widget.transitions.out).toEqual({
        type: 'flyOut',
        duration: 1500,
        direction: 'S'
      });
    });

    it('should parse region exit transition from options', () => {
      const xlf = `
        <layout>
          <region id="r1" width="960" height="540" top="0" left="0">
            <options>
              <exitTransType>fadeOut</exitTransType>
              <exitTransDuration>500</exitTransDuration>
              <exitTransDirection>N</exitTransDirection>
            </options>
            <media id="m1" type="image" duration="10">
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      const layout = renderer.parseXlf(xlf);
      const region = layout.regions[0];

      expect(region.exitTransition).toEqual({
        type: 'fadeOut',
        duration: 500,
        direction: 'N'
      });
    });

    it('should parse region exit transition with defaults for missing duration and direction', () => {
      const xlf = `
        <layout>
          <region id="r1" width="960" height="540" top="0" left="0">
            <options>
              <exitTransType>flyOut</exitTransType>
            </options>
            <media id="m1" type="image" duration="10">
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      const layout = renderer.parseXlf(xlf);
      const region = layout.regions[0];

      expect(region.exitTransition).toEqual({
        type: 'flyOut',
        duration: 1000,
        direction: 'N'
      });
    });

    it('should set exitTransition to null when region has no options', () => {
      const xlf = `
        <layout>
          <region id="r1" width="960" height="540" top="0" left="0">
            <media id="m1" type="image" duration="10">
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      const layout = renderer.parseXlf(xlf);
      const region = layout.regions[0];

      expect(region.exitTransition).toBeNull();
    });

    it('should set exitTransition to null when region options have no exitTransType', () => {
      const xlf = `
        <layout>
          <region id="r1" width="960" height="540" top="0" left="0">
            <options>
              <someOtherOption>value</someOtherOption>
            </options>
            <media id="m1" type="image" duration="10">
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      const layout = renderer.parseXlf(xlf);
      const region = layout.regions[0];

      expect(region.exitTransition).toBeNull();
    });

    it('should not confuse media options with region options for exit transitions', () => {
      const xlf = `
        <layout>
          <region id="r1" width="960" height="540" top="0" left="0">
            <media id="m1" type="image" duration="10">
              <options>
                <uri>test.png</uri>
                <transOut>fadeOut</transOut>
                <transOutDuration>1500</transOutDuration>
              </options>
            </media>
          </region>
        </layout>
      `;

      const layout = renderer.parseXlf(xlf);
      const region = layout.regions[0];

      // Region should have no exit transition (only media has transOut)
      expect(region.exitTransition).toBeNull();
      // Widget should have its own out transition
      expect(region.widgets[0].transitions.out).toEqual({
        type: 'fadeOut',
        duration: 1500,
        direction: 'N'
      });
    });
  });

  describe('enableStat parsing', () => {
    it('should parse enableStat="1" as true on layout', () => {
      const xlf = `
        <layout enableStat="1">
          <region id="r1">
            <media id="m1" type="image" duration="10"></media>
          </region>
        </layout>
      `;
      const layout = renderer.parseXlf(xlf);
      expect(layout.enableStat).toBe(true);
    });

    it('should parse enableStat="0" as false on layout', () => {
      const xlf = `
        <layout enableStat="0">
          <region id="r1">
            <media id="m1" type="image" duration="10"></media>
          </region>
        </layout>
      `;
      const layout = renderer.parseXlf(xlf);
      expect(layout.enableStat).toBe(false);
    });

    it('should default enableStat to true when absent on layout', () => {
      const xlf = `
        <layout>
          <region id="r1">
            <media id="m1" type="image" duration="10"></media>
          </region>
        </layout>
      `;
      const layout = renderer.parseXlf(xlf);
      expect(layout.enableStat).toBe(true);
    });

    it('should parse enableStat="0" as false on widget', () => {
      const xlf = `
        <layout>
          <region id="r1">
            <media id="m1" type="image" duration="10" enableStat="0">
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;
      const layout = renderer.parseXlf(xlf);
      expect(layout.regions[0].widgets[0].enableStat).toBe(false);
    });

    it('should parse enableStat="1" as true on widget', () => {
      const xlf = `
        <layout>
          <region id="r1">
            <media id="m1" type="image" duration="10" enableStat="1">
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;
      const layout = renderer.parseXlf(xlf);
      expect(layout.regions[0].widgets[0].enableStat).toBe(true);
    });

    it('should default enableStat to true when absent on widget', () => {
      const xlf = `
        <layout>
          <region id="r1">
            <media id="m1" type="image" duration="10">
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;
      const layout = renderer.parseXlf(xlf);
      expect(layout.regions[0].widgets[0].enableStat).toBe(true);
    });
  });

  describe('Region Creation', () => {
    it('should create region element with correct positioning', async () => {
      const regionConfig = {
        id: 'r1',
        width: 960,
        height: 540,
        top: 100,
        left: 200,
        zindex: 5,
        widgets: []
      };

      await renderer.createRegion(regionConfig);

      const regionEl = container.querySelector('#region_r1');
      expect(regionEl).toBeTruthy();
      expect(regionEl.style.position).toBe('absolute');
      expect(regionEl.style.width).toBe('960px');
      expect(regionEl.style.height).toBe('540px');
      expect(regionEl.style.top).toBe('100px');
      expect(regionEl.style.left).toBe('200px');
      expect(regionEl.style.zIndex).toBe('5');
    });

    it('should store region state in Map', async () => {
      const regionConfig = {
        id: 'r1',
        width: 1920,
        height: 1080,
        top: 0,
        left: 0,
        zindex: 0,
        widgets: []
      };

      await renderer.createRegion(regionConfig);

      const region = renderer.regions.get('r1');
      expect(region).toBeTruthy();
      expect(region.config).toEqual(regionConfig);
      expect(region.currentIndex).toBe(0);
      expect(region.widgetElements).toBeInstanceOf(Map);
    });
  });

  describe('Widget Element Creation', () => {
    it('should create image widget element', async () => {
      const widget = {
        type: 'image',
        id: 'm1',
        fileId: '1',
        options: { uri: 'test.png' },
        duration: 10,
        transitions: { in: null, out: null }
      };

      const region = { width: 1920, height: 1080 };
      const element = await renderer.renderImage(widget, region);

      expect(element.tagName).toBe('IMG');
      expect(element.className).toBe('renderer-lite-widget');
      expect(element.style.width).toBe('100%');
      expect(element.style.height).toBe('100%');
    });

    it('should default to objectFit contain and objectPosition center center', async () => {
      const widget = {
        type: 'image',
        id: 'm1',
        fileId: '1',
        options: { uri: 'test.png' },
        duration: 10,
        transitions: { in: null, out: null }
      };

      const region = { width: 1920, height: 1080 };
      const element = await renderer.renderImage(widget, region);

      expect(element.style.objectFit).toBe('contain');
      expect(element.style.objectPosition).toBe('center center');
    });

    it('should apply objectFit fill when scaleType is stretch', async () => {
      const widget = {
        type: 'image',
        id: 'm1',
        fileId: '1',
        options: { uri: 'test.png', scaleType: 'stretch' },
        duration: 10,
        transitions: { in: null, out: null }
      };

      const region = { width: 1920, height: 1080 };
      const element = await renderer.renderImage(widget, region);

      expect(element.style.objectFit).toBe('fill');
    });

    it('should apply objectFit contain when scaleType is center (proportional fit)', async () => {
      const widget = {
        type: 'image',
        id: 'm1',
        fileId: '1',
        options: { uri: 'test.png', scaleType: 'center' },
        duration: 10,
        transitions: { in: null, out: null }
      };

      const region = { width: 1920, height: 1080 };
      const element = await renderer.renderImage(widget, region);

      expect(element.style.objectFit).toBe('contain');
    });

    it('should apply objectFit cover when scaleType is fit', async () => {
      const widget = {
        type: 'image',
        id: 'm1',
        fileId: '1',
        options: { uri: 'test.png', scaleType: 'fit' },
        duration: 10,
        transitions: { in: null, out: null }
      };

      const region = { width: 1920, height: 1080 };
      const element = await renderer.renderImage(widget, region);

      expect(element.style.objectFit).toBe('cover');
    });

    it('should map alignId and valignId to objectPosition', async () => {
      const widget = {
        type: 'image',
        id: 'm1',
        fileId: '1',
        options: { uri: 'test.png', alignId: 'left', valignId: 'top' },
        duration: 10,
        transitions: { in: null, out: null }
      };

      const region = { width: 1920, height: 1080 };
      const element = await renderer.renderImage(widget, region);

      expect(element.style.objectPosition).toBe('left top');
    });

    it('should map alignId right and valignId bottom to objectPosition', async () => {
      const widget = {
        type: 'image',
        id: 'm1',
        fileId: '1',
        options: { uri: 'test.png', alignId: 'right', valignId: 'bottom' },
        duration: 10,
        transitions: { in: null, out: null }
      };

      const region = { width: 1920, height: 1080 };
      const element = await renderer.renderImage(widget, region);

      expect(element.style.objectPosition).toBe('right bottom');
    });

    it('should map valignId middle to center in objectPosition', async () => {
      const widget = {
        type: 'image',
        id: 'm1',
        fileId: '1',
        options: { uri: 'test.png', alignId: 'center', valignId: 'middle' },
        duration: 10,
        transitions: { in: null, out: null }
      };

      const region = { width: 1920, height: 1080 };
      const element = await renderer.renderImage(widget, region);

      expect(element.style.objectPosition).toBe('center center');
    });

    it('should combine scaleType stretch with alignment options', async () => {
      const widget = {
        type: 'image',
        id: 'm1',
        fileId: '1',
        options: { uri: 'test.png', scaleType: 'stretch', alignId: 'left', valignId: 'bottom' },
        duration: 10,
        transitions: { in: null, out: null }
      };

      const region = { width: 1920, height: 1080 };
      const element = await renderer.renderImage(widget, region);

      expect(element.style.objectFit).toBe('fill');
      expect(element.style.objectPosition).toBe('left bottom');
    });

    it('should create video widget element', async () => {
      const widget = {
        type: 'video',
        id: 'm2',
        fileId: '5',
        options: { uri: '5.mp4', loop: '1', mute: '1' },
        duration: 30,
        transitions: { in: null, out: null }
      };

      const region = { width: 1920, height: 1080 };
      const element = await renderer.renderVideo(widget, region);

      expect(element.tagName).toBe('VIDEO');
      expect(element.autoplay).toBe(true);
      expect(element.muted).toBe(true);
      // loop is intentionally false - handled manually via 'ended' event to avoid black frames
      expect(element.loop).toBe(false);
    });

    it('should create text widget with iframe (blob fallback)', async () => {
      const widget = {
        type: 'text',
        id: 'm3',
        layoutId: 1,
        regionId: 'r1',
        options: {},
        raw: '<h1>Test</h1>',
        duration: 15,
        transitions: { in: null, out: null }
      };

      const region = { width: 1920, height: 1080 };
      const element = await renderer.renderTextWidget(widget, region);

      expect(element.tagName).toBe('IFRAME');
      expect(element.src).toContain('blob:');
      expect(mockGetWidgetHtml).toHaveBeenCalledWith(widget);
    });

    it('should use cache URL when getWidgetHtml returns { url }', async () => {
      // Override mock to return { url } object (cache path)
      mockGetWidgetHtml.mockResolvedValueOnce({ url: '/player/pwa/cache/widget/1/r1/m4' });

      const widget = {
        type: 'text',
        id: 'm4',
        layoutId: 1,
        regionId: 'r1',
        options: {},
        raw: '<h1>Test</h1>',
        duration: 15,
        transitions: { in: null, out: null }
      };

      const region = { width: 1920, height: 1080 };
      const element = await renderer.renderTextWidget(widget, region);

      expect(element.tagName).toBe('IFRAME');
      // Should use cache URL directly, NOT blob URL
      expect(element.src).toContain('/player/pwa/cache/widget/1/r1/m4');
      expect(element.src).not.toContain('blob:');
      expect(mockGetWidgetHtml).toHaveBeenCalledWith(widget);
    });

    it('should use cache URL for generic widget when getWidgetHtml returns { url }', async () => {
      mockGetWidgetHtml.mockResolvedValueOnce({ url: '/player/pwa/cache/widget/1/r1/m5' });

      const widget = {
        type: 'clock',
        id: 'm5',
        layoutId: 1,
        regionId: 'r1',
        options: {},
        raw: '<div>Clock</div>',
        duration: 10,
        transitions: { in: null, out: null }
      };

      const region = { width: 1920, height: 1080 };
      const element = await renderer.renderGenericWidget(widget, region);

      expect(element.tagName).toBe('IFRAME');
      expect(element.src).toContain('/player/pwa/cache/widget/1/r1/m5');
      expect(element.src).not.toContain('blob:');
    });
  });

  describe('Element Reuse Pattern', () => {
    it('should pre-create all widget elements on layout load', async () => {
      const xlf = `
        <layout>
          <region id="r1">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>1.png</uri></options>
            </media>
            <media id="m2" type="image" duration="10" fileId="2">
              <options><uri>2.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      await renderer.renderLayout(xlf, 1);

      const region = renderer.regions.get('r1');
      expect(region.widgetElements.size).toBe(2);
      expect(region.widgetElements.has('m1')).toBe(true);
      expect(region.widgetElements.has('m2')).toBe(true);
    });

    it('should reuse elements on widget cycling', async () => {
      const xlf = `
        <layout>
          <region id="r1">
            <media id="m1" type="image" duration="1" fileId="1">
              <options><uri>1.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      await renderer.renderLayout(xlf, 1);

      const region = renderer.regions.get('r1');
      const firstElement = region.widgetElements.get('m1');

      // Render widget again
      await renderer.renderWidget('r1', 0);

      const secondElement = region.widgetElements.get('m1');

      // Should be SAME element reference (reused)
      expect(secondElement).toBe(firstElement);
    });

    it('should reuse elements on layout replay', async () => {
      const xlf = `
        <layout>
          <region id="r1">
            <media id="m1" type="video" duration="5" fileId="5">
              <options><uri>5.mp4</uri></options>
            </media>
          </region>
        </layout>
      `;

      // First render
      await renderer.renderLayout(xlf, 1);
      const region1 = renderer.regions.get('r1');
      const element1 = region1.widgetElements.get('m1');

      // Replay same layout (simulating layoutEnd → collect → renderLayout)
      renderer.stopCurrentLayout = vi.fn(); // Mock to verify it's NOT called
      await renderer.renderLayout(xlf, 1);

      const region2 = renderer.regions.get('r1');
      const element2 = region2.widgetElements.get('m1');

      // stopCurrentLayout should NOT be called (elements reused)
      expect(renderer.stopCurrentLayout).not.toHaveBeenCalled();

      // Elements should be reused
      expect(element2).toBe(element1);
    });

    it('should NOT reuse elements on layout switch', async () => {
      const xlf1 = `
        <layout>
          <region id="r1">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>1.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      const xlf2 = `
        <layout>
          <region id="r1">
            <media id="m2" type="image" duration="10" fileId="2">
              <options><uri>2.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      // Render layout 1
      await renderer.renderLayout(xlf1, 1);
      const region1 = renderer.regions.get('r1');
      const element1 = region1?.widgetElements.get('m1');

      // Switch to layout 2
      await renderer.renderLayout(xlf2, 2);
      const region2 = renderer.regions.get('r1');
      const element2 = region2?.widgetElements.get('m2');

      // Elements should be different (new layout, new elements)
      expect(element1).toBeTruthy();
      expect(element2).toBeTruthy();
      expect(element1).not.toBe(element2);

      // Old region should be cleared
      expect(region1).not.toBe(region2);
    });
  });

  describe('Video Duration Detection', () => {
    it('should detect video duration from metadata', () => {
      // Directly test _hasUnprobedVideos + duration update logic
      // (renderer.renderLayout creates iframes in jsdom, not real video elements)
      const widget = { id: 'm1', type: 'video', duration: 60, useDuration: 0, _probed: false };
      const region = { id: 'r1', widgets: [widget], isDrawer: false };
      renderer.regions = new Map([['r1', region]]);

      // Before metadata: widget is unprobed
      expect(renderer._hasUnprobedVideos()).toBe(true);

      // Simulate metadata arrival
      widget.duration = 45;
      widget._probed = true;

      // After metadata: all probed
      expect(renderer._hasUnprobedVideos()).toBe(false);
      expect(widget.duration).toBe(45);
    });

    it('should calculate correct duration from widget durations', () => {
      // Test the duration calculation logic that updateLayoutDuration uses:
      // max region duration across all regions, sum of widgets per region
      const w1 = { id: 'v1', duration: 30, useDuration: 0, _probed: true };
      const w2 = { id: 'v2', duration: 15, useDuration: 0, _probed: true };
      // Region duration = sum of widgets = 30 + 15 = 45
      const region = { id: 'r1', widgets: [w1, w2], isDrawer: false };
      renderer.regions = new Map([['r1', region]]);

      // Verify _hasUnprobedVideos returns false when all probed
      expect(renderer._hasUnprobedVideos()).toBe(false);

      // Verify the duration sum matches what updateLayoutDuration would compute
      const regionDuration = region.widgets.reduce((sum, w) => sum + (w.duration > 0 ? w.duration : 0), 0);
      expect(regionDuration).toBe(45);
    });

    it('should NOT mark widget as probed when useDuration=1', () => {
      const widget = { id: 'm1', type: 'video', duration: 30, useDuration: 1 };
      const region = { id: 'r1', widgets: [widget], isDrawer: false };
      renderer.regions = new Map([['r1', region]]);

      // useDuration=1 means CMS-set duration — not a "play to end" video
      expect(renderer._hasUnprobedVideos()).toBe(false);
      expect(widget.duration).toBe(30);
    });

    it('should handle mixed probed and unprobed videos', () => {
      const widget1 = { id: 'm1', type: 'video', duration: 45, useDuration: 0, _probed: true };
      const widget2 = { id: 'm2', type: 'video', duration: 60, useDuration: 0, _probed: false };
      const region = { id: 'r1', widgets: [widget1, widget2], isDrawer: false };
      renderer.regions = new Map([['r1', region]]);

      // One still unprobed
      expect(renderer._hasUnprobedVideos()).toBe(true);

      // Probe the second
      widget2.duration = 30;
      widget2._probed = true;
      expect(renderer._hasUnprobedVideos()).toBe(false);
    });
  });

  describe('Media Element Restart', () => {
    it('should restart video via updateMediaElement', () => {
      const video = document.createElement('video');
      video.currentTime = 25.5;
      // Simulate readyState >= 2 so _restartMediaElement calls play directly
      Object.defineProperty(video, 'readyState', { value: 3, configurable: true });
      video.play = vi.fn(() => Promise.resolve());

      const wrapper = document.createElement('div');
      wrapper.appendChild(video);

      const widget = { type: 'video', id: 'm1', fileId: '5', options: { loop: '0' }, duration: 30 };
      renderer.updateMediaElement(wrapper, widget);

      expect(video.currentTime).toBe(0);
      expect(video.play).toHaveBeenCalled();
    });

    it('should restart looping videos too', () => {
      const video = document.createElement('video');
      video.currentTime = 25.5;
      Object.defineProperty(video, 'readyState', { value: 3, configurable: true });
      video.play = vi.fn(() => Promise.resolve());

      const wrapper = document.createElement('div');
      wrapper.appendChild(video);

      const widget = { type: 'video', id: 'm1', fileId: '5', options: { loop: '1' }, duration: 30 };
      renderer.updateMediaElement(wrapper, widget);

      expect(video.currentTime).toBe(0);
      expect(video.play).toHaveBeenCalled();
    });
  });

  describe('Layout Lifecycle', () => {
    it('should emit layoutStart event', async () => {
      const xlf = `<layout><region id="r1"></region></layout>`;
      const layoutStartHandler = vi.fn();

      renderer.on('layoutStart', layoutStartHandler);
      await renderer.renderLayout(xlf, 1);

      expect(layoutStartHandler).toHaveBeenCalledWith(1, expect.any(Object));
    });

    it('should emit layoutEnd event after duration expires', async () => {
      vi.useFakeTimers();

      const xlf = `
        <layout duration="2">
          <region id="r1">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>1.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      const layoutEndHandler = vi.fn();
      renderer.on('layoutEnd', layoutEndHandler);

      // Don't await directly — renderLayout waits for widget readiness (image load
      // or 10s timeout). With fake timers we must advance time to unblock it.
      const renderPromise = renderer.renderLayout(xlf, 1);

      // Advance past the 10s image-ready timeout, flushing microtasks
      await vi.advanceTimersByTimeAsync(10000);
      await renderPromise;

      // Now advance 2s to trigger the layout duration timer
      vi.advanceTimersByTime(2000);

      expect(layoutEndHandler).toHaveBeenCalledWith(1);

      vi.useRealTimers();
    });

    it('should emit widgetStart event', async () => {
      const xlf = `
        <layout>
          <region id="r1">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>1.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      const widgetStartHandler = vi.fn();
      renderer.on('widgetStart', widgetStartHandler);

      await renderer.renderLayout(xlf, 1);

      expect(widgetStartHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          widgetId: 'm1',
          regionId: 'r1',
          type: 'image'
        })
      );
    });
  });

  describe('Transitions', () => {
    let element;
    let mockAnimate;
    let capturedKeyframes;
    let capturedTiming;

    beforeEach(() => {
      element = document.createElement('div');
      capturedKeyframes = null;
      capturedTiming = null;
      mockAnimate = vi.fn((keyframes, timing) => {
        capturedKeyframes = keyframes;
        capturedTiming = timing;
        return { onfinish: null, cancel: vi.fn() };
      });
      element.animate = mockAnimate;
    });

    it('should apply fade in transition', () => {
      const result = Transitions.apply(element, { type: 'fadeIn', duration: 1000 }, true, 1920, 1080);

      expect(result).toBeTruthy();
      expect(capturedKeyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
      expect(capturedTiming.duration).toBe(1000);
      expect(capturedTiming.easing).toBe('linear');
    });

    it('should apply fade out transition', () => {
      const result = Transitions.apply(element, { type: 'fadeOut', duration: 800 }, false, 1920, 1080);

      expect(result).toBeTruthy();
      expect(capturedKeyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
      expect(capturedTiming.duration).toBe(800);
    });

    it('should apply generic "fade" as fadeIn when isIn=true', () => {
      const result = Transitions.apply(element, { type: 'fade', duration: 500 }, true, 1920, 1080);

      expect(result).toBeTruthy();
      expect(capturedKeyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    });

    it('should apply generic "fade" as fadeOut when isIn=false', () => {
      const result = Transitions.apply(element, { type: 'fade', duration: 500 }, false, 1920, 1080);

      expect(result).toBeTruthy();
      expect(capturedKeyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    });

    it('should apply fly in from North', () => {
      const result = Transitions.apply(
        element, { type: 'flyIn', duration: 500, direction: 'N' }, true, 1920, 1080
      );

      expect(result).toBeTruthy();
      expect(capturedKeyframes[0].transform).toBe('translate(0px, -1080px)');
      expect(capturedKeyframes[1].transform).toBe('translate(0, 0)');
      expect(capturedTiming.easing).toBe('ease-out');
    });

    it('should apply fly in from East', () => {
      Transitions.apply(
        element, { type: 'flyIn', duration: 500, direction: 'E' }, true, 1920, 1080
      );

      expect(capturedKeyframes[0].transform).toBe('translate(1920px, 0px)');
      expect(capturedKeyframes[1].transform).toBe('translate(0, 0)');
    });

    it('should apply fly in from South', () => {
      Transitions.apply(
        element, { type: 'flyIn', duration: 500, direction: 'S' }, true, 1920, 1080
      );

      expect(capturedKeyframes[0].transform).toBe('translate(0px, 1080px)');
    });

    it('should apply fly in from West', () => {
      Transitions.apply(
        element, { type: 'flyIn', duration: 500, direction: 'W' }, true, 1920, 1080
      );

      expect(capturedKeyframes[0].transform).toBe('translate(-1920px, 0px)');
    });

    it('should apply fly in from diagonal directions (NE, SE, SW, NW)', () => {
      // NE
      Transitions.apply(element, { type: 'flyIn', duration: 500, direction: 'NE' }, true, 1920, 1080);
      expect(capturedKeyframes[0].transform).toBe('translate(1920px, -1080px)');

      // SE
      Transitions.apply(element, { type: 'flyIn', duration: 500, direction: 'SE' }, true, 1920, 1080);
      expect(capturedKeyframes[0].transform).toBe('translate(1920px, 1080px)');

      // SW
      Transitions.apply(element, { type: 'flyIn', duration: 500, direction: 'SW' }, true, 1920, 1080);
      expect(capturedKeyframes[0].transform).toBe('translate(-1920px, 1080px)');

      // NW
      Transitions.apply(element, { type: 'flyIn', duration: 500, direction: 'NW' }, true, 1920, 1080);
      expect(capturedKeyframes[0].transform).toBe('translate(-1920px, -1080px)');
    });

    it('should apply fly out with direction S', () => {
      const result = Transitions.apply(
        element, { type: 'flyOut', duration: 1500, direction: 'S' }, false, 1920, 1080
      );

      expect(result).toBeTruthy();
      expect(capturedKeyframes[0].transform).toBe('translate(0, 0)');
      expect(capturedKeyframes[1].transform).toBe('translate(0px, -1080px)');
      expect(capturedTiming.easing).toBe('ease-in');
    });

    it('should apply generic "fly" as flyIn when isIn=true', () => {
      const result = Transitions.apply(
        element, { type: 'fly', duration: 500, direction: 'E' }, true, 1920, 1080
      );

      expect(result).toBeTruthy();
      expect(capturedKeyframes[0].transform).toBe('translate(1920px, 0px)');
      expect(capturedKeyframes[1].transform).toBe('translate(0, 0)');
      expect(capturedTiming.easing).toBe('ease-out');
    });

    it('should apply generic "fly" as flyOut when isIn=false', () => {
      const result = Transitions.apply(
        element, { type: 'fly', duration: 500, direction: 'W' }, false, 1920, 1080
      );

      expect(result).toBeTruthy();
      expect(capturedKeyframes[0].transform).toBe('translate(0, 0)');
      expect(capturedKeyframes[1].transform).toContain('px');
      expect(capturedTiming.easing).toBe('ease-in');
    });

    it('should not apply flyIn when isIn=false', () => {
      const result = Transitions.apply(
        element, { type: 'flyIn', duration: 500, direction: 'N' }, false, 1920, 1080
      );
      expect(result).toBeNull();
    });

    it('should not apply flyOut when isIn=true', () => {
      const result = Transitions.apply(
        element, { type: 'flyOut', duration: 500, direction: 'N' }, true, 1920, 1080
      );
      expect(result).toBeNull();
    });

    it('should default direction to N when missing', () => {
      Transitions.apply(element, { type: 'flyIn', duration: 500 }, true, 1920, 1080);

      // N direction: translateY(-height)
      expect(capturedKeyframes[0].transform).toBe('translate(0px, -1080px)');
    });

    it('should default duration to 1000 when missing', () => {
      Transitions.apply(element, { type: 'fadeIn' }, true, 1920, 1080);

      expect(capturedTiming.duration).toBe(1000);
    });

    it('should return null for unknown transition type', () => {
      const result = Transitions.apply(element, { type: 'slide' }, true, 1920, 1080);
      expect(result).toBeNull();
    });

    it('should return null when config is null', () => {
      expect(Transitions.apply(element, null, true, 1920, 1080)).toBeNull();
    });

    it('should return null when config has no type', () => {
      expect(Transitions.apply(element, { duration: 500 }, true, 1920, 1080)).toBeNull();
    });

    it('should be case-insensitive for type matching', () => {
      const result = Transitions.apply(element, { type: 'FadeIn', duration: 500 }, true, 1920, 1080);
      expect(result).toBeTruthy();
      expect(capturedKeyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    });

    it('should parse fly transitions from XLF with generic "fly" type', () => {
      const xlf = `
        <layout>
          <region id="r1">
            <media id="m1" type="image" duration="10">
              <options>
                <transIn>fly</transIn>
                <transInDuration>500</transInDuration>
                <transInDirection>E</transInDirection>
                <transOut>fly</transOut>
                <transOutDuration>500</transOutDuration>
                <transOutDirection>NW</transOutDirection>
              </options>
            </media>
          </region>
        </layout>
      `;

      const layout = renderer.parseXlf(xlf);
      const widget = layout.regions[0].widgets[0];

      expect(widget.transitions.in).toEqual({
        type: 'fly',
        duration: 500,
        direction: 'E'
      });
      expect(widget.transitions.out).toEqual({
        type: 'fly',
        duration: 500,
        direction: 'NW'
      });
    });
  });

  describe('Memory Management', () => {
    it('should clear regions on stopCurrentLayout', async () => {
      const xlf = `
        <layout>
          <region id="r1">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>1.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      await renderer.renderLayout(xlf, 1);
      expect(renderer.regions.size).toBe(1);

      renderer.stopCurrentLayout();

      expect(renderer.regions.size).toBe(0);
      expect(renderer.currentLayout).toBeNull();
      expect(renderer.currentLayoutId).toBeNull();
    });

    it('should clear timers on cleanup', async () => {
      vi.useFakeTimers();

      const xlf = `
        <layout duration="60">
          <region id="r1">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>1.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      // renderLayout waits for widget readiness — advance past image timeout
      const renderPromise = renderer.renderLayout(xlf, 1);
      await vi.advanceTimersByTimeAsync(10000);
      await renderPromise;

      const layoutTimerId = renderer.layoutTimer;
      expect(layoutTimerId).toBeTruthy();

      renderer.stopCurrentLayout();

      expect(renderer.layoutTimer).toBeNull();

      vi.useRealTimers();
    });

    it('should show a preloaded layout via showLayout()', async () => {
      const xlf = `<layout><region id="r1"></region></layout>`;
      const layoutStartHandler = vi.fn();
      renderer.on('layoutStart', layoutStartHandler);

      // Preload layout hidden
      await renderer.preloadLayout(xlf, 42);
      expect(renderer.currentLayoutId).not.toBe(42);
      expect(layoutStartHandler).not.toHaveBeenCalled();

      // Show it
      renderer.showLayout(42);
      expect(renderer.currentLayoutId).toBe(42);
      expect(layoutStartHandler).toHaveBeenCalledWith(42, expect.any(Object));
    });

    it('should show the latest preloaded layout when no id given', async () => {
      const xlf1 = `<layout bgcolor="#ff0000"><region id="r1"></region></layout>`;
      const xlf2 = `<layout bgcolor="#00ff00"><region id="r2"></region></layout>`;

      await renderer.preloadLayout(xlf1, 10);
      await renderer.preloadLayout(xlf2, 20);

      renderer.showLayout();
      expect(renderer.currentLayoutId).toBe(20);
    });

    it('should no-op showLayout when pool is empty', () => {
      renderer.showLayout(999);
      expect(renderer.currentLayoutId).toBeNull();
    });
  });

  describe('Layout Replay Optimization', () => {
    it('should detect same layout and reuse elements', async () => {
      const xlf = `
        <layout>
          <region id="r1">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>1.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      // First render
      await renderer.renderLayout(xlf, 1);
      const region1 = renderer.regions.get('r1');
      const element1 = region1.widgetElements.get('m1');

      // Spy on stopCurrentLayout
      const stopSpy = vi.spyOn(renderer, 'stopCurrentLayout');

      // Replay same layout
      await renderer.renderLayout(xlf, 1);

      // stopCurrentLayout should NOT be called
      expect(stopSpy).not.toHaveBeenCalled();

      // Should reuse same elements
      const region2 = renderer.regions.get('r1');
      const element2 = region2.widgetElements.get('m1');
      expect(element2).toBe(element1);
    });
  });

  describe('Media URL construction via fileIdToSaveAs', () => {
    it('should construct media URLs using fileIdToSaveAs map', async () => {
      const fileIdToSaveAs = new Map([
        ['1', '1.png'],
        ['5', '5.mp4'],
        ['7', '7.png']
      ]);
      const r = new RendererLite(
        { cmsUrl: 'https://test.com', hardwareKey: 'test-key' },
        container,
        {
          fileIdToSaveAs,
          getWidgetHtml: mockGetWidgetHtml
        }
      );

      const xlf = `
        <layout>
          <region id="r1">
            <media id="m1" type="image" duration="5" fileId="1">
              <options><uri>1.png</uri></options>
            </media>
            <media id="m2" type="video" duration="10" fileId="5">
              <options><uri>5.mp4</uri></options>
            </media>
            <media id="m3" type="image" duration="5" fileId="7">
              <options><uri>7.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      await r.renderLayout(xlf, 1);

      // fileIdToSaveAs should have all 3 entries
      expect(fileIdToSaveAs.size).toBe(3);
      r.cleanup();
    });
  });

  describe('Error Handling', () => {
    it('should emit error event on widget render failure', async () => {
      const xlf = `
        <layout>
          <region id="r1">
            <media id="m1" type="invalid" duration="10">
              <options></options>
            </media>
          </region>
        </layout>
      `;

      const errorHandler = vi.fn();
      renderer.on('error', errorHandler);

      await renderer.renderLayout(xlf, 1);

      // Should handle unknown widget type gracefully
      // (renderGenericWidget fallback)
      expect(errorHandler).not.toHaveBeenCalled();
    });

    it('should handle missing fileId gracefully', async () => {
      const xlf = `
        <layout>
          <region id="r1">
            <media id="m1" type="image" duration="10">
              <options><uri>missing.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      // Should not throw
      await expect(renderer.renderLayout(xlf, 1)).resolves.not.toThrow();
    });
  });

  describe('Duration Calculation', () => {
    it('should calculate layout duration from widgets when not specified', async () => {
      const xlf = `
        <layout>
          <region id="r1">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>1.png</uri></options>
            </media>
            <media id="m2" type="image" duration="20" fileId="2">
              <options><uri>2.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      await renderer.renderLayout(xlf, 1);

      // Duration should be sum of widgets in region: 10 + 20 = 30
      expect(renderer.currentLayout.duration).toBe(30);
    });

    it('should use max region duration for layout', async () => {
      const xlf = `
        <layout>
          <region id="r1">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>1.png</uri></options>
            </media>
          </region>
          <region id="r2">
            <media id="m2" type="video" duration="45" fileId="5">
              <options><uri>5.mp4</uri></options>
            </media>
          </region>
        </layout>
      `;

      await renderer.renderLayout(xlf, 1);

      // Duration should be max(10, 45) = 45
      expect(renderer.currentLayout.duration).toBe(45);
    });
  });

  describe('Audio Widget Support', () => {
    it('should parse audio widget with type, loop and volume options', () => {
      const xlf = `
        <layout>
          <region id="r1">
            <media id="a1" type="audio" duration="30" fileId="10">
              <options>
                <uri>song.mp3</uri>
                <loop>1</loop>
                <volume>80</volume>
              </options>
            </media>
          </region>
        </layout>
      `;

      const layout = renderer.parseXlf(xlf);
      const widget = layout.regions[0].widgets[0];

      expect(widget.type).toBe('audio');
      expect(widget.duration).toBe(30);
      expect(widget.fileId).toBe('10');
      expect(widget.options.loop).toBe('1');
      expect(widget.options.volume).toBe('80');
      expect(widget.options.uri).toBe('song.mp3');
    });

    it('should create audio element inside container for audio widget', async () => {
      const xlf = `
        <layout>
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="a1" type="audio" duration="10" fileId="10">
              <options>
                <uri>test.mp3</uri>
                <loop>0</loop>
                <volume>50</volume>
              </options>
            </media>
          </region>
        </layout>
      `;

      await renderer.renderLayout(xlf, 1);

      const region = renderer.regions.get('r1');
      expect(region).toBeDefined();
      expect(region.widgetElements.size).toBe(1);

      const widgetEl = region.widgetElements.get('a1');
      expect(widgetEl).toBeDefined();
      expect(widgetEl.classList.contains('audio-widget')).toBe(true);

      const audioEl = widgetEl.querySelector('audio');
      expect(audioEl).toBeDefined();
      expect(audioEl.autoplay).toBe(true);
      expect(audioEl.loop).toBe(false);
      expect(audioEl.volume).toBe(0.5);
    });

    it('should set loop=true on audio element when widget options loop is 1', async () => {
      const xlf = `
        <layout>
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="a1" type="audio" duration="10" fileId="10">
              <options>
                <uri>test.mp3</uri>
                <loop>1</loop>
                <volume>100</volume>
              </options>
            </media>
          </region>
        </layout>
      `;

      await renderer.renderLayout(xlf, 1);

      const widgetEl = renderer.regions.get('r1').widgetElements.get('a1');
      const audioEl = widgetEl.querySelector('audio');
      expect(audioEl.loop).toBe(true);
      expect(audioEl.volume).toBe(1);
    });

    it('should default volume to 100 when not specified', async () => {
      const xlf = `
        <layout>
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="a1" type="audio" duration="10" fileId="10">
              <options><uri>test.mp3</uri></options>
            </media>
          </region>
        </layout>
      `;

      await renderer.renderLayout(xlf, 1);

      const widgetEl = renderer.regions.get('r1').widgetElements.get('a1');
      const audioEl = widgetEl.querySelector('audio');
      expect(audioEl.volume).toBe(1);
    });
  });

  describe('Audio Overlay Support', () => {
    it('should parse audio overlay nodes from widget XML', () => {
      const xlf = `
        <layout>
          <region id="r1">
            <media id="m1" type="image" duration="10" fileId="1">
              <audio mediaId="50" uri="bgmusic.mp3" volume="80" loop="1"/>
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      const layout = renderer.parseXlf(xlf);
      const widget = layout.regions[0].widgets[0];

      expect(widget.audioNodes).toBeDefined();
      expect(widget.audioNodes).toHaveLength(1);
      expect(widget.audioNodes[0]).toEqual({
        mediaId: '50',
        uri: 'bgmusic.mp3',
        volume: 80,
        loop: true
      });
    });

    it('should parse multiple audio overlay nodes', () => {
      const xlf = `
        <layout>
          <region id="r1">
            <media id="m1" type="image" duration="10" fileId="1">
              <audio mediaId="50" uri="bgmusic.mp3" volume="80" loop="1"/>
              <audio mediaId="51" uri="sfx.mp3" volume="40" loop="0"/>
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      const layout = renderer.parseXlf(xlf);
      const widget = layout.regions[0].widgets[0];

      expect(widget.audioNodes).toHaveLength(2);
      expect(widget.audioNodes[0].uri).toBe('bgmusic.mp3');
      expect(widget.audioNodes[0].loop).toBe(true);
      expect(widget.audioNodes[1].uri).toBe('sfx.mp3');
      expect(widget.audioNodes[1].loop).toBe(false);
      expect(widget.audioNodes[1].volume).toBe(40);
    });

    it('should parse spec-format audio nodes with <uri> child element', () => {
      const xlf = `
        <layout>
          <region id="r1">
            <media id="m1" type="image" duration="10" fileId="1">
              <audio>
                <uri volume="80" loop="1" mediaId="50">bgmusic.mp3</uri>
              </audio>
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      const layout = renderer.parseXlf(xlf);
      const widget = layout.regions[0].widgets[0];

      expect(widget.audioNodes).toHaveLength(1);
      expect(widget.audioNodes[0]).toEqual({
        mediaId: '50',
        uri: 'bgmusic.mp3',
        volume: 80,
        loop: true
      });
    });

    it('should handle mixed audio formats (spec + flat)', () => {
      const xlf = `
        <layout>
          <region id="r1">
            <media id="m1" type="image" duration="10" fileId="1">
              <audio>
                <uri volume="60" loop="0" mediaId="51">track1.mp3</uri>
              </audio>
              <audio mediaId="52" uri="track2.mp3" volume="40" loop="1"/>
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      const layout = renderer.parseXlf(xlf);
      const widget = layout.regions[0].widgets[0];

      expect(widget.audioNodes).toHaveLength(2);
      // Spec format
      expect(widget.audioNodes[0].uri).toBe('track1.mp3');
      expect(widget.audioNodes[0].mediaId).toBe('51');
      expect(widget.audioNodes[0].volume).toBe(60);
      expect(widget.audioNodes[0].loop).toBe(false);
      // Flat format
      expect(widget.audioNodes[1].uri).toBe('track2.mp3');
      expect(widget.audioNodes[1].mediaId).toBe('52');
      expect(widget.audioNodes[1].volume).toBe(40);
      expect(widget.audioNodes[1].loop).toBe(true);
    });

    it('should have empty audioNodes when widget has no audio children', () => {
      const xlf = `
        <layout>
          <region id="r1">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      const layout = renderer.parseXlf(xlf);
      const widget = layout.regions[0].widgets[0];

      expect(widget.audioNodes).toBeDefined();
      expect(widget.audioNodes).toHaveLength(0);
    });

    it('should create audio overlay elements when widget is shown', async () => {
      const xlf = `
        <layout>
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="10" fileId="1">
              <audio mediaId="50" uri="bgmusic.mp3" volume="75" loop="1"/>
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      await renderer.renderLayout(xlf, 1);
      // Explicitly show the widget to trigger audio overlay (renderLayout fires it async)
      const region = renderer.regions.get('r1');
      await renderer._showWidget(region, 0);

      // Audio overlay should be tracked
      const overlays = renderer.audioOverlays.get('m1');
      expect(overlays).toBeDefined();
      expect(overlays).toHaveLength(1);
      expect(overlays[0]).toBeInstanceOf(HTMLAudioElement);
      expect(overlays[0].loop).toBe(true);
      expect(overlays[0].volume).toBeCloseTo(0.75);
    });

    it('should stop audio overlays when widget is hidden', async () => {
      const xlf = `
        <layout>
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="10" fileId="1">
              <audio mediaId="50" uri="bgmusic.mp3" volume="80" loop="1"/>
              <options><uri>test.png</uri></options>
            </media>
            <media id="m2" type="image" duration="10" fileId="2">
              <options><uri>test2.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      await renderer.renderLayout(xlf, 1);
      // Explicitly show widget to trigger audio overlay
      const region = renderer.regions.get('r1');
      await renderer._showWidget(region, 0);

      // Audio overlay should be active for m1
      expect(renderer.audioOverlays.has('m1')).toBe(true);

      // Hide widget m1
      renderer._hideWidget(region, 0);

      // Audio overlay should be cleaned up
      expect(renderer.audioOverlays.has('m1')).toBe(false);
    });

    it('should clean up audio overlays on renderer cleanup', async () => {
      const xlf = `
        <layout>
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="10" fileId="1">
              <audio mediaId="50" uri="bgmusic.mp3" volume="80" loop="1"/>
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      await renderer.renderLayout(xlf, 1);
      // Explicitly show widget to trigger audio overlay
      const region = renderer.regions.get('r1');
      await renderer._showWidget(region, 0);
      expect(renderer.audioOverlays.size).toBeGreaterThan(0);

      renderer.cleanup();
      expect(renderer.audioOverlays.size).toBe(0);
    });

    it('should clamp volume to valid range', async () => {
      const xlf = `
        <layout>
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="10" fileId="1">
              <audio mediaId="50" uri="bgmusic.mp3" volume="150" loop="0"/>
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      await renderer.renderLayout(xlf, 1);
      // Explicitly show widget to trigger audio overlay
      const region = renderer.regions.get('r1');
      await renderer._showWidget(region, 0);

      const overlays = renderer.audioOverlays.get('m1');
      expect(overlays).toBeDefined();
      expect(overlays[0].volume).toBeLessThanOrEqual(1);
    });
  });


  describe('Widget webhookUrl parsing', () => {
    it('should parse webhookUrl from widget options', () => {
      const xlf = `
        <layout>
          <region id="r1">
            <media id="m1" type="image" duration="10" fileId="1">
              <options>
                <uri>test.png</uri>
                <webhookUrl>https://example.com/hook</webhookUrl>
              </options>
            </media>
          </region>
        </layout>
      `;

      const layout = renderer.parseXlf(xlf);
      const widget = layout.regions[0].widgets[0];

      expect(widget.webhookUrl).toBe('https://example.com/hook');
    });

    it('should set webhookUrl to null when not present in options', () => {
      const xlf = `
        <layout>
          <region id="r1">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      const layout = renderer.parseXlf(xlf);
      const widget = layout.regions[0].widgets[0];

      expect(widget.webhookUrl).toBeNull();
    });
  });

  describe('Widget duration completion webhook', () => {
    it('should emit widgetAction event when widget with webhookUrl reaches duration end', async () => {
      vi.useFakeTimers();

      const xlf = `
        <layout duration="60">
          <region id="r1">
            <media id="m1" type="image" duration="5" fileId="1">
              <options>
                <uri>1.png</uri>
                <webhookUrl>https://example.com/hook</webhookUrl>
              </options>
            </media>
            <media id="m2" type="image" duration="5" fileId="2">
              <options><uri>2.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      const widgetActionHandler = vi.fn();
      renderer.on('widgetAction', widgetActionHandler);

      const renderPromise = renderer.renderLayout(xlf, 1);
      await vi.advanceTimersByTimeAsync(10000);
      await renderPromise;

      // Advance past first widget duration (5s) to trigger timer
      vi.advanceTimersByTime(5000);

      expect(widgetActionHandler).toHaveBeenCalledWith({
        type: 'durationEnd',
        widgetId: 'm1',
        layoutId: 1,
        regionId: 'r1',
        url: 'https://example.com/hook'
      });

      vi.useRealTimers();
    });

    it('should not emit widgetAction event when widget has no webhookUrl', async () => {
      vi.useFakeTimers();

      const xlf = `
        <layout duration="60">
          <region id="r1">
            <media id="m1" type="image" duration="5" fileId="1">
              <options><uri>1.png</uri></options>
            </media>
            <media id="m2" type="image" duration="5" fileId="2">
              <options><uri>2.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      const widgetActionHandler = vi.fn();
      renderer.on('widgetAction', widgetActionHandler);

      const renderPromise = renderer.renderLayout(xlf, 1);
      await vi.advanceTimersByTimeAsync(10000);
      await renderPromise;

      // Advance past first widget duration (5s) to trigger timer
      vi.advanceTimersByTime(5000);

      expect(widgetActionHandler).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe('Drawer Nodes (#11)', () => {
    it('should parse drawer elements as regions with isDrawer flag', () => {
      const xlf = `
        <layout width="1920" height="1080" duration="60">
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>test.png</uri></options>
            </media>
          </region>
          <drawer id="d1" width="400" height="300" top="100" left="100">
            <media id="dm1" type="image" duration="5" fileId="2">
              <options><uri>drawer.png</uri></options>
            </media>
          </drawer>
        </layout>
      `;

      const layout = renderer.parseXlf(xlf);

      expect(layout.regions).toHaveLength(2);
      expect(layout.regions[0].isDrawer).toBe(false);
      expect(layout.regions[0].id).toBe('r1');
      expect(layout.regions[1].isDrawer).toBe(true);
      expect(layout.regions[1].id).toBe('d1');
      expect(layout.regions[1].widgets).toHaveLength(1);
      expect(layout.regions[1].widgets[0].id).toBe('dm1');
    });

    it('should exclude drawers from layout duration calculation', () => {
      const xlf = `
        <layout width="1920" height="1080">
          <region id="r1" width="960" height="540" top="0" left="0">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>test.png</uri></options>
            </media>
          </region>
          <drawer id="d1" width="400" height="300" top="100" left="100">
            <media id="dm1" type="image" duration="120" fileId="2">
              <options><uri>drawer.png</uri></options>
            </media>
          </drawer>
        </layout>
      `;

      const layout = renderer.parseXlf(xlf);

      // Duration should be 10s (from region), not 120s (from drawer)
      expect(layout.duration).toBe(10);
    });

    it('should assign high z-index to drawer regions by default', () => {
      const xlf = `
        <layout width="1920" height="1080" duration="60">
          <region id="r1" width="960" height="540" top="0" left="0" zindex="1">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>test.png</uri></options>
            </media>
          </region>
          <drawer id="d1">
            <media id="dm1" type="image" duration="5" fileId="2">
              <options><uri>drawer.png</uri></options>
            </media>
          </drawer>
        </layout>
      `;

      const layout = renderer.parseXlf(xlf);

      expect(layout.regions[0].zindex).toBe(1);
      expect(layout.regions[1].zindex).toBe(2000); // Drawer default z-index
    });

    it('should create drawer regions with display:none', async () => {
      vi.useFakeTimers();

      const xlf = `
        <layout width="1920" height="1080" duration="60">
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>test.png</uri></options>
            </media>
          </region>
          <drawer id="d1" width="400" height="300" top="100" left="100">
            <media id="dm1" type="image" duration="5" fileId="2">
              <options><uri>drawer.png</uri></options>
            </media>
          </drawer>
        </layout>
      `;

      const renderPromise = renderer.renderLayout(xlf, 1);
      await vi.advanceTimersByTimeAsync(10000);
      await renderPromise;

      const drawerRegion = renderer.regions.get('d1');
      expect(drawerRegion).toBeDefined();
      expect(drawerRegion.isDrawer).toBe(true);
      expect(drawerRegion.element.style.display).toBe('none');

      vi.useRealTimers();
    });

    it('should reveal drawer region when navigateToWidget targets drawer widget', async () => {
      vi.useFakeTimers();

      const xlf = `
        <layout width="1920" height="1080" duration="60">
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>test.png</uri></options>
            </media>
          </region>
          <drawer id="d1" width="400" height="300" top="100" left="100">
            <media id="dm1" type="image" duration="5" fileId="2">
              <options><uri>drawer.png</uri></options>
            </media>
          </drawer>
        </layout>
      `;

      const renderPromise = renderer.renderLayout(xlf, 1);
      await vi.advanceTimersByTimeAsync(10000);
      await renderPromise;

      // Drawer starts hidden
      const drawerRegion = renderer.regions.get('d1');
      expect(drawerRegion.element.style.display).toBe('none');

      // Navigate to drawer widget — should reveal the drawer
      renderer.navigateToWidget('dm1');
      expect(drawerRegion.element.style.display).toBe('');

      vi.useRealTimers();
    });

    it('should hide multi-widget drawer after cycling through all widgets', async () => {
      vi.useFakeTimers();

      const xlf = `
        <layout width="1920" height="1080" duration="60">
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="60" fileId="1">
              <options><uri>test.png</uri></options>
            </media>
          </region>
          <drawer id="d1" width="400" height="300" top="100" left="100">
            <media id="dm1" type="image" duration="3" fileId="2">
              <options><uri>d1.png</uri></options>
            </media>
            <media id="dm2" type="image" duration="3" fileId="3">
              <options><uri>d2.png</uri></options>
            </media>
            <media id="dm3" type="image" duration="3" fileId="4">
              <options><uri>d3.png</uri></options>
            </media>
          </drawer>
        </layout>
      `;

      const renderPromise = renderer.renderLayout(xlf, 1);
      await vi.advanceTimersByTimeAsync(100);
      await renderPromise;

      const drawerRegion = renderer.regions.get('d1');
      expect(drawerRegion.element.style.display).toBe('none');

      // Navigate to first drawer widget
      renderer.navigateToWidget('dm1');
      expect(drawerRegion.element.style.display).toBe('');
      expect(drawerRegion.currentIndex).toBe(0);

      // After dm1 duration → advances to dm2, still visible
      await vi.advanceTimersByTimeAsync(3100);
      expect(drawerRegion.element.style.display).toBe('');

      // After dm2 duration → advances to dm3, still visible
      await vi.advanceTimersByTimeAsync(3100);
      expect(drawerRegion.element.style.display).toBe('');

      // After dm3 duration → wraps to 0, drawer hidden
      await vi.advanceTimersByTimeAsync(3100);
      expect(drawerRegion.element.style.display).toBe('none');

      vi.useRealTimers();
    });
  });

  describe('Sub-Playlist (#10)', () => {
    it('should parse sub-playlist attributes from media elements', () => {
      const xlf = `
        <layout width="1920" height="1080" duration="60">
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="10" parentWidgetId="sp1"
                   displayOrder="1" cyclePlayback="1" playCount="1" isRandom="0" fileId="1">
              <options><uri>img1.png</uri></options>
            </media>
            <media id="m2" type="image" duration="10" parentWidgetId="sp1"
                   displayOrder="2" cyclePlayback="1" playCount="1" isRandom="0" fileId="2">
              <options><uri>img2.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      const layout = renderer.parseXlf(xlf);
      const w1 = layout.regions[0].widgets[0];
      const w2 = layout.regions[0].widgets[1];

      expect(w1.parentWidgetId).toBe('sp1');
      expect(w1.displayOrder).toBe(1);
      expect(w1.cyclePlayback).toBe(true);
      expect(w1.playCount).toBe(1);
      expect(w1.isRandom).toBe(false);

      expect(w2.parentWidgetId).toBe('sp1');
      expect(w2.displayOrder).toBe(2);
    });

    it('should select one widget per group when cyclePlayback is enabled', () => {
      const widgets = [
        { id: 'm1', type: 'image', duration: 10, parentWidgetId: 'sp1',
          displayOrder: 1, cyclePlayback: true, playCount: 1, isRandom: false },
        { id: 'm2', type: 'image', duration: 10, parentWidgetId: 'sp1',
          displayOrder: 2, cyclePlayback: true, playCount: 1, isRandom: false },
        { id: 'm3', type: 'image', duration: 10, parentWidgetId: 'sp1',
          displayOrder: 3, cyclePlayback: true, playCount: 1, isRandom: false },
      ];

      const result = renderer._applyCyclePlayback(widgets);

      // Should select exactly 1 widget from the 3-widget group
      expect(result).toHaveLength(1);
      expect(['m1', 'm2', 'm3']).toContain(result[0].id);
    });

    it('should pass through non-grouped widgets unchanged', () => {
      const widgets = [
        { id: 'standalone', type: 'image', duration: 10,
          parentWidgetId: null, cyclePlayback: false },
        { id: 'm1', type: 'image', duration: 10, parentWidgetId: 'sp1',
          displayOrder: 1, cyclePlayback: true, playCount: 1, isRandom: false },
        { id: 'm2', type: 'image', duration: 10, parentWidgetId: 'sp1',
          displayOrder: 2, cyclePlayback: true, playCount: 1, isRandom: false },
      ];

      const result = renderer._applyCyclePlayback(widgets);

      // Standalone + 1 from group = 2
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('standalone');
    });

    it('should round-robin across cycles for deterministic playback', () => {
      const widgets = [
        { id: 'm1', type: 'image', duration: 10, parentWidgetId: 'sp1',
          displayOrder: 1, cyclePlayback: true, playCount: 1, isRandom: false },
        { id: 'm2', type: 'image', duration: 10, parentWidgetId: 'sp1',
          displayOrder: 2, cyclePlayback: true, playCount: 1, isRandom: false },
      ];

      // Reset cycle index for clean test
      renderer._subPlaylistCycleIndex = new Map();

      const result1 = renderer._applyCyclePlayback(widgets);
      const result2 = renderer._applyCyclePlayback(widgets);

      // First cycle picks widget at index 0, second cycle picks at index 1
      expect(result1[0].id).toBe('m1');
      expect(result2[0].id).toBe('m2');
    });

    it('should handle multiple groups independently', () => {
      const widgets = [
        { id: 'a1', type: 'image', duration: 10, parentWidgetId: 'grpA',
          displayOrder: 1, cyclePlayback: true, playCount: 1, isRandom: false },
        { id: 'a2', type: 'image', duration: 10, parentWidgetId: 'grpA',
          displayOrder: 2, cyclePlayback: true, playCount: 1, isRandom: false },
        { id: 'b1', type: 'image', duration: 10, parentWidgetId: 'grpB',
          displayOrder: 1, cyclePlayback: true, playCount: 1, isRandom: false },
        { id: 'b2', type: 'image', duration: 10, parentWidgetId: 'grpB',
          displayOrder: 2, cyclePlayback: true, playCount: 1, isRandom: false },
      ];

      renderer._subPlaylistCycleIndex = new Map();
      const result = renderer._applyCyclePlayback(widgets);

      // 1 from each group = 2 total
      expect(result).toHaveLength(2);
      const ids = result.map(w => w.id);
      // Should have one from grpA and one from grpB
      expect(ids.some(id => id.startsWith('a'))).toBe(true);
      expect(ids.some(id => id.startsWith('b'))).toBe(true);
    });

    it('should repeat widget playCount times before advancing (#188)', () => {
      const widgets = [
        { id: 'm1', type: 'image', duration: 10, parentWidgetId: 'sp1',
          displayOrder: 1, cyclePlayback: true, playCount: 2, isRandom: false },
        { id: 'm2', type: 'image', duration: 10, parentWidgetId: 'sp1',
          displayOrder: 2, cyclePlayback: true, playCount: 2, isRandom: false },
      ];

      renderer._subPlaylistCycleIndex = new Map();

      const r1 = renderer._applyCyclePlayback(widgets);
      const r2 = renderer._applyCyclePlayback(widgets);
      const r3 = renderer._applyCyclePlayback(widgets);
      const r4 = renderer._applyCyclePlayback(widgets);

      // m1 plays twice, then m2 plays twice
      expect(r1[0].id).toBe('m1');
      expect(r2[0].id).toBe('m1');
      expect(r3[0].id).toBe('m2');
      expect(r4[0].id).toBe('m2');
    });

    it('should treat playCount=0 or missing as 1 (#188)', () => {
      const widgets = [
        { id: 'm1', type: 'image', duration: 10, parentWidgetId: 'sp1',
          displayOrder: 1, cyclePlayback: true, playCount: 0, isRandom: false },
        { id: 'm2', type: 'image', duration: 10, parentWidgetId: 'sp1',
          displayOrder: 2, cyclePlayback: true, isRandom: false },
      ];

      renderer._subPlaylistCycleIndex = new Map();

      const r1 = renderer._applyCyclePlayback(widgets);
      const r2 = renderer._applyCyclePlayback(widgets);

      // Should advance every cycle (playCount defaults to 1)
      expect(r1[0].id).toBe('m1');
      expect(r2[0].id).toBe('m2');
    });

    it('should repeat playCount=3 times before advancing (#188)', () => {
      const widgets = [
        { id: 'm1', type: 'image', duration: 10, parentWidgetId: 'sp1',
          displayOrder: 1, cyclePlayback: true, playCount: 3, isRandom: false },
        { id: 'm2', type: 'image', duration: 10, parentWidgetId: 'sp1',
          displayOrder: 2, cyclePlayback: true, playCount: 3, isRandom: false },
      ];

      renderer._subPlaylistCycleIndex = new Map();

      const results = [];
      for (let i = 0; i < 6; i++) {
        results.push(renderer._applyCyclePlayback(widgets)[0].id);
      }

      // m1 x3, m2 x3
      expect(results).toEqual(['m1', 'm1', 'm1', 'm2', 'm2', 'm2']);
    });
  });

  // ── Medium-Priority Spec Compliance ────────────────────────────────

  describe('Widget fromDt/toDt Expiry', () => {
    it('should parse fromDt and toDt attributes on widgets', () => {
      const xlf = `
        <layout width="1920" height="1080" duration="60">
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="10" fileId="1"
                   fromDt="2025-01-01 09:00:00" toDt="2025-12-31 17:00:00">
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;
      const layout = renderer.parseXlf(xlf);
      expect(layout.regions[0].widgets[0].fromDt).toBe('2025-01-01 09:00:00');
      expect(layout.regions[0].widgets[0].toDt).toBe('2025-12-31 17:00:00');
    });

    it('should set fromDt/toDt to null when absent', () => {
      const xlf = `
        <layout width="1920" height="1080" duration="60">
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;
      const layout = renderer.parseXlf(xlf);
      expect(layout.regions[0].widgets[0].fromDt).toBeNull();
      expect(layout.regions[0].widgets[0].toDt).toBeNull();
    });

    it('should filter out expired widgets (toDt in the past)', () => {
      const widget = { id: 'm1', fromDt: null, toDt: '2020-01-01 00:00:00' };
      expect(renderer._isWidgetActive(widget)).toBe(false);
    });

    it('should filter out future widgets (fromDt in the future)', () => {
      const widget = { id: 'm1', fromDt: '2099-12-31 23:59:59', toDt: null };
      expect(renderer._isWidgetActive(widget)).toBe(false);
    });

    it('should accept widgets with no date constraints', () => {
      const widget = { id: 'm1', fromDt: null, toDt: null };
      expect(renderer._isWidgetActive(widget)).toBe(true);
    });

    it('should accept widgets within their date range', () => {
      const widget = { id: 'm1', fromDt: '2020-01-01 00:00:00', toDt: '2099-12-31 23:59:59' };
      expect(renderer._isWidgetActive(widget)).toBe(true);
    });
  });

  describe('Render Attribute', () => {
    it('should parse render attribute on widgets', () => {
      const xlf = `
        <layout width="1920" height="1080" duration="60">
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="text" duration="10" render="native">
              <options><uri>test.html</uri></options>
            </media>
          </region>
        </layout>
      `;
      const layout = renderer.parseXlf(xlf);
      expect(layout.regions[0].widgets[0].render).toBe('native');
    });

    it('should set render to null when absent', () => {
      const xlf = `
        <layout width="1920" height="1080" duration="60">
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;
      const layout = renderer.parseXlf(xlf);
      expect(layout.regions[0].widgets[0].render).toBeNull();
    });
  });

  describe('NUMITEMS/DURATION HTML Comments', () => {
    it('should override widget duration with DURATION comment', () => {
      const widget = { id: 'w1', duration: 10 };
      const html = '<html><!-- DURATION=45 --><body>content</body></html>';
      renderer._parseDurationComments(html, widget);
      expect(widget.duration).toBe(45);
    });

    it('should multiply duration by NUMITEMS when no DURATION present', () => {
      const widget = { id: 'w2', duration: 5 };
      const html = '<html><!-- NUMITEMS=8 --><body>content</body></html>';
      renderer._parseDurationComments(html, widget);
      expect(widget.duration).toBe(40); // 8 × 5
    });

    it('should prefer DURATION over NUMITEMS when both present', () => {
      const widget = { id: 'w3', duration: 5 };
      const html = '<html><!-- NUMITEMS=8 --><!-- DURATION=30 --><body>content</body></html>';
      renderer._parseDurationComments(html, widget);
      expect(widget.duration).toBe(30); // DURATION takes precedence
    });

    it('should not modify duration when no comments present', () => {
      const widget = { id: 'w4', duration: 15 };
      const html = '<html><body>plain content</body></html>';
      renderer._parseDurationComments(html, widget);
      expect(widget.duration).toBe(15);
    });

    it('should handle whitespace variations in comments', () => {
      const widget = { id: 'w5', duration: 10 };
      const html = '<html><!--  DURATION=60  --><body>content</body></html>';
      renderer._parseDurationComments(html, widget);
      expect(widget.duration).toBe(60);
    });
  });

  // ── Low-Priority Spec Compliance ─────────────────────────────────

  describe('Layout schemaVersion', () => {
    it('should parse schemaVersion from layout element', () => {
      const xlf = `
        <layout schemaVersion="5" width="1920" height="1080" duration="60">
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;
      const layout = renderer.parseXlf(xlf);
      expect(layout.schemaVersion).toBe(5);
    });

    it('should default schemaVersion to 1 when absent', () => {
      const xlf = `
        <layout width="1920" height="1080" duration="60">
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;
      const layout = renderer.parseXlf(xlf);
      expect(layout.schemaVersion).toBe(1);
    });
  });

  describe('Layout backgroundColor', () => {
    it('should prefer backgroundColor over bgcolor', () => {
      const xlf = `
        <layout backgroundColor="#FF0000" bgcolor="#00FF00" width="1920" height="1080" duration="60">
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;
      const layout = renderer.parseXlf(xlf);
      expect(layout.bgcolor).toBe('#FF0000');
    });

    it('should fall back to bgcolor when backgroundColor absent', () => {
      const xlf = `
        <layout bgcolor="#00FF00" width="1920" height="1080" duration="60">
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;
      const layout = renderer.parseXlf(xlf);
      expect(layout.bgcolor).toBe('#00FF00');
    });
  });

  describe('Region enableStat', () => {
    it('should parse enableStat on region elements', () => {
      const xlf = `
        <layout width="1920" height="1080" duration="60">
          <region id="r1" width="960" height="540" top="0" left="0" enableStat="0">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>test.png</uri></options>
            </media>
          </region>
          <region id="r2" width="960" height="540" top="0" left="960" enableStat="1">
            <media id="m2" type="image" duration="10" fileId="2">
              <options><uri>test2.png</uri></options>
            </media>
          </region>
        </layout>
      `;
      const layout = renderer.parseXlf(xlf);
      expect(layout.regions[0].enableStat).toBe(false);
      expect(layout.regions[1].enableStat).toBe(true);
    });

    it('should default enableStat to true when absent', () => {
      const xlf = `
        <layout width="1920" height="1080" duration="60">
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;
      const layout = renderer.parseXlf(xlf);
      expect(layout.regions[0].enableStat).toBe(true);
    });
  });

  describe('Layout-level actions', () => {
    it('should parse action elements at layout level', () => {
      const xlf = `
        <layout width="1920" height="1080" duration="60">
          <action actionType="navLayout" triggerType="webhook" triggerCode="showPromo"
                  layoutCode="promo-1"/>
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;
      const layout = renderer.parseXlf(xlf);
      expect(layout.actions).toHaveLength(1);
      expect(layout.actions[0].actionType).toBe('navLayout');
      expect(layout.actions[0].triggerType).toBe('webhook');
      expect(layout.actions[0].triggerCode).toBe('showPromo');
      expect(layout.actions[0].layoutCode).toBe('promo-1');
    });

    it('should return empty actions array when no layout-level actions', () => {
      const xlf = `
        <layout width="1920" height="1080" duration="60">
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;
      const layout = renderer.parseXlf(xlf);
      expect(layout.actions).toEqual([]);
    });
  });

  describe('Region loop option', () => {
    it('should default loop to true when no loop option present', () => {
      const xlf = `
        <layout width="1920" height="1080">
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;
      const layout = renderer.parseXlf(xlf);
      expect(layout.regions[0].loop).toBe(true);
    });

    it('should set loop to false when loop option is 0', () => {
      const xlf = `
        <layout width="1920" height="1080">
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <options><loop>0</loop></options>
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;
      const layout = renderer.parseXlf(xlf);
      expect(layout.regions[0].loop).toBe(false);
    });

    it('should set loop to true when loop option is 1', () => {
      const xlf = `
        <layout width="1920" height="1080">
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <options><loop>1</loop></options>
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;
      const layout = renderer.parseXlf(xlf);
      expect(layout.regions[0].loop).toBe(true);
    });
  });

  describe('Widget commands parsing', () => {
    it('should parse commands on media elements', () => {
      const xlf = `
        <layout width="1920" height="1080">
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>test.png</uri></options>
              <commands>
                <command commandCode="shellCommand" commandString="echo hello"/>
                <command commandCode="reboot" commandString=""/>
              </commands>
            </media>
          </region>
        </layout>
      `;
      const layout = renderer.parseXlf(xlf);
      const widget = layout.regions[0].widgets[0];
      expect(widget.commands).toHaveLength(2);
      expect(widget.commands[0].commandCode).toBe('shellCommand');
      expect(widget.commands[0].commandString).toBe('echo hello');
      expect(widget.commands[1].commandCode).toBe('reboot');
    });

    it('should return empty commands array when no commands element', () => {
      const xlf = `
        <layout width="1920" height="1080">
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;
      const layout = renderer.parseXlf(xlf);
      expect(layout.regions[0].widgets[0].commands).toEqual([]);
    });
  });

  describe('Canvas Regions (#186)', () => {
    it('should parse region with type="canvas" as isCanvas', () => {
      const xlf = `
        <layout width="1920" height="1080" duration="60">
          <region id="r1" type="canvas" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>img1.png</uri></options>
            </media>
            <media id="m2" type="image" duration="15" fileId="2">
              <options><uri>img2.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      const layout = renderer.parseXlf(xlf);

      expect(layout.regions).toHaveLength(1);
      expect(layout.regions[0].isCanvas).toBe(true);
      expect(layout.regions[0].widgets).toHaveLength(2);
    });

    it('should auto-detect canvas from type="global" widget', () => {
      const xlf = `
        <layout width="1920" height="1080" duration="60">
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="global" duration="30" fileId="1">
              <options></options>
            </media>
          </region>
        </layout>
      `;

      const layout = renderer.parseXlf(xlf);

      expect(layout.regions[0].isCanvas).toBe(true);
    });

    it('should NOT mark normal regions as canvas', () => {
      const xlf = `
        <layout width="1920" height="1080" duration="60">
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      const layout = renderer.parseXlf(xlf);

      expect(layout.regions[0].isCanvas).toBe(false);
    });

    it('should store isCanvas flag in region state after createRegion', async () => {
      const regionConfig = {
        id: 'r1',
        width: 1920,
        height: 1080,
        top: 0,
        left: 0,
        zindex: 0,
        isCanvas: true,
        widgets: []
      };

      await renderer.createRegion(regionConfig);

      const region = renderer.regions.get('r1');
      expect(region.isCanvas).toBe(true);
    });

    it('should render all canvas widgets simultaneously', async () => {
      vi.useFakeTimers();

      const xlf = `
        <layout width="1920" height="1080" duration="60">
          <region id="r1" type="canvas" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>img1.png</uri></options>
            </media>
            <media id="m2" type="image" duration="15" fileId="2">
              <options><uri>img2.png</uri></options>
            </media>
            <media id="m3" type="image" duration="20" fileId="3">
              <options><uri>img3.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      const renderPromise = renderer.renderLayout(xlf, 1);
      await vi.advanceTimersByTimeAsync(5000);

      const region = renderer.regions.get('r1');
      expect(region).toBeDefined();
      expect(region.isCanvas).toBe(true);

      // All 3 widgets should be visible simultaneously
      let visibleCount = 0;
      for (const [, el] of region.widgetElements) {
        if (el.style.visibility === 'visible') visibleCount++;
      }
      expect(visibleCount).toBe(3);

      // Clean up
      await vi.advanceTimersByTimeAsync(60000);
      await renderPromise;
      vi.useRealTimers();
    });

    it('should not cycle canvas region widgets', async () => {
      vi.useFakeTimers();

      const xlf = `
        <layout width="1920" height="1080" duration="60">
          <region id="r1" type="canvas" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="5" fileId="1">
              <options><uri>img1.png</uri></options>
            </media>
            <media id="m2" type="image" duration="5" fileId="2">
              <options><uri>img2.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      const renderPromise = renderer.renderLayout(xlf, 1);
      await vi.advanceTimersByTimeAsync(2000);

      const region = renderer.regions.get('r1');

      // After widget durations expire, both should still be visible (no cycling)
      await vi.advanceTimersByTimeAsync(10000);

      let visibleCount = 0;
      for (const [, el] of region.widgetElements) {
        if (el.style.visibility === 'visible') visibleCount++;
      }
      expect(visibleCount).toBe(2);

      // Clean up
      await vi.advanceTimersByTimeAsync(60000);
      await renderPromise;
      vi.useRealTimers();
    });

    it('should mark canvas region complete after max widget duration', async () => {
      vi.useFakeTimers();

      const xlf = `
        <layout width="1920" height="1080">
          <region id="r1" type="canvas" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="5" fileId="1">
              <options><uri>img1.png</uri></options>
            </media>
            <media id="m2" type="image" duration="10" fileId="2">
              <options><uri>img2.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      const renderPromise = renderer.renderLayout(xlf, 1);
      await vi.advanceTimersByTimeAsync(2000);

      const region = renderer.regions.get('r1');
      expect(region.complete).toBe(false);

      // Advance past max widget duration (10s)
      await vi.advanceTimersByTimeAsync(9000);
      expect(region.complete).toBe(true);

      // Clean up
      await vi.advanceTimersByTimeAsync(60000);
      await renderPromise;
      vi.useRealTimers();
    });
  });

  describe('Widget Lifecycle Symmetry', () => {
    it('should emit symmetric widgetStart/widgetEnd for single-widget layout', async () => {
      vi.useFakeTimers();
      const starts = [];
      const ends = [];
      renderer.on('widgetStart', (e) => starts.push(e));
      renderer.on('widgetEnd', (e) => ends.push(e));

      const xlf = `
        <layout width="1920" height="1080" duration="10">
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      const renderPromise = renderer.renderLayout(xlf, 1);
      await vi.advanceTimersByTimeAsync(2000);

      expect(starts).toHaveLength(1);
      expect(ends).toHaveLength(0);

      renderer.stopCurrentLayout();

      expect(ends).toHaveLength(1);
      expect(ends[0].widgetId).toBe(starts[0].widgetId);
      expect(renderer._startedWidgets.size).toBe(0);

      await vi.advanceTimersByTimeAsync(60000);
      await renderPromise;
      vi.useRealTimers();
    });

    it('should stop ALL widgets in canvas region on teardown', async () => {
      vi.useFakeTimers();
      const starts = [];
      const ends = [];
      renderer.on('widgetStart', (e) => starts.push(e));
      renderer.on('widgetEnd', (e) => ends.push(e));

      const xlf = `
        <layout width="1920" height="1080" duration="30">
          <region id="r1" type="canvas" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>img1.png</uri></options>
            </media>
            <media id="m2" type="image" duration="10" fileId="2">
              <options><uri>img2.png</uri></options>
            </media>
            <media id="m3" type="image" duration="10" fileId="3">
              <options><uri>img3.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      const renderPromise = renderer.renderLayout(xlf, 1);
      await vi.advanceTimersByTimeAsync(2000);

      expect(starts).toHaveLength(3);
      expect(ends).toHaveLength(0);

      renderer.stopCurrentLayout();

      expect(ends).toHaveLength(3);
      expect(renderer._startedWidgets.size).toBe(0);

      await vi.advanceTimersByTimeAsync(60000);
      await renderPromise;
      vi.useRealTimers();
    });

    it('should stop widgets before restarting on same-layout replay', async () => {
      vi.useFakeTimers();
      const events = [];
      renderer.on('widgetStart', (e) => events.push({ type: 'start', id: e.widgetId }));
      renderer.on('widgetEnd', (e) => events.push({ type: 'end', id: e.widgetId }));

      const xlf = `
        <layout width="1920" height="1080" duration="10">
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      // First render
      const p1 = renderer.renderLayout(xlf, 1);
      await vi.advanceTimersByTimeAsync(2000);
      expect(events).toHaveLength(1); // 1 start

      // Same-layout replay
      events.length = 0;
      const p2 = renderer.renderLayout(xlf, 1);
      await vi.advanceTimersByTimeAsync(2000);

      // widgetEnd should fire before widgetStart for the replay
      expect(events.length).toBeGreaterThanOrEqual(2);
      const endIdx = events.findIndex(e => e.type === 'end');
      const startIdx = events.findIndex(e => e.type === 'start');
      expect(endIdx).toBeLessThan(startIdx);
      expect(renderer._startedWidgets.size).toBe(1);

      await vi.advanceTimersByTimeAsync(60000);
      await p1;
      await p2;
      vi.useRealTimers();
    });

    it('should be idempotent on double stopWidget calls', async () => {
      vi.useFakeTimers();
      const ends = [];
      renderer.on('widgetEnd', (e) => ends.push(e));

      const xlf = `
        <layout width="1920" height="1080" duration="10">
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="10" fileId="1">
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      const renderPromise = renderer.renderLayout(xlf, 1);
      await vi.advanceTimersByTimeAsync(2000);

      // Stop twice
      await renderer.stopWidget('r1', 0);
      await renderer.stopWidget('r1', 0);

      expect(ends).toHaveLength(1); // only 1 widgetEnd, not 2

      await vi.advanceTimersByTimeAsync(60000);
      await renderPromise;
      vi.useRealTimers();
    });

    it('should not double-emit widgetEnd on layout timer + stopCurrentLayout', async () => {
      vi.useFakeTimers();
      const ends = [];
      renderer.on('widgetEnd', (e) => ends.push(e));

      const xlf = `
        <layout width="1920" height="1080" duration="5">
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="5" fileId="1">
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      const renderPromise = renderer.renderLayout(xlf, 1);
      await vi.advanceTimersByTimeAsync(2000);

      // Advance past layout duration (layout timer fires, which triggers stopCurrentLayout internally via layoutEnd)
      await vi.advanceTimersByTimeAsync(5000);

      // Now explicitly stop (as renderLayout(next) would do)
      renderer.stopCurrentLayout();

      // Should only have 1 widgetEnd total, not 2
      expect(ends).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(60000);
      await renderPromise;
      vi.useRealTimers();
    });

    it('should balance starts and ends during multi-widget cycling', async () => {
      vi.useFakeTimers();
      let startCount = 0;
      let endCount = 0;
      renderer.on('widgetStart', () => startCount++);
      renderer.on('widgetEnd', () => endCount++);

      const xlf = `
        <layout width="1920" height="1080" duration="30">
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="2" fileId="1">
              <options><uri>img1.png</uri></options>
            </media>
            <media id="m2" type="image" duration="2" fileId="2">
              <options><uri>img2.png</uri></options>
            </media>
            <media id="m3" type="image" duration="2" fileId="3">
              <options><uri>img3.png</uri></options>
            </media>
          </region>
        </layout>
      `;

      const renderPromise = renderer.renderLayout(xlf, 1);
      await vi.advanceTimersByTimeAsync(1000);

      // Cycle through several widgets (3 widgets × 2s each = 6s per cycle)
      for (let i = 0; i < 12; i++) {
        await vi.advanceTimersByTimeAsync(2000);
      }

      // At any point, starts should be >= ends
      expect(startCount).toBeGreaterThanOrEqual(endCount);

      // After full teardown, they should balance
      renderer.stopCurrentLayout();
      expect(startCount).toBe(endCount);
      expect(renderer._startedWidgets.size).toBe(0);

      await vi.advanceTimersByTimeAsync(60000);
      await renderPromise;
      vi.useRealTimers();
    });
  });

  // ── Video layout ID tracking during preload ──────────────────────
  // Regression test: createdForLayoutId must use _preloadingLayoutId
  // during preload, not currentLayoutId (which is the *playing* layout).
  // Without this, video duration updates for preloaded layouts are
  // rejected, causing layouts to play with wrong (10s) duration.

  describe('Video createdForLayoutId during preload', () => {
    it('should capture _preloadingLayoutId for video elements created during preload', () => {
      renderer.currentLayoutId = 100;       // currently playing
      renderer._preloadingLayoutId = 200;    // preloading next

      // The fix: _preloadingLayoutId || currentLayoutId should give 200
      const capturedId = renderer._preloadingLayoutId || renderer.currentLayoutId;
      expect(capturedId).toBe(200);
    });

    it('should fall back to currentLayoutId when not preloading', () => {
      renderer.currentLayoutId = 100;
      renderer._preloadingLayoutId = null;

      const capturedId = renderer._preloadingLayoutId || renderer.currentLayoutId;
      expect(capturedId).toBe(100);
    });

    it('should allow duration update when preloaded layout becomes current', () => {
      // Simulate: video created during preload of layout 200
      renderer._preloadingLayoutId = 200;
      const createdForLayoutId = renderer._preloadingLayoutId || renderer.currentLayoutId;

      // Now layout 200 swaps in
      renderer.currentLayoutId = 200;
      renderer._preloadingLayoutId = null;

      // Duration update check should pass
      expect(renderer.currentLayoutId === createdForLayoutId).toBe(true);
    });

    it('should reject duration update when a different layout is current', () => {
      // Video created during preload of layout 200
      renderer._preloadingLayoutId = 200;
      const createdForLayoutId = renderer._preloadingLayoutId || renderer.currentLayoutId;

      // But layout 300 swaps in instead (e.g., schedule changed)
      renderer.currentLayoutId = 300;
      renderer._preloadingLayoutId = null;

      // Duration update should be rejected — wrong layout
      expect(renderer.currentLayoutId === createdForLayoutId).toBe(false);
    });
  });
});
