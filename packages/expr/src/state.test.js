// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Tests for XpStateStore — runtime SMIL State container.
 */

import { describe, it, expect, vi } from 'vitest';
import { XpStateStore } from './state.js';

function mkStorage(seed = {}) {
  let data = { ...seed };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = v; },
    removeItem: (k) => { delete data[k]; },
    clear: () => { data = {}; },
    _peek: () => data
  };
}

describe('XpStateStore — construction', () => {
  it('defaults to session scope', () => {
    const s = new XpStateStore();
    expect(s.scope).toBe('session');
  });

  it('rejects unknown scopes', () => {
    expect(() => new XpStateStore({ scope: 'bogus' })).toThrow(/invalid scope/);
  });

  it('seeds from initialState', () => {
    const s = new XpStateStore({ initialState: { foo: 1, bar: 'x' } });
    expect(s.get('foo')).toBe(1);
    expect(s.get('bar')).toBe('x');
  });

  it('does not share references with initialState (deep clone)', () => {
    const seed = { obj: { a: 1 } };
    const s = new XpStateStore({ initialState: seed });
    seed.obj.a = 99;
    expect(s.get('obj.a')).toBe(1);
  });
});

describe('XpStateStore — get/set/has/delete', () => {
  it('get returns undefined for missing keys', () => {
    const s = new XpStateStore();
    expect(s.get('ghost')).toBeUndefined();
    expect(s.has('ghost')).toBe(false);
  });

  it('set + get round-trip for flat keys', () => {
    const s = new XpStateStore();
    s.set('foo', 42);
    expect(s.get('foo')).toBe(42);
    expect(s.has('foo')).toBe(true);
  });

  it('set + get round-trip for dotted paths', () => {
    const s = new XpStateStore();
    s.set('foo.bar.baz', 'deep');
    expect(s.get('foo.bar.baz')).toBe('deep');
    expect(s.get('foo.bar')).toEqual({ baz: 'deep' });
    expect(s.get('foo')).toEqual({ bar: { baz: 'deep' } });
  });

  it('delete removes flat keys', () => {
    const s = new XpStateStore({ initialState: { foo: 1 } });
    s.delete('foo');
    expect(s.has('foo')).toBe(false);
  });

  it('delete removes nested paths but keeps siblings', () => {
    const s = new XpStateStore();
    s.set('a.x', 1);
    s.set('a.y', 2);
    s.delete('a.x');
    expect(s.get('a.x')).toBeUndefined();
    expect(s.get('a.y')).toBe(2);
  });

  it('delete on a missing path is a no-op (no event)', () => {
    const s = new XpStateStore();
    const spy = vi.fn();
    s.on('change', spy);
    s.delete('ghost');
    expect(spy).not.toHaveBeenCalled();
  });

  it('snapshot returns a deep-cloned plain object', () => {
    const s = new XpStateStore({ initialState: { foo: { n: 1 } } });
    const snap = s.snapshot();
    snap.foo.n = 99;
    expect(s.get('foo.n')).toBe(1);
  });
});

