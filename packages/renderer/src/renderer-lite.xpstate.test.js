// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * RendererLite — SMIL State Track B integration tests.
 *
 * Track A folds static `expr=`/`{AVT}` against `xp:state-init` at
 * build time; anything the folder can't prove false is emitted into
 * the XLF as an `xpIf=` pass-through attribute. These tests exercise
 * the runtime side of the contract — when the renderer has an
 * XpStateStore injected, `xpIf=` gates widget visibility and updates
 * live on state mutation.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { RendererLite } from './renderer-lite.js';
import { XpStateStore } from '@xiboplayer/expr';

describe('RendererLite — SMIL State Track B (xpIf runtime gating)', () => {
  beforeAll(() => {
    const proto = window.HTMLMediaElement.prototype;
    proto.play = vi.fn(() => Promise.resolve());
    proto.pause = vi.fn();
    proto.load = vi.fn();
  });

  let container;
  let renderer;

  beforeEach(() => {
    container = document.createElement('div');
    container.id = 'xpstate-container';
    document.body.appendChild(container);
    renderer = new RendererLite(
      { cmsUrl: 'https://test.com', hardwareKey: 'test-key' },
      container,
      { fileIdToSaveAs: new Map() }
    );
  });

  afterEach(() => {
    renderer.cleanup();
    container.remove();
  });

  describe('parseWidget — xp:* pass-through attributes', () => {
    it('captures xpIf / xpDayPart / xpDatasource / xpJsonpath / xpMatch from XLF', () => {
      const xml = `
        <layout width="1920" height="1080" duration="60">
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="10" fileId="1"
                   xpIf="kioskMode = 'airport'"
                   xpDayPart="9-17"
                   xpDatasource="feed"
                   xpJsonpath="$.items[0].status"
                   xpMatch="open">
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;
      const layout = renderer.parseXlf(xml);
      const w = layout.regions[0].widgets[0];
      expect(w.xpIf).toBe("kioskMode = 'airport'");
      expect(w.xpDayPart).toBe('9-17');
      expect(w.xpDatasource).toBe('feed');
      expect(w.xpJsonpath).toBe('$.items[0].status');
      expect(w.xpMatch).toBe('open');
    });

    it('leaves xp:* attributes null when absent', () => {
      const xml = `
        <layout width="1920" height="1080" duration="60">
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="10">
              <options><uri>test.png</uri></options>
            </media>
          </region>
        </layout>
      `;
      const layout = renderer.parseXlf(xml);
      const w = layout.regions[0].widgets[0];
      expect(w.xpIf).toBeNull();
      expect(w.xpDayPart).toBeNull();
      expect(w.xpDatasource).toBeNull();
      expect(w.xpJsonpath).toBeNull();
      expect(w.xpMatch).toBeNull();
    });
  });

  describe('setStateStore / getStateStore', () => {
    it('stores injected XpStateStore and exposes it via getter', () => {
      const store = new XpStateStore({ initialState: { kioskMode: 'airport' } });
      renderer.setStateStore(store);
      expect(renderer.getStateStore()).toBe(store);
    });

    it('accepts null to disable runtime gating', () => {
      const store = new XpStateStore();
      renderer.setStateStore(store);
      renderer.setStateStore(null);
      expect(renderer.getStateStore()).toBeNull();
    });

    it('swaps stores cleanly without leaking the previous subscription', () => {
      const store1 = new XpStateStore({ initialState: { m: 'a' } });
      const store2 = new XpStateStore({ initialState: { m: 'b' } });
      const reevaluateSpy = vi.spyOn(renderer, 'reevaluateXpIf');
      renderer.setStateStore(store1);
      renderer.setStateStore(store2);

      // Mutating store1 should NOT trigger reevaluateXpIf anymore.
      reevaluateSpy.mockClear();
      store1.set('m', 'c');
      expect(reevaluateSpy).not.toHaveBeenCalled();

      // Mutating store2 SHOULD trigger it.
      store2.set('m', 'd');
      expect(reevaluateSpy).toHaveBeenCalled();
    });
  });

  describe('_evaluateXpIf — guard evaluation', () => {
    it('returns true for widget without xpIf', () => {
      expect(renderer._evaluateXpIf({ id: 'w1' })).toBe(true);
    });

    it('returns true when no store is injected (pre-Track-B behaviour)', () => {
      expect(renderer._evaluateXpIf({ id: 'w1', xpIf: "x = 'y'" })).toBe(true);
    });

    it('evaluates against store and returns boolean', () => {
      const store = new XpStateStore({ initialState: { kioskMode: 'airport' } });
      renderer.setStateStore(store);
      expect(renderer._evaluateXpIf({ id: 'w1', xpIf: "kioskMode = 'airport'" })).toBe(true);
      expect(renderer._evaluateXpIf({ id: 'w1', xpIf: "kioskMode = 'hotel'" })).toBe(false);
    });

    it('hides widget on evaluation error (unknown identifier → safe default)', () => {
      const store = new XpStateStore({ initialState: {} });
      renderer.setStateStore(store);
      // Silence the warn log for the expected failure.
      const logSpy = vi.spyOn(renderer.log, 'warn').mockImplementation(() => {});
      expect(renderer._evaluateXpIf({ id: 'w1', xpIf: "ghost = 'x'" })).toBe(false);
      expect(logSpy).toHaveBeenCalled();
      logSpy.mockRestore();
    });
  });

  describe('renderLayout — xpIf controls widget visibility', () => {
    const xlfWithGuard = (xpIf) => `
      <layout width="1920" height="1080" duration="60">
        <region id="r1" width="1920" height="1080" top="0" left="0">
          <media id="m1" type="text" duration="10" xpIf="${xpIf}">
            <options><text>Hello</text></options>
          </media>
        </region>
      </layout>
    `;

    it('shows widget when xpIf evaluates true', async () => {
      const store = new XpStateStore({ initialState: { kioskMode: 'airport' } });
      renderer.setStateStore(store);
      await renderer.renderLayout(xlfWithGuard("kioskMode = 'airport'"), 100);

      const region = renderer.regions.get('r1');
      expect(region).toBeTruthy();
      const el = region.widgetElements.get('m1');
      expect(el).toBeTruthy();
      expect(el.dataset.xpIf).toBe('true');
      expect(el.style.visibility).not.toBe('hidden');
    });

    it('hides widget when xpIf evaluates false', async () => {
      const store = new XpStateStore({ initialState: { kioskMode: 'hotel' } });
      renderer.setStateStore(store);
      const hiddenEvents = [];
      renderer.on('xpIfHidden', (e) => hiddenEvents.push(e));

      await renderer.renderLayout(xlfWithGuard("kioskMode = 'airport'"), 101);

      const region = renderer.regions.get('r1');
      const el = region.widgetElements.get('m1');
      expect(el.dataset.xpIf).toBe('false');
      expect(el.style.visibility).toBe('hidden');
      expect(hiddenEvents).toContainEqual(expect.objectContaining({
        widgetId: 'm1',
        regionId: 'r1',
        expr: "kioskMode = 'airport'"
      }));
    });
  });

  describe('reevaluateXpIf — reacts to state change', () => {
    it('toggles visibility when a referenced key mutates', async () => {
      const store = new XpStateStore({ initialState: { kioskMode: 'hotel' } });
      renderer.setStateStore(store);

      const xml = `
        <layout width="1920" height="1080" duration="60">
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="text" duration="10" xpIf="kioskMode = 'airport'">
              <options><text>Airport</text></options>
            </media>
          </region>
        </layout>
      `;
      await renderer.renderLayout(xml, 102);

      const region = renderer.regions.get('r1');
      const el = region.widgetElements.get('m1');
      expect(el.dataset.xpIf).toBe('false');

      // Flip state → should unhide on the change listener callback.
      store.set('kioskMode', 'airport');
      expect(el.dataset.xpIf).toBe('true');

      // And flip it back.
      store.set('kioskMode', 'retail');
      expect(el.dataset.xpIf).toBe('false');
    });

    it('emits xpIfReevaluated event for observers', async () => {
      const store = new XpStateStore({ initialState: { k: 1 } });
      renderer.setStateStore(store);
      const spy = vi.fn();
      renderer.on('xpIfReevaluated', spy);
      store.set('k', 2);
      expect(spy).toHaveBeenCalled();
    });

    it('no-ops safely when no store is attached', () => {
      // Detach (constructor default) and call directly — should not throw.
      expect(() => renderer.reevaluateXpIf()).not.toThrow();
    });
  });

  describe('cleanup — releases state subscription', () => {
    it('unsubscribes from store on cleanup so the store can outlive the renderer', () => {
      const store = new XpStateStore({ initialState: { k: 1 } });
      renderer.setStateStore(store);

      const reevaluateSpy = vi.spyOn(renderer, 'reevaluateXpIf');
      store.set('k', 2);
      expect(reevaluateSpy).toHaveBeenCalledTimes(1);

      renderer.cleanup();
      reevaluateSpy.mockClear();

      // Mutating the still-living store should not reach the
      // cleaned-up renderer anymore.
      store.set('k', 3);
      expect(reevaluateSpy).not.toHaveBeenCalled();
    });

    it('has zero subscribers on its stateStore after cleanup', () => {
      const store = new XpStateStore({ initialState: { k: 1 } });
      renderer.setStateStore(store);

      // XpStateStore._listeners is a Map<event, Set<handler>> — the
      // only listener at this point is the renderer's change handler.
      const changeSet = store._listeners.get('change');
      expect(changeSet?.size ?? 0).toBe(1);

      renderer.cleanup();
      // After cleanup the subscription must be released so the
      // renderer can be GC'd even if the store is still reachable.
      const post = store._listeners.get('change');
      expect(post?.size ?? 0).toBe(0);
    });
  });

  // ── Plan 242: xp:* widget OPTIONS (not attributes) + xp-state-init ──

  describe('parseWidget — xp:* read from widget OPTIONS', () => {
    it('reads xpIf / xpDatasource / xpMatch / xpBegin / xpEnd from <option name="…">', () => {
      const xml = `
        <layout width="1920" height="1080" duration="60">
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="10" fileId="1">
              <options>
                <uri>test.png</uri>
                <xpIf>kioskMode = 'airport'</xpIf>
                <xpDatasource>feed</xpDatasource>
                <xpJsonpath>$.items[0].status</xpJsonpath>
                <xpMatch>open</xpMatch>
                <xpDayPart>9-17</xpDayPart>
                <xpBegin>2026-04-01T00:00:00Z</xpBegin>
                <xpEnd>2026-04-30T23:59:59Z</xpEnd>
              </options>
            </media>
          </region>
        </layout>
      `;
      const layout = renderer.parseXlf(xml);
      const w = layout.regions[0].widgets[0];
      expect(w.xpIf).toBe("kioskMode = 'airport'");
      expect(w.xpDatasource).toBe('feed');
      expect(w.xpJsonpath).toBe('$.items[0].status');
      expect(w.xpMatch).toBe('open');
      expect(w.xpDayPart).toBe('9-17');
      expect(w.xpBegin).toBe('2026-04-01T00:00:00Z');
      expect(w.xpEnd).toBe('2026-04-30T23:59:59Z');
    });

    it('option value wins over attribute value when both are present', () => {
      // The CMS custom-module emits xp:* as options; legacy
      // translators emit attributes. The widget-options round-trip
      // byte-identically (PR #2) so options are authoritative.
      const xml = `
        <layout width="1920" height="1080" duration="60">
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="image" duration="10"
                   xpIf="from-attribute">
              <options>
                <uri>test.png</uri>
                <xpIf>from-option</xpIf>
              </options>
            </media>
          </region>
        </layout>
      `;
      const layout = renderer.parseXlf(xml);
      const w = layout.regions[0].widgets[0];
      expect(w.xpIf).toBe('from-option');
    });

    it('widget without any xp:* option renders identically to pre-change (regression)', async () => {
      const xml = `
        <layout width="1920" height="1080" duration="60">
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="text" duration="10">
              <options><text>Hello</text></options>
            </media>
          </region>
        </layout>
      `;
      const layout = renderer.parseXlf(xml);
      const w = layout.regions[0].widgets[0];
      expect(w.xpIf).toBeNull();
      expect(w.xpDayPart).toBeNull();
      expect(w.xpDatasource).toBeNull();
      expect(w.xpJsonpath).toBeNull();
      expect(w.xpMatch).toBeNull();
      expect(w.xpBegin).toBeNull();
      expect(w.xpEnd).toBeNull();

      await renderer.renderLayout(xml, 200);
      const region = renderer.regions.get('r1');
      const el = region.widgetElements.get('m1');
      expect(el).toBeTruthy();
      // No xpIf data-attribute set when there's no xpIf at all.
      expect(el.dataset.xpIf).toBeUndefined();
      expect(el.style.visibility).not.toBe('hidden');
    });
  });

  describe('xp-state-init widget — metadata-only', () => {
    it('collects xp-state-init on the layout and skips the render queue', () => {
      const state = { kioskMode: 'airport', gate: { number: 7 } };
      const xml = `
        <layout width="1920" height="1080" duration="60">
          <region id="r0" width="1" height="1" top="0" left="0">
            <media id="init1" type="xp-state-init" duration="0">
              <options>
                <xpStateInit>${JSON.stringify(state)}</xpStateInit>
                <xpStateScope>session</xpStateScope>
                <xpLanguage>en</xpLanguage>
              </options>
            </media>
          </region>
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="text" duration="10">
              <options><text>Hello</text></options>
            </media>
          </region>
        </layout>
      `;
      const layout = renderer.parseXlf(xml);
      // State-init metadata captured on the layout.
      expect(layout.xpStateInit).toBeTruthy();
      expect(layout.xpStateInit.widgetId).toBe('init1');
      expect(layout.xpStateInit.scope).toBe('session');
      expect(layout.xpStateInit.language).toBe('en');
      // Region 0 should have zero renderable widgets (init skipped).
      const r0 = layout.regions.find((r) => r.id === 'r0');
      expect(r0.widgets.length).toBe(0);
      // Region 1 keeps its widget.
      const r1 = layout.regions.find((r) => r.id === 'r1');
      expect(r1.widgets.length).toBe(1);
    });

    it('seeds an XpStateStore with the declared state on renderLayout (plain JSON)', async () => {
      const state = { kioskMode: 'airport', cta: true };
      const xml = `
        <layout width="1920" height="1080" duration="60">
          <region id="r0" width="1" height="1" top="0" left="0">
            <media id="init1" type="xp-state-init" duration="0">
              <options>
                <xpStateInit>${JSON.stringify(state)}</xpStateInit>
                <xpStateScope>session</xpStateScope>
              </options>
            </media>
          </region>
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="text" duration="10">
              <options>
                <text>Airport</text>
                <xpIf>kioskMode = 'airport'</xpIf>
              </options>
            </media>
          </region>
        </layout>
      `;
      await renderer.renderLayout(xml, 300);

      const store = renderer.getStateStore();
      expect(store).toBeTruthy();
      expect(store.get('kioskMode')).toBe('airport');
      expect(store.get('cta')).toBe(true);
      expect(store.scope).toBe('session');

      // And the xpIf guard read from OPTIONS shows the widget.
      const region = renderer.regions.get('r1');
      const el = region.widgetElements.get('m1');
      expect(el.dataset.xpIf).toBe('true');
      expect(el.style.visibility).not.toBe('hidden');
    });

    it('decodes a gzip+b64-compressed xpStateInit payload', async () => {
      const state = { kioskMode: 'lobby', gate: { open: false } };
      const b64 = Buffer.from(
        gzipSync(Buffer.from(JSON.stringify(state), 'utf-8'))
      ).toString('base64');
      const xml = `
        <layout width="1920" height="1080" duration="60">
          <region id="r0" width="1" height="1" top="0" left="0">
            <media id="init1" type="xp-state-init" duration="0">
              <options>
                <xpStateInit>gzip+b64:${b64}</xpStateInit>
                <xpStateScope>document</xpStateScope>
              </options>
            </media>
          </region>
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="text" duration="10">
              <options><text>Lobby</text></options>
            </media>
          </region>
        </layout>
      `;
      await renderer.renderLayout(xml, 301);

      const store = renderer.getStateStore();
      expect(store).toBeTruthy();
      expect(store.get('kioskMode')).toBe('lobby');
      expect(store.get('gate.open')).toBe(false);
      expect(store.scope).toBe('document');
    });

    it('hides / shows widget on state mutation when xpIf is in OPTIONS', async () => {
      const xml = `
        <layout width="1920" height="1080" duration="60">
          <region id="r0" width="1" height="1" top="0" left="0">
            <media id="init1" type="xp-state-init" duration="0">
              <options>
                <xpStateInit>${JSON.stringify({ kioskMode: 'hotel' })}</xpStateInit>
              </options>
            </media>
          </region>
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="text" duration="10">
              <options>
                <text>Airport only</text>
                <xpIf>kioskMode = 'airport'</xpIf>
              </options>
            </media>
          </region>
        </layout>
      `;
      await renderer.renderLayout(xml, 302);

      const region = renderer.regions.get('r1');
      const el = region.widgetElements.get('m1');
      expect(el.dataset.xpIf).toBe('false');

      // Mutate the auto-created store — the widget should unhide.
      const store = renderer.getStateStore();
      store.set('kioskMode', 'airport');
      expect(el.dataset.xpIf).toBe('true');
    });

    it('seeds lang from xpLanguage when not already in initial state', async () => {
      const xml = `
        <layout width="1920" height="1080" duration="60">
          <region id="r0" width="1" height="1" top="0" left="0">
            <media id="init1" type="xp-state-init" duration="0">
              <options>
                <xpStateInit>${JSON.stringify({ kioskMode: 'hotel' })}</xpStateInit>
                <xpLanguage>pt</xpLanguage>
              </options>
            </media>
          </region>
        </layout>
      `;
      await renderer.renderLayout(xml, 303);
      const store = renderer.getStateStore();
      expect(store.get('lang')).toBe('pt');
      expect(store.get('kioskMode')).toBe('hotel');
    });

    it('logs and keeps the previous store when xpStateInit payload is corrupt', async () => {
      // Inject a clean store first, then render a layout with a
      // malformed xp-state-init — renderer should log the error
      // and NOT clobber the pre-existing store.
      const preexisting = new XpStateStore({ initialState: { sentinel: 1 } });
      renderer.setStateStore(preexisting);

      const errSpy = vi.spyOn(renderer.log, 'error').mockImplementation(() => {});
      const xml = `
        <layout width="1920" height="1080" duration="60">
          <region id="r0" width="1" height="1" top="0" left="0">
            <media id="init1" type="xp-state-init" duration="0">
              <options>
                <xpStateInit>not-a-known-carrier</xpStateInit>
              </options>
            </media>
          </region>
          <region id="r1" width="1920" height="1080" top="0" left="0">
            <media id="m1" type="text" duration="10">
              <options><text>Hello</text></options>
            </media>
          </region>
        </layout>
      `;
      await renderer.renderLayout(xml, 304);

      expect(errSpy).toHaveBeenCalled();
      // Store did NOT change — preexisting still wired.
      expect(renderer.getStateStore()).toBe(preexisting);
      expect(preexisting.get('sentinel')).toBe(1);
      errSpy.mockRestore();
    });
  });
});
