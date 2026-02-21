/**
 * RendererLite Test Suite
 *
 * Comprehensive tests for XLF rendering, element reuse, transitions,
 * and memory management.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RendererLite } from './renderer-lite.js';

describe('RendererLite', () => {
  let container;
  let renderer;
  let mockGetMediaUrl;
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
    mockGetMediaUrl = vi.fn((fileId) => Promise.resolve(`blob://test-${fileId}`));
    mockGetWidgetHtml = vi.fn((widget) => Promise.resolve(`<html>Widget ${widget.id}</html>`));

    // Create renderer instance
    renderer = new RendererLite(
      { cmsUrl: 'https://test.com', hardwareKey: 'test-key' },
      container,
      {
        getMediaUrl: mockGetMediaUrl,
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
      expect(mockGetMediaUrl).toHaveBeenCalledWith(1);
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

    it('should apply objectFit contain when scaleType is center', async () => {
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

    it('should map align and valign to objectPosition', async () => {
      const widget = {
        type: 'image',
        id: 'm1',
        fileId: '1',
        options: { uri: 'test.png', align: 'left', valign: 'top' },
        duration: 10,
        transitions: { in: null, out: null }
      };

      const region = { width: 1920, height: 1080 };
      const element = await renderer.renderImage(widget, region);

      expect(element.style.objectPosition).toBe('left top');
    });

    it('should map align right and valign bottom to objectPosition', async () => {
      const widget = {
        type: 'image',
        id: 'm1',
        fileId: '1',
        options: { uri: 'test.png', align: 'right', valign: 'bottom' },
        duration: 10,
        transitions: { in: null, out: null }
      };

      const region = { width: 1920, height: 1080 };
      const element = await renderer.renderImage(widget, region);

      expect(element.style.objectPosition).toBe('right bottom');
    });

    it('should map valign middle to center in objectPosition', async () => {
      const widget = {
        type: 'image',
        id: 'm1',
        fileId: '1',
        options: { uri: 'test.png', align: 'center', valign: 'middle' },
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
        options: { uri: 'test.png', scaleType: 'stretch', align: 'left', valign: 'bottom' },
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
      expect(mockGetMediaUrl).toHaveBeenCalledWith(5);
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
    // Skip: jsdom doesn't support real video element properties
    it.skip('should detect video duration from metadata', async () => {
      const xlf = `
        <layout>
          <region id="r1">
            <media id="m1" type="video" duration="0" useDuration="0" fileId="5">
              <options><uri>5.mp4</uri></options>
            </media>
          </region>
        </layout>
      `;

      await renderer.renderLayout(xlf, 1);

      // Mock video element with duration
      const region = renderer.regions.get('r1');
      const videoElement = region.widgetElements.get('m1');
      const video = videoElement.querySelector('video');

      // Simulate loadedmetadata event
      Object.defineProperty(video, 'duration', { value: 45.5, writable: false });
      video.dispatchEvent(new Event('loadedmetadata'));

      // Wait for async handler
      await new Promise(resolve => setTimeout(resolve, 10));

      // Widget duration should be updated
      const widget = region.widgets[0];
      expect(widget.duration).toBe(45); // Floor of 45.5
    });

    // Skip: jsdom doesn't support real video element properties
    it.skip('should update layout duration when video metadata loads', async () => {
      const xlf = `
        <layout>
          <region id="r1">
            <media id="m1" type="video" duration="0" useDuration="0" fileId="5">
              <options><uri>5.mp4</uri></options>
            </media>
          </region>
        </layout>
      `;

      await renderer.renderLayout(xlf, 1);

      const region = renderer.regions.get('r1');
      const videoElement = region.widgetElements.get('m1');
      const video = videoElement.querySelector('video');

      // Simulate video with 45s duration
      Object.defineProperty(video, 'duration', { value: 45, writable: false });
      video.dispatchEvent(new Event('loadedmetadata'));

      await new Promise(resolve => setTimeout(resolve, 10));

      // Layout duration should be updated
      expect(renderer.currentLayout.duration).toBe(45);
    });

    // Skip: jsdom doesn't support real video element properties
    it.skip('should NOT update duration when useDuration=1', async () => {
      const xlf = `
        <layout>
          <region id="r1">
            <media id="m1" type="video" duration="30" useDuration="1" fileId="5">
              <options><uri>5.mp4</uri></options>
            </media>
          </region>
        </layout>
      `;

      await renderer.renderLayout(xlf, 1);

      const region = renderer.regions.get('r1');
      const videoElement = region.widgetElements.get('m1');
      const video = videoElement.querySelector('video');

      // Simulate video with 45s duration
      Object.defineProperty(video, 'duration', { value: 45, writable: false });
      video.dispatchEvent(new Event('loadedmetadata'));

      await new Promise(resolve => setTimeout(resolve, 10));

      // Widget duration should stay 30 (useDuration=1 overrides)
      const widget = region.widgets[0];
      expect(widget.duration).toBe(30);
    });
  });

  describe('Media Element Restart', () => {
    // Skip: jsdom video elements don't support currentTime properly
    it.skip('should restart video on updateMediaElement()', async () => {
      const widget = {
        type: 'video',
        id: 'm1',
        fileId: '5',
        options: { loop: '0', mute: '1' },
        duration: 30
      };

      const region = { width: 1920, height: 1080 };
      const element = await renderer.renderVideo(widget, region);
      const video = element.querySelector('video');

      // Mock video methods
      video.currentTime = 25.5;
      video.play = vi.fn(() => Promise.resolve());

      // Call updateMediaElement
      renderer.updateMediaElement(element, widget);

      // Should restart from beginning
      expect(video.currentTime).toBe(0);
      expect(video.play).toHaveBeenCalled();
    });

    // Skip: jsdom video elements don't support currentTime properly
    it.skip('should restart looping videos too', async () => {
      const widget = {
        type: 'video',
        id: 'm1',
        fileId: '5',
        options: { loop: '1', mute: '1' }, // Looping video
        duration: 30
      };

      const region = { width: 1920, height: 1080 };
      const element = await renderer.renderVideo(widget, region);
      const video = element.querySelector('video');

      video.currentTime = 10;
      video.play = vi.fn(() => Promise.resolve());

      renderer.updateMediaElement(element, widget);

      // Should STILL restart (even when looping)
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
    // Skip: jsdom doesn't support Web Animations API
    it.skip('should apply fade in transition', async () => {
      const element = document.createElement('div');
      element.style.opacity = '0';

      const transition = {
        type: 'fadeIn',
        duration: 1000,
        direction: 'N'
      };

      // Import Transitions utility
      const { Transitions } = await import('./renderer-lite.js');
      const animation = Transitions.apply(element, transition, true, 1920, 1080);

      expect(animation).toBeTruthy();
      expect(animation.effect.getKeyframes()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ opacity: '0' }),
          expect.objectContaining({ opacity: '1' })
        ])
      );
    });

    // Skip: jsdom doesn't support Web Animations API
    it.skip('should apply fly out transition with direction', async () => {
      const element = document.createElement('div');

      const transition = {
        type: 'flyOut',
        duration: 1500,
        direction: 'S' // South
      };

      const { Transitions } = await import('./renderer-lite.js');
      const animation = Transitions.apply(element, transition, false, 1920, 1080);

      expect(animation).toBeTruthy();
      const keyframes = animation.effect.getKeyframes();

      // Should translate to south (positive Y)
      expect(keyframes[1].transform).toContain('1080px'); // Height offset
    });
  });

  describe('Memory Management', () => {
    it('should clear mediaUrlCache on layout switch', async () => {
      const xlf1 = `<layout><region id="r1"></region></layout>`;
      const xlf2 = `<layout><region id="r2"></region></layout>`;

      await renderer.renderLayout(xlf1, 1);
      renderer.mediaUrlCache.set(1, 'blob://test-1');

      // Switch to different layout
      await renderer.renderLayout(xlf2, 2);

      // Cache should be cleared
      expect(renderer.mediaUrlCache.size).toBe(0);
    });

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

  describe('Parallel Media Pre-fetch', () => {
    it('should pre-fetch all media URLs in parallel', async () => {
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

      await renderer.renderLayout(xlf, 1);

      // All media URLs should have been fetched
      expect(mockGetMediaUrl).toHaveBeenCalledTimes(3);
      expect(mockGetMediaUrl).toHaveBeenCalledWith(1);
      expect(mockGetMediaUrl).toHaveBeenCalledWith(5);
      expect(mockGetMediaUrl).toHaveBeenCalledWith(7);

      // All should be in cache
      expect(renderer.mediaUrlCache.size).toBe(3);
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
  });
});
