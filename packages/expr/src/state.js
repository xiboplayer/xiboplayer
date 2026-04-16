// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * XpStateStore — runtime state store for SMIL State (Track B).
 *
 * Backs `<setvalue>`, `<newvalue>`, `<delvalue>`, and `xp:if=` /
 * `expr=` / `{AVT}` runtime evaluation in the PWA renderer. The store
 * mirrors the shape of `xp:state-init` but is mutable.
 *
 * Scope semantics (matches `xp:state-scope`, default `session`):
 *   - "document": in-memory only; reset on layout change.
 *   - "session":  in-memory only; persists across layout changes until
 *                 the player restarts.
 *   - "display":  backed by `localStorage`; persists across restarts.
 *
 * The store is intentionally flat — keys are identifiers (dotted names
 * allowed as a nested convenience via `get('foo.bar')` / `set('foo.bar',
 * …)`). Authors that want structured state can model it however they
 * like; the runtime evaluator only cares that `state.get(ident)` works.
 *
 * Event model:
 *   - `change`             — fired after every set/delete, payload `{path, value, prev}`
 *   - `change:<path>`      — fired for a specific path (including parent paths on nested writes)
 *
 * Identifier-to-dependency mapping for `xp:if` re-evaluation is the
 * caller's responsibility (use `exprIdentifiers()` or `avtIdentifiers()`
 * from the companion modules to enumerate keys).
 */

import { evalExpr } from './expr.js';

const VALID_SCOPES = new Set(['document', 'session', 'display']);

/**
 * @typedef {string | number | boolean | null} Scalar
 * @typedef {Scalar | Scalar[] | { [k: string]: Json }} Json
 */

