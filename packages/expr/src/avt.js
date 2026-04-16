// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Attribute Value Template (AVT) helpers — SMIL State.
 *
 * AVT syntax: `{identifier}` anywhere inside a string is replaced with
 * the stringified value of that identifier from the state lookup. Used
 * by attributes like `src="slide-{page}.png"` and text content.
 *
 * Track A folds AVTs at build time for identifiers present in
 * `xp:state-init`; any unresolved identifier defers the substitution to
 * Track B (this module), which re-evaluates on state change.
 */

const AVT_PATTERN = /\{([A-Za-z_][\w.-]*)\}/g;

/**
 * Substitute `{ident}` placeholders in a string against the state.
 *
 * @param {string} s - template string
 * @param {Record<string, unknown> | { get: (name: string) => unknown, has?: (name: string) => boolean }} state
 * @returns {string | null} substituted string, or null if any identifier
 *   could not be resolved (caller treats this as "can't fold").
 */
export function avtSubstitute(s, state) {
  if (typeof s !== 'string' || !s.includes('{')) return s;
  let unresolved = false;
  const out = s.replace(AVT_PATTERN, (_, name) => {
    const { found, value } = lookup(state, name);
    if (found) return String(value);
    unresolved = true;
    return `{${name}}`;
  });
  return unresolved ? null : out;
}

/**
 * Like `avtSubstitute` but never returns null — unresolved identifiers
 * are replaced with the empty string. Useful at runtime where the
 * renderer wants *some* string to display rather than a placeholder.
 *
 * @param {string} s
 * @param {Record<string, unknown> | { get: (name: string) => unknown, has?: (name: string) => boolean }} state
 * @returns {string}
 */
export function avtSubstituteLossy(s, state) {
  if (typeof s !== 'string' || !s.includes('{')) return String(s ?? '');
  return s.replace(AVT_PATTERN, (_, name) => {
    const { found, value } = lookup(state, name);
    return found ? String(value) : '';
  });
}

/**
 * Extract the identifier names referenced by an AVT template. Useful
 * for subscribing to just the keys that affect a given attribute.
 *
 * @param {string} s
 * @returns {string[]} unique identifier names in appearance order
 */
export function avtIdentifiers(s) {
  if (typeof s !== 'string' || !s.includes('{')) return [];
  const seen = new Set();
  const out = [];
  for (const m of s.matchAll(AVT_PATTERN)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

function lookup(state, name) {
  if (state && typeof state.get === 'function') {
    const has = typeof state.has === 'function' ? state.has(name) : state.get(name) !== undefined;
    return has ? { found: true, value: state.get(name) } : { found: false, value: undefined };
  }
  if (state && Object.hasOwn(state, name)) {
    return { found: true, value: state[name] };
  }
  return { found: false, value: undefined };
}