describe('XpStateStore — change events', () => {
  it("fires 'change' on every mutation", () => {
    const s = new XpStateStore();
    const events = [];
    s.on('change', (e) => events.push(e));
    s.set('foo', 1);
    s.set('foo', 2);
    s.delete('foo');
    expect(events).toEqual([
      { path: 'foo', value: 1, prev: undefined },
      { path: 'foo', value: 2, prev: 1 },
      { path: 'foo', value: undefined, prev: 2 }
    ]);
  });

  it("fires 'change:<path>' for a specific path", () => {
    const s = new XpStateStore();
    const spy = vi.fn();
    s.on('change:foo', spy);
    s.set('foo', 'hello');
    expect(spy).toHaveBeenCalledWith({ path: 'foo', value: 'hello', prev: undefined });
    s.set('bar', 'ignore');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("fires 'change:<ancestor>' for nested writes", () => {
    const s = new XpStateStore();
    const spyLeaf = vi.fn();
    const spyMid = vi.fn();
    const spyRoot = vi.fn();
    s.on('change:a.b.c', spyLeaf);
    s.on('change:a.b', spyMid);
    s.on('change:a', spyRoot);
    s.set('a.b.c', 'deep');
    expect(spyLeaf).toHaveBeenCalled();
    expect(spyMid).toHaveBeenCalled();
    expect(spyRoot).toHaveBeenCalled();
  });

  it('unsubscribe removes the listener', () => {
    const s = new XpStateStore();
    const spy = vi.fn();
    const off = s.on('change', spy);
    s.set('foo', 1);
    off();
    s.set('foo', 2);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('isolates listener errors (one throwing handler does not skip others)', () => {
    const s = new XpStateStore();
    const err = new Error('boom');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const good = vi.fn();
    s.on('change', () => { throw err; });
    s.on('change', good);
    s.set('foo', 1);
    expect(good).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('XpStateStore — display scope persistence', () => {
  it('writes through to storage on set', () => {
    const storage = mkStorage();
    const s = new XpStateStore({ scope: 'display', storage });
    s.set('foo', 42);
    expect(storage.getItem('xp:state')).toBe('{"foo":42}');
  });

  it('rehydrates from storage on construction', () => {
    const storage = mkStorage({ 'xp:state': '{"counter":7}' });
    const s = new XpStateStore({ scope: 'display', storage });
    expect(s.get('counter')).toBe(7);
  });

  it('initialState is overridden by persisted values on display scope', () => {
    // Spec behaviour: persisted wins, so a player that restarts keeps
    // user-mutated state rather than being reset to initialState.
    const storage = mkStorage({ 'xp:state': '{"counter":7}' });
    const s = new XpStateStore({
      scope: 'display',
      storage,
      initialState: { counter: 0, lang: 'en' }
    });
    expect(s.get('counter')).toBe(7);
    expect(s.get('lang')).toBe('en');  // not persisted — initialState wins
  });

  it('survives corrupt storage gracefully', () => {
    const storage = mkStorage({ 'xp:state': '{not json' });
    const s = new XpStateStore({
      scope: 'display',
      storage,
      initialState: { foo: 1 }
    });
    expect(s.get('foo')).toBe(1);
  });

  it('custom storageKey is honoured', () => {
    const storage = mkStorage();
    const s = new XpStateStore({
      scope: 'display',
      storage,
      storageKey: 'my:prefix:state'
    });
    s.set('x', 1);
    expect(storage.getItem('my:prefix:state')).toBe('{"x":1}');
  });

  it('document + session scopes never touch storage', () => {
    const storage = mkStorage();
    const doc = new XpStateStore({ scope: 'document', storage });
    doc.set('foo', 1);
    const sess = new XpStateStore({ scope: 'session', storage });
    sess.set('bar', 2);
    expect(storage._peek()).toEqual({});
  });

  it('reset() clears the store and persists empty state', () => {
    const storage = mkStorage();
    const s = new XpStateStore({ scope: 'display', storage, initialState: { foo: 1 } });
    s.set('bar', 2);
    const spy = vi.fn();
    s.on('change', spy);
    s.reset();
    expect(s.get('foo')).toBeUndefined();
    expect(s.get('bar')).toBeUndefined();
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ path: '*' }));
    expect(storage.getItem('xp:state')).toBe('{}');
  });
});

describe('XpStateStore — evaluate() and expression integration', () => {
  it('evaluates expressions against current state', () => {
    const s = new XpStateStore({ initialState: { kioskMode: 'airport', lang: 'en' } });
    expect(s.evaluate("kioskMode = 'airport'")).toBe(true);
    expect(s.evaluate("kioskMode = 'hotel'")).toBe(false);
    expect(s.evaluate("smil-language('en')")).toBe(true);
  });

  it('re-evaluates after set()', () => {
    const s = new XpStateStore({ initialState: { kioskMode: 'airport' } });
    expect(s.evaluate("kioskMode = 'hotel'")).toBe(false);
    s.set('kioskMode', 'hotel');
    expect(s.evaluate("kioskMode = 'hotel'")).toBe(true);
  });

  it('collects JS-style == lint warnings through evaluate()', () => {
    const s = new XpStateStore({ initialState: { kioskMode: 'airport' } });
    const warnings = [];
    s.evaluate("kioskMode == 'airport'", warnings);
    expect(warnings.some((w) => w.code === 'XP_EXPR_JS_ALIAS')).toBe(true);
  });

  it('lang getter exposes state.lang', () => {
    const s = new XpStateStore({ initialState: { lang: 'ca' } });
    expect(s.lang).toBe('ca');
    s.set('lang', 'en');
    expect(s.lang).toBe('en');
  });
});