export class XpStateStore {
  /**
   * @param {object} [opts]
   * @param {'document' | 'session' | 'display'} [opts.scope='session']
   * @param {Record<string, Json>} [opts.initialState] - `xp:state-init` object
   * @param {Storage} [opts.storage] - `localStorage`-compatible backend for
   *   `display` scope. Defaults to `globalThis.localStorage` when present.
   * @param {string} [opts.storageKey='xp:state'] - localStorage key
   */
  constructor(opts = {}) {
    const scope = opts.scope ?? 'session';
    if (!VALID_SCOPES.has(scope)) {
      throw new Error(`XpStateStore: invalid scope "${scope}"`);
    }
    this.scope = scope;
    this._storageKey = opts.storageKey ?? 'xp:state';
    this._storage = scope === 'display'
      ? (opts.storage ?? (typeof globalThis !== 'undefined' ? globalThis.localStorage : null))
      : null;

    this._data = new Map();
    this._listeners = new Map();  // event → Set<handler>

    // Seed order: initialState first, then persisted display state overrides.
    if (opts.initialState && typeof opts.initialState === 'object') {
      for (const [k, v] of Object.entries(opts.initialState)) {
        this._data.set(k, clone(v));
      }
    }
    if (this._storage) {
      try {
        const raw = this._storage.getItem(this._storageKey);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            for (const [k, v] of Object.entries(parsed)) {
              this._data.set(k, clone(v));
            }
          }
        }
      } catch (_err) {
        // Corrupt storage — fall back to initialState-only.
      }
    }
  }

  /**
   * Dot-path read. `get('foo.bar')` returns the nested value, or
   * `undefined` if any segment is missing. Flat `get('foo')` returns
   * the top-level value verbatim.
   *
   * @param {string} path
   * @returns {Json | undefined}
   */
  get(path) {
    const { key, rest } = splitPath(path);
    if (!this._data.has(key)) return undefined;
    let v = this._data.get(key);
    for (const seg of rest) {
      if (v == null || typeof v !== 'object') return undefined;
      v = v[seg];
    }
    return v;
  }

  /**
   * @param {string} path
   * @returns {boolean}
   */
  has(path) {
    return this.get(path) !== undefined;
  }

  /**
   * Dot-path write. Triggers `change` + `change:<path>` events (and
   * also `change:<ancestor>` for every parent path on nested writes).
   *
   * @param {string} path
   * @param {Json} value
   */
  set(path, value) {
    const prev = this.get(path);
    const { key, rest } = splitPath(path);
    if (rest.length === 0) {
      this._data.set(key, clone(value));
    } else {
      let obj = this._data.get(key);
      if (obj == null || typeof obj !== 'object') {
        obj = {};
        this._data.set(key, obj);
      }
      let cursor = obj;
      for (let i = 0; i < rest.length - 1; i++) {
        const seg = rest[i];
        if (cursor[seg] == null || typeof cursor[seg] !== 'object') {
          cursor[seg] = {};
        }
        cursor = cursor[seg];
      }
      cursor[rest[rest.length - 1]] = clone(value);
    }
    this._persist();
    this._emitChange(path, value, prev);
  }

  /**
   * Dot-path delete. Removes the leaf (for flat keys it removes the
   * whole top-level entry).
   *
   * @param {string} path
   */
  delete(path) {
    const prev = this.get(path);
    if (prev === undefined) return;  // nothing to delete, no event

    const { key, rest } = splitPath(path);
    if (rest.length === 0) {
      this._data.delete(key);
    } else {
      let cursor = this._data.get(key);
      for (let i = 0; i < rest.length - 1; i++) {
        if (cursor == null || typeof cursor !== 'object') return;
        cursor = cursor[rest[i]];
      }
      if (cursor != null && typeof cursor === 'object') {
        delete cursor[rest[rest.length - 1]];
      }
    }
    this._persist();
    this._emitChange(path, undefined, prev);
  }

  /**
   * Evaluate an XPath 1.0 subset expression against the store.
   *
   * @param {string} expr
   * @param {Array<{code:string,message:string}>} [warningsOut]
   * @returns {boolean | number | string}
   */
  evaluate(expr, warningsOut) {
    return evalExpr(expr, this, warningsOut);
  }

  /**
   * Snapshot a plain-object copy of the store's top-level keys. Useful
   * for logging or passing to the Track A evaluator without exposing
   * the Map.
   */
  snapshot() {
    const out = {};
    for (const [k, v] of this._data) out[k] = clone(v);
    return out;
  }

  /**
   * Subscribe to change events. Returns an unsubscribe function.
   *
   * Events:
   *   - `change`          — every mutation
   *   - `change:<path>`   — mutations to a specific path (and ancestors)
   *
   * @param {string} event
   * @param {(payload: {path: string, value: Json|undefined, prev: Json|undefined}) => void} handler
   * @returns {() => void}
   */
  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(handler);
    return () => {
      const set = this._listeners.get(event);
      if (set) set.delete(handler);
    };
  }

  /**
   * Clear all keys and fire one `change` event with `path='*'`. Used
   * when a `document`-scoped store resets on layout change.
   */
  reset() {
    const prev = this.snapshot();
    this._data.clear();
    this._persist();
    this._emit('change', { path: '*', value: undefined, prev });
  }

  /**
   * lang getter — convenience for `smil-language()` built-in. The
   * evaluator resolves `lang` via the normal `get()` path, but
   * consumers (overlay, debug UI) can read it directly too.
   */
  get lang() {
    return this.get('lang');
  }

  // ── Internals ────────────────────────────────────────────────────

  _persist() {
    if (!this._storage) return;
    try {
      const obj = this.snapshot();
      this._storage.setItem(this._storageKey, JSON.stringify(obj));
    } catch (_err) {
      // Quota exceeded or serialisation error — persistence is
      // best-effort; in-memory state is still authoritative.
    }
  }

  _emitChange(path, value, prev) {
    this._emit('change', { path, value, prev });
    // Fire change:<path> and change:<ancestor> for each dotted parent.
    const segs = path.split('.');
    for (let i = segs.length; i >= 1; i--) {
      const p = segs.slice(0, i).join('.');
      this._emit(`change:${p}`, { path, value, prev });
    }
  }

  _emit(event, payload) {
    const set = this._listeners.get(event);
    if (!set || set.size === 0) return;
    // Copy so handlers can unsubscribe mid-emission without skipping.
    for (const h of Array.from(set)) {
      try {
        h(payload);
      } catch (err) {
        // Stay quiet by default — renderers shouldn't die if a stray
        // listener throws. A future logger hook could surface this.
        if (typeof console !== 'undefined' && console.error) {
          console.error('[XpStateStore] listener error on', event, err);
        }
      }
    }
  }
}

function clone(v) {
  if (v == null) return v;
  if (typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(clone);
  const out = {};
  for (const [k, vv] of Object.entries(v)) out[k] = clone(vv);
  return out;
}

function splitPath(path) {
  const s = String(path);
  const i = s.indexOf('.');
  if (i < 0) return { key: s, rest: [] };
  return { key: s.slice(0, i), rest: s.slice(i + 1).split('.') };
}
