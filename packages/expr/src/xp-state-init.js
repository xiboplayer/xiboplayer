// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * xp-state-init — parse `xp:state-init` widget option payloads.
 *
 * The CMS custom-module posts three forms of the state-init option for
 * the `xp-state-init` widget. This helper decodes any of them into a
 * plain JS object suitable for `new XpStateStore({ initialState: ... })`.
 *
 *   1. `zstd+b64:<b64>` — base64 → zstd decompress → JSON parse
 *   2. `gzip+b64:<b64>` — base64 → gunzip → JSON parse
 *   3. Plain JSON string (starts with `{`) — JSON parse directly
 *
 * gzip uses the Web standard `DecompressionStream('gzip')`, which is
 * available natively in Node ≥ 18 and all modern browsers — no bundled
 * dep required.
 *
 * zstd uses `fzstd` — a pure-JS decompressor (≈ 65 kB unpacked, tree-
 * shakes the decompress-only path; no wasm, no native module). We
 * evaluated `@bokuweb/zstd-wasm` but its wasm blob is ~200 kB gzipped
 * and forces host apps to serve a separate asset with the right MIME.
 * `fzstd` is small enough to inline, zero-config in jsdom tests, and
 * works identically in node + browser.
 *
 * On any failure this module throws an `Error` with a message citing
 * the path that failed (prefix detection / base64 decode / decompress /
 * JSON parse) — callers are expected to log + fall back to empty state.
 */

import { decompress as zstdDecompress } from 'fzstd';

/**
 * Parse an `xp:state-init` widget-option value.
 *
 * @param {string} value - raw option text from the XLF
 * @returns {object} parsed state object (suitable for XpStateStore
 *   `initialState`). Empty object when `value` decodes to `null` or
 *   a non-object primitive — the store only accepts object seeds.
 * @throws {Error} with a descriptive message on any failure
 */
export function parseXpStateInit(value) {
  if (value == null || value === '') {
    throw new Error('parseXpStateInit: empty value');
  }
  if (typeof value !== 'string') {
    throw new Error(`parseXpStateInit: expected string, got ${typeof value}`);
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    throw new Error('parseXpStateInit: empty value');
  }

  // Dispatch on prefix. The colon is required; anything else falls
  // through to the JSON branch below.
  const colon = trimmed.indexOf(':');
  if (colon > 0) {
    const prefix = trimmed.slice(0, colon);
    const payload = trimmed.slice(colon + 1);

    if (prefix === 'zstd+b64') {
      return _parseZstdB64(payload);
    }
    if (prefix === 'gzip+b64') {
      return _parseGzipB64(payload);
    }
    // Unknown prefix that still looks like "word+b64:..." — reject
    // loudly rather than silently treating the whole thing as JSON.
    // Heuristic: prefix contains "+b64" or is all-lowercase-word.
    if (/^[a-z][a-z0-9+]*$/i.test(prefix) && prefix.includes('+b64')) {
      throw new Error(
        `parseXpStateInit: unsupported prefix "${prefix}" — expected zstd+b64 or gzip+b64`
      );
    }
  }

  // Plain JSON path. Must start with { or [ to be remotely valid;
  // anything else almost certainly means a mis-typed prefix.
  if (!/^[\[{]/.test(trimmed)) {
    throw new Error(
      'parseXpStateInit: value is neither a known compression prefix ' +
        '(zstd+b64:/gzip+b64:) nor a JSON object/array literal'
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`parseXpStateInit: invalid JSON payload — ${err.message}`);
  }
  return _normalise(parsed);
}

function _parseZstdB64(b64) {
  const bytes = _b64ToBytes(b64, 'zstd+b64');
  let raw;
  try {
    raw = zstdDecompress(bytes);
  } catch (err) {
    throw new Error(`parseXpStateInit: zstd decompression failed — ${err.message}`);
  }
  return _parseJsonFromBytes(raw, 'zstd+b64');
}

function _parseGzipB64(b64) {
  const bytes = _b64ToBytes(b64, 'gzip+b64');
  let raw;
  try {
    raw = _gunzipSync(bytes);
  } catch (err) {
    throw new Error(`parseXpStateInit: gzip decompression failed — ${err.message}`);
  }
  return _parseJsonFromBytes(raw, 'gzip+b64');
}

/**
 * Synchronous gunzip.
 *
 * Node ≥ 18 exposes `zlib.gunzipSync`; the browser does not have a
 * synchronous gzip API (DecompressionStream is async-only). Rather
 * than forcing the public `parseXpStateInit` API to be async, we
 * detect the environment and provide gzip synchronously in Node only:
 *
 *   - Node: imported from `node:zlib` via a top-level conditional
 *     import. Bundlers (webpack, rollup, esbuild) treat `node:*` as
 *     Node built-ins and either externalise or strip this import in
 *     browser builds.
 *   - Browser: throws with a message directing the caller to use
 *     `zstd+b64:` or plain JSON. Production payloads from the CMS
 *     custom-module default to `zstd+b64:`; `gzip+b64:` is a
 *     debug / fallback path that browser-resident renderers don't
 *     need today.
 */
let NODE_GUNZIP = null;
try {
  const proc = typeof globalThis !== 'undefined' ? globalThis.process : null;
  if (proc && proc.versions && proc.versions.node) {
    // Top-level await at module load. Safe in Node ≥ 14.8 and every
    // bundler that targets ESM (which is all of them in 2026).
    // eslint-disable-next-line no-restricted-syntax
    const zlib = await import('node:zlib');
    NODE_GUNZIP = zlib.gunzipSync;
  }
} catch (_err) {
  // Import failed — non-Node environment, leave NODE_GUNZIP null.
}

function _gunzipSync(bytes) {
  if (NODE_GUNZIP) {
    return new Uint8Array(NODE_GUNZIP(Buffer.from(bytes)));
  }
  throw new Error(
    'gzip decompression not supported in this runtime — browser builds ' +
      'currently only support zstd+b64 and plain JSON xp:state-init payloads'
  );
}

function _b64ToBytes(b64, label) {
  const clean = String(b64).trim();
  if (clean === '') {
    throw new Error(`parseXpStateInit: empty base64 payload after ${label}:`);
  }
  try {
    if (typeof atob === 'function') {
      const bin = atob(clean);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    if (typeof Buffer !== 'undefined') {
      return new Uint8Array(Buffer.from(clean, 'base64'));
    }
    throw new Error('no base64 decoder available (neither atob nor Buffer)');
  } catch (err) {
    throw new Error(
      `parseXpStateInit: base64 decode failed for ${label} — ${err.message}`
    );
  }
}

function _parseJsonFromBytes(bytes, label) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (err) {
    throw new Error(
      `parseXpStateInit: ${label} payload is not valid UTF-8 — ${err.message}`
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `parseXpStateInit: ${label} payload is not valid JSON — ${err.message}`
    );
  }
  return _normalise(parsed);
}

function _normalise(parsed) {
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      'parseXpStateInit: decoded payload must be a JSON object (got ' +
        (Array.isArray(parsed) ? 'array' : typeof parsed) +
        ')'
    );
  }
  return parsed;
}
