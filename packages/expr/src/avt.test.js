// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Pau Aliagas <linuxnow@gmail.com>

import { describe, it, expect } from 'vitest';
import { avtSubstitute, avtSubstituteLossy, avtIdentifiers } from './avt.js';
import { XpStateStore } from './state.js';

describe('avtSubstitute — strict (returns null on unresolved)', () => {
  it('returns the original string when no {…} placeholders', () => {
    expect(avtSubstitute('hello', { x: 1 })).toBe('hello');
  });

  it('substitutes a single identifier', () => {
    expect(avtSubstitute('slide-{page}.png', { page: 3 })).toBe('slide-3.png');
  });

  it('substitutes multiple identifiers', () => {
    expect(avtSubstitute('{a}-{b}-{a}', { a: 'x', b: 'y' })).toBe('x-y-x');
  });

  it('returns null when any identifier is missing', () => {
    expect(avtSubstitute('{a}-{b}', { a: 'x' })).toBe(null);
  });

  it('works with a store-like state', () => {
    const store = new XpStateStore({ scope: 'document', initialState: { page: 3 } });
    expect(avtSubstitute('slide-{page}.png', store)).toBe('slide-3.png');
  });

  it('handles dotted identifier bodies', () => {
    expect(avtSubstitute('{foo.bar}', { 'foo.bar': 'ok' })).toBe('ok');
  });
});

describe('avtSubstituteLossy — never returns null', () => {
  it('replaces unresolved identifiers with empty string', () => {
    expect(avtSubstituteLossy('{a}-{b}', { a: 'x' })).toBe('x-');
  });

  it('coerces null/undefined source to empty string', () => {
    expect(avtSubstituteLossy(null, {})).toBe('');
    expect(avtSubstituteLossy(undefined, {})).toBe('');
  });
});

describe('avtIdentifiers — enumerate referenced keys', () => {
  it('returns empty array when no placeholders', () => {
    expect(avtIdentifiers('hello')).toEqual([]);
    expect(avtIdentifiers('')).toEqual([]);
  });

  it('returns unique names in appearance order', () => {
    expect(avtIdentifiers('{a}-{b}-{a}-{c}')).toEqual(['a', 'b', 'c']);
  });

  it('handles non-string input gracefully', () => {
    expect(avtIdentifiers(null)).toEqual([]);
    expect(avtIdentifiers(undefined)).toEqual([]);
  });
});
