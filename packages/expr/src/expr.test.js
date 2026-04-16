// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Tests for the XPath 1.0 subset evaluator.
 *
 * These mirror the compile-time folder tests in
 * xiboplayer-smil-tools/src/xlf-builder.test.js so the two tracks stay
 * in lock-step. Any divergence in semantics here would break the
 * round-trip invariant: an expression that Track A folds to `true` at
 * build time must evaluate to `true` here at runtime (and vice versa).
 */

import { describe, it, expect } from 'vitest';
import { evalExpr, asBool, ExprOutOfScope } from './expr.js';

describe('evalExpr — literals and identifiers', () => {
  it('evaluates number literals', () => {
    expect(evalExpr('42', {})).toBe(42);
    expect(evalExpr('3.14', {})).toBe(3.14);
  });

  it('evaluates string literals (single + double quoted)', () => {
    expect(evalExpr("'hello'", {})).toBe('hello');
    expect(evalExpr('"world"', {})).toBe('world');
  });

  it('resolves identifiers against a plain state object', () => {
    expect(evalExpr('foo', { foo: 42 })).toBe(42);
    expect(evalExpr('kioskMode', { kioskMode: 'airport' })).toBe('airport');
  });

  it('throws ExprOutOfScope on unknown identifier', () => {
    expect(() => evalExpr('ghost', { foo: 1 })).toThrow(ExprOutOfScope);
  });

  it('throws ExprOutOfScope on empty expression', () => {
    expect(() => evalExpr('', {})).toThrow(/empty/);
    expect(() => evalExpr('   ', {})).toThrow(/empty/);
  });
});

describe('evalExpr — equality and comparisons', () => {
  it('handles XPath = equality (no warning)', () => {
    const warnings = [];
    expect(evalExpr("kioskMode = 'airport'", { kioskMode: 'airport' }, warnings)).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('accepts JS-style == with XP_EXPR_JS_ALIAS lint warning', () => {
    const warnings = [];
    expect(evalExpr("kioskMode == 'airport'", { kioskMode: 'airport' }, warnings)).toBe(true);
    expect(warnings.some((w) => w.code === 'XP_EXPR_JS_ALIAS')).toBe(true);
  });

  it('handles != and numeric comparisons', () => {
    expect(evalExpr('a != b', { a: 1, b: 2 })).toBe(true);
    expect(evalExpr('a < b', { a: 1, b: 2 })).toBe(true);
    expect(evalExpr('a > b', { a: 2, b: 1 })).toBe(true);
    expect(evalExpr('a <= b', { a: 2, b: 2 })).toBe(true);
    expect(evalExpr('a >= b', { a: 2, b: 2 })).toBe(true);
  });

  it('compares numerically when both sides coerce to finite numbers', () => {
    // '5' < '10' would be false as strings ('5' > '10' lexically); as
    // numbers it's true.
    expect(evalExpr('a < b', { a: '5', b: '10' })).toBe(true);
  });

  it('falls back to string comparison when one side is non-numeric', () => {
    expect(evalExpr("a < 'zzz'", { a: 'aaa' })).toBe(true);
  });
});

describe('evalExpr — logical operators', () => {
  it('handles and/or/not', () => {
    expect(evalExpr('a and b', { a: 1, b: 1 })).toBe(true);
    expect(evalExpr('a and b', { a: 1, b: 0 })).toBe(false);
    expect(evalExpr('a or b', { a: 0, b: 1 })).toBe(true);
    expect(evalExpr('not(a)', { a: 0 })).toBe(true);
    expect(evalExpr('not(a)', { a: 1 })).toBe(false);
  });

  it('short-circuits and/or with XPath semantics (not JS lazy)', () => {
    // XPath boolean operators always coerce. These still produce
    // boolean output even though operands are mixed types.
    expect(evalExpr('s and n', { s: 'yes', n: 1 })).toBe(true);
    expect(evalExpr("s and n", { s: '', n: 1 })).toBe(false);
  });
});

describe('evalExpr — arithmetic', () => {
  it('handles addition, subtraction, multiplication, division, mod', () => {
    expect(evalExpr('a + b', { a: 40, b: 2 })).toBe(42);
    expect(evalExpr('a - b', { a: 40, b: 2 })).toBe(38);
    expect(evalExpr('a * b', { a: 6, b: 7 })).toBe(42);
    expect(evalExpr('a / b', { a: 84, b: 2 })).toBe(42);
    expect(evalExpr('a mod b', { a: 10, b: 3 })).toBe(1);
  });

  it('concatenates strings with + when any operand is a string', () => {
    expect(evalExpr("'hello-' + name", { name: 'world' })).toBe('hello-world');
  });

  it('handles unary minus', () => {
    expect(evalExpr('-foo', { foo: 5 })).toBe(-5);
    expect(evalExpr('-foo', { foo: 0 })).toBe(-0);
  });

  it('honours multiplication precedence (a + b * c)', () => {
    expect(evalExpr('a + b * c', { a: 1, b: 2, c: 3 })).toBe(7);
  });

  it('respects parentheses ((a + b) * c)', () => {
    expect(evalExpr('(a + b) * c', { a: 1, b: 2, c: 3 })).toBe(9);
  });

  it('throws on divide by zero', () => {
    expect(() => evalExpr('a / 0', { a: 1 })).toThrow(/division by zero/);
  });

  it('throws on mod by zero', () => {
    expect(() => evalExpr('a mod 0', { a: 1 })).toThrow(/mod by zero/);
  });

  it('throws on non-numeric - / * / mod', () => {
    expect(() => evalExpr("a - b", { a: 'x', b: 1 })).toThrow(ExprOutOfScope);
    expect(() => evalExpr("a * b", { a: 'x', b: 1 })).toThrow(ExprOutOfScope);
    expect(() => evalExpr("a / b", { a: 'x', b: 1 })).toThrow(ExprOutOfScope);
    expect(() => evalExpr("a mod b", { a: 'x', b: 1 })).toThrow(ExprOutOfScope);
  });
});

describe('evalExpr — smil-language() built-in', () => {
  it('returns true when state.lang matches', () => {
    expect(evalExpr("smil-language('en')", { lang: 'en' })).toBe(true);
  });

  it('returns false when state.lang differs', () => {
    expect(evalExpr("smil-language('fr')", { lang: 'en' })).toBe(false);
  });

  it('throws when state.lang is unset', () => {
    expect(() => evalExpr("smil-language('en')", {})).toThrow(/lang/);
  });

  it('throws on non-string argument', () => {
    expect(() => evalExpr('smil-language(lang)', { lang: 'en' })).toThrow(ExprOutOfScope);
  });
});

describe('evalExpr — syntax errors', () => {
  it('throws on trailing junk', () => {
    expect(() => evalExpr('1 2', {})).toThrow(/unexpected/);
  });

  it('throws on unterminated string', () => {
    expect(() => evalExpr("'hello", {})).toThrow(/unterminated/);
  });

  it('throws on mismatched parentheses', () => {
    expect(() => evalExpr('(a + 1', { a: 1 })).toThrow(/expected '\)'/);
  });

  it('throws on unknown function', () => {
    expect(() => evalExpr('bogus(1)', {})).toThrow(/unknown function/);
  });

  it('throws on unexpected character', () => {
    expect(() => evalExpr('a @ b', { a: 1, b: 1 })).toThrow(/unexpected character/);
  });
});

describe('evalExpr — store-like state (has/get duck-type)', () => {
  it('resolves identifiers via .get() when present', () => {
    const state = {
      get: (k) => (k === 'foo' ? 42 : undefined),
      has: (k) => k === 'foo'
    };
    expect(evalExpr('foo', state)).toBe(42);
    expect(() => evalExpr('bar', state)).toThrow(ExprOutOfScope);
  });

  it('resolves smil-language() against a store', () => {
    const state = {
      get: (k) => (k === 'lang' ? 'en' : undefined),
      has: (k) => k === 'lang'
    };
    expect(evalExpr("smil-language('en')", state)).toBe(true);
  });
});

describe('asBool — XPath 1.0 truthiness', () => {
  it('coerces booleans directly', () => {
    expect(asBool(true)).toBe(true);
    expect(asBool(false)).toBe(false);
  });

  it('treats 0 and NaN as false; other numbers as true', () => {
    expect(asBool(0)).toBe(false);
    expect(asBool(NaN)).toBe(false);
    expect(asBool(1)).toBe(true);
    expect(asBool(-1)).toBe(true);
  });

  it('treats empty string as false; non-empty as true', () => {
    expect(asBool('')).toBe(false);
    expect(asBool('x')).toBe(true);
    expect(asBool('0')).toBe(true);   // non-empty!
  });
});
