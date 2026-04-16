// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * SMIL State / XPath 1.0 subset expression evaluator.
 *
 * This is the Track B runtime counterpart of the Track A compile-time
 * folder in `xiboplayer-smil-tools/src/xlf-builder.js`. The grammar and
 * semantics are identical — the translator folds what it can at build
 * time against `xp:state-init`; anything referencing mutable state is
 * left as-is and re-evaluated here at runtime against an `XpStateStore`
 * (or any plain object exposing the same identifier lookups).
 *
 * Keeping the two implementations in lock-step is a round-trip safety
 * invariant: Track A and Track B MUST agree on what `expr` means, so
 * promoting an expression from "out-of-scope" → "folded" never changes
 * observable playback.
 *
 * Grammar (whitespace-insensitive, XPath 1.0 precedence from lowest to
 * highest):
 *
 *   expr      := orExpr
 *   orExpr    := andExpr ("or" andExpr)*
 *   andExpr   := eqExpr  ("and" eqExpr)*
 *   eqExpr    := relExpr (("=" | "!=" | "==") relExpr)*
 *   relExpr   := addExpr (("<=" | ">=" | "<" | ">") addExpr)*
 *   addExpr   := mulExpr (("+" | "-") mulExpr)*
 *   mulExpr   := unaryExpr (("*" | "/" | "mod") unaryExpr)*
 *   unaryExpr := "-" unaryExpr | primary
 *   primary   := NUMBER | STRING | "not" "(" expr ")"
 *             |  "smil-language" "(" STRING ")" | IDENT | "(" expr ")"
 *
 * Strings are single- or double-quoted. IDENT resolves against the
 * `state` object (or store) via its `get(name)` / property lookup.
 * Built-in `smil-language('x')` resolves against `state.lang`.
 *
 * XPath 1.0 spells equality as `=`; we also accept JS-style `==` as
 * a convenience alias and emit an `XP_EXPR_JS_ALIAS` lint warning
 * (matches Track A).
 */

/**
 * Named error thrown when an `expr=` attribute uses a construct the
 * evaluator cannot handle (unknown identifier, unknown built-in,
 * divide-by-zero, …). Callers typically catch this and fall back to a
 * safe default (e.g. treat an `xp:if=` guard as `false` so the element
 * hides rather than crashing the layout).
 */
export class ExprOutOfScope extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExprOutOfScope';
  }
}

/**
 * Evaluate an expression against a state lookup.
 *
 * @param {string} expr - raw attribute value
 * @param {Record<string, unknown> | { get: (name: string) => unknown, has?: (name: string) => boolean, lang?: unknown }} state
 *        Either a plain object or an object exposing `get(name)` /
 *        optional `has(name)` (the `XpStateStore` contract).
 * @param {Array<{code: string, message: string}>} [warningsOut] - optional
 *        collector for lint-style warnings.
 * @returns {boolean | number | string}
 */
export function evalExpr(expr, state, warningsOut) {
  const src = String(expr);
  const tokens = tokenize(src);
  if (tokens.length === 0) throw new ExprOutOfScope('empty expression');
  const p = { tokens, pos: 0, src, warnings: warningsOut };
  const result = parseOrExpr(p, state);
  if (p.pos < p.tokens.length) {
    const t = p.tokens[p.pos];
    throw new ExprOutOfScope(
      `unexpected token "${t.value}" at offset ${t.offset}`
    );
  }
  return result;
}

/**
 * Coerce a folded value to boolean using XPath 1.0 semantics. Exposed
 * for callers that evaluate `xp:if=` / `expr=` as a guard.
 */
export function asBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (typeof v === 'string') return v.length > 0;
  return Boolean(v);
}

// ── Lexer ─────────────────────────────────────────────────────────────

function tokenize(src) {
  const tokens = [];
  const len = src.length;
  let i = 0;
  while (i < len) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    const start = i;
    // String literals: single- or double-quoted.
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new ExprOutOfScope(`unterminated string starting at ${i}`);
      tokens.push({ type: 'str', value: src.slice(i + 1, end), offset: start });
      i = end + 1;
      continue;
    }
    // Numbers: integer or decimal. Sign is handled by unary minus in
    // the parser — avoids ambiguity with subtraction.
    if (c >= '0' && c <= '9') {
      let j = i + 1;
      while (j < len && src[j] >= '0' && src[j] <= '9') j++;
      if (j < len && src[j] === '.') {
        j++;
        while (j < len && src[j] >= '0' && src[j] <= '9') j++;
      }
      tokens.push({ type: 'num', value: src.slice(i, j), offset: start });
      i = j;
      continue;
    }
    // Identifiers: letter (or underscore), then letters/digits/./_.
    // Hyphens are accepted inside the ident body only when the next
    // character after the hyphen is another ident-body char; this
    // lets `smil-language` tokenise as one word while `a - b` still
    // parses as subtraction.
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_') {
      let j = i + 1;
      while (j < len) {
        const d = src[j];
        if (
          (d >= 'A' && d <= 'Z') ||
          (d >= 'a' && d <= 'z') ||
          (d >= '0' && d <= '9') ||
          d === '_' ||
          d === '.'
        ) {
          j++;
          continue;
        }
        if (d === '-' && j + 1 < len) {
          const e = src[j + 1];
          if (
            (e >= 'A' && e <= 'Z') ||
            (e >= 'a' && e <= 'z') ||
            (e >= '0' && e <= '9') ||
            e === '_'
          ) {
            j += 2;
            continue;
          }
        }
        break;
      }
      tokens.push({ type: 'ident', value: src.slice(i, j), offset: start });
      i = j;
      continue;
    }
    // Multi-char operators first (longest match).
    const two = src.slice(i, i + 2);
    if (two === '!=' || two === '<=' || two === '>=' || two === '==') {
      tokens.push({ type: 'op', value: two, offset: start });
      i += 2;
      continue;
    }
    if (c === '(' || c === ')') {
      tokens.push({ type: c === '(' ? 'lparen' : 'rparen', value: c, offset: start });
      i++;
      continue;
    }
    if (
      c === '+' || c === '-' || c === '*' || c === '/' ||
      c === '<' || c === '>' || c === '='
    ) {
      tokens.push({ type: 'op', value: c, offset: start });
      i++;
      continue;
    }
    throw new ExprOutOfScope(`unexpected character "${c}" at offset ${i}`);
  }
  return tokens;
}

function peekTok(p) {
  return p.tokens[p.pos];
}

function consumeIf(p, type, value) {
  const t = p.tokens[p.pos];
  if (!t) return null;
  if (t.type !== type) return null;
  if (value !== undefined && t.value !== value) return null;
  p.pos++;
  return t;
}

// ── Parser (lowest precedence first) ─────────────────────────────────

function parseOrExpr(p, state) {
  let left = parseAndExpr(p, state);
  while (consumeIf(p, 'ident', 'or')) {
    const right = parseAndExpr(p, state);
    left = asBool(left) || asBool(right);
  }
  return left;
}

function parseAndExpr(p, state) {
  let left = parseEqExpr(p, state);
  while (consumeIf(p, 'ident', 'and')) {
    const right = parseEqExpr(p, state);
    left = asBool(left) && asBool(right);
  }
  return left;
}

function parseEqExpr(p, state) {
  let left = parseRelExpr(p, state);
  while (true) {
    const eq = consumeIf(p, 'op', '=');
    const js = !eq && consumeIf(p, 'op', '==');
    const neq = !eq && !js && consumeIf(p, 'op', '!=');
    if (!eq && !js && !neq) break;
    if (js && p.warnings) {
      p.warnings.push({
        code: 'XP_EXPR_JS_ALIAS',
        message: `expr= uses JS-style "==" — XPath 1.0 spells equality as "="; evaluator accepts both.`
      });
    }
    const right = parseRelExpr(p, state);
    const op = neq ? '!=' : '=';
    left = applyCmp(left, op, right);
  }
  return left;
}

function parseRelExpr(p, state) {
  let left = parseAddExpr(p, state);
  while (true) {
    const t = peekTok(p);
    if (!t || t.type !== 'op') break;
    if (t.value !== '<' && t.value !== '>' && t.value !== '<=' && t.value !== '>=') break;
    p.pos++;
    const right = parseAddExpr(p, state);
    left = applyCmp(left, t.value, right);
  }
  return left;
}

function parseAddExpr(p, state) {
  let left = parseMulExpr(p, state);
  while (true) {
    const plus = consumeIf(p, 'op', '+');
    const minus = !plus && consumeIf(p, 'op', '-');
    if (!plus && !minus) break;
    const right = parseMulExpr(p, state);
    if (plus) left = applyAdd(left, right);
    else left = applySub(left, right);
  }
  return left;
}

function parseMulExpr(p, state) {
  let left = parseUnary(p, state);
  while (true) {
    const mul = consumeIf(p, 'op', '*');
    const div = !mul && consumeIf(p, 'op', '/');
    const mod = !mul && !div && consumeIf(p, 'ident', 'mod');
    if (!mul && !div && !mod) break;
    const right = parseUnary(p, state);
    if (mul) left = applyMul(left, right);
    else if (div) left = applyDiv(left, right);
    else left = applyMod(left, right);
  }
  return left;
}

function parseUnary(p, state) {
  if (consumeIf(p, 'op', '-')) {
    const inner = parseUnary(p, state);
    const n = Number(inner);
    if (!Number.isFinite(n)) {
      throw new ExprOutOfScope(
        `unary minus applied to non-numeric value "${inner}"`
      );
    }
    return -n;
  }
  return parsePrimary(p, state);
}

function parsePrimary(p, state) {
  const t = p.tokens[p.pos];
  if (!t) throw new ExprOutOfScope('unexpected end of expression');
  if (t.type === 'num') {
    p.pos++;
    return parseFloat(t.value);
  }
  if (t.type === 'str') {
    p.pos++;
    return t.value;
  }
  if (t.type === 'lparen') {
    p.pos++;
    const v = parseOrExpr(p, state);
    if (!consumeIf(p, 'rparen')) throw new ExprOutOfScope(`expected ')' at offset ${t.offset}`);
    return v;
  }
  if (t.type === 'ident') {
    // Reserved keywords that must not start a primary.
    if (t.value === 'and' || t.value === 'or' || t.value === 'mod') {
      throw new ExprOutOfScope(
        `unexpected keyword "${t.value}" at offset ${t.offset}`
      );
    }
    p.pos++;
    // Built-ins + not(): identifier followed by '(' is a function call.
    if (consumeIf(p, 'lparen')) {
      if (t.value === 'not') {
        const inner = parseOrExpr(p, state);
        if (!consumeIf(p, 'rparen')) throw new ExprOutOfScope("expected ')' closing not(");
        return !asBool(inner);
      }
      if (t.value === 'smil-language') {
        const arg = p.tokens[p.pos];
        if (!arg || arg.type !== 'str') {
          throw new ExprOutOfScope('smil-language() expects a string literal argument');
        }
        p.pos++;
        if (!consumeIf(p, 'rparen')) throw new ExprOutOfScope("expected ')' closing smil-language(");
        const lang = resolveIdent('lang', state, /*optional*/ true);
        if (lang === undefined || lang === null) {
          throw new ExprOutOfScope('smil-language() called but xp:state-init.lang is unset');
        }
        return String(lang) === arg.value;
      }
      throw new ExprOutOfScope(`unknown function: ${t.value}()`);
    }
    return resolveIdent(t.value, state, false);
  }
  throw new ExprOutOfScope(`unexpected token "${t.value}" at offset ${t.offset}`);
}

/**
 * Resolve an identifier against `state`. Supports two shapes:
 *   1. Plain object  — `hasOwnProperty` + property access
 *   2. Store-like    — duck-typed by presence of `.get` (Function)
 *
 * When `optional` is true and the identifier is missing, returns
 * `undefined` instead of throwing (used by the smil-language() built-in
 * to probe for `lang` without forcing callers to pre-seed it).
 */
function resolveIdent(name, state, optional) {
  if (state && typeof state.get === 'function') {
    const has = typeof state.has === 'function' ? state.has(name) : state.get(name) !== undefined;
    if (!has) {
      if (optional) return undefined;
      throw new ExprOutOfScope(`unknown identifier: ${name}`);
    }
    return state.get(name);
  }
  if (state && Object.hasOwn(state, name)) {
    return state[name];
  }
  if (optional) return undefined;
  throw new ExprOutOfScope(`unknown identifier: ${name}`);
}

// ── Operator helpers ──────────────────────────────────────────────────

function applyCmp(lhs, op, rhs) {
  // Number comparisons when both sides coerce to a finite number;
  // string comparisons otherwise. Matches XPath 1.0 loose typing.
  const ln = Number(lhs);
  const rn = Number(rhs);
  const bothNum = Number.isFinite(ln) && Number.isFinite(rn);
  const a = bothNum ? ln : String(lhs);
  const b = bothNum ? rn : String(rhs);
  switch (op) {
    case '=': return a === b;
    case '!=': return a !== b;
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
  }
  throw new ExprOutOfScope(`unknown comparator: ${op}`);
}

function applyAdd(lhs, rhs) {
  // Per W3C SMIL State, `+` on a string operand concatenates; on
  // numeric operands it adds. If either side is a string we take
  // the concatenation branch (mirrors JS semantics); otherwise both
  // must coerce to finite numbers.
  if (typeof lhs === 'string' || typeof rhs === 'string') {
    return String(lhs) + String(rhs);
  }
  const ln = Number(lhs);
  const rn = Number(rhs);
  if (!Number.isFinite(ln) || !Number.isFinite(rn)) {
    throw new ExprOutOfScope(
      `"+" applied to non-numeric operand (lhs=${lhs}, rhs=${rhs})`
    );
  }
  return ln + rn;
}

function applySub(lhs, rhs) {
  const ln = Number(lhs);
  const rn = Number(rhs);
  if (!Number.isFinite(ln) || !Number.isFinite(rn)) {
    throw new ExprOutOfScope(
      `"-" applied to non-numeric operand (lhs=${lhs}, rhs=${rhs})`
    );
  }
  return ln - rn;
}

function applyMul(lhs, rhs) {
  const ln = Number(lhs);
  const rn = Number(rhs);
  if (!Number.isFinite(ln) || !Number.isFinite(rn)) {
    throw new ExprOutOfScope(
      `"*" applied to non-numeric operand (lhs=${lhs}, rhs=${rhs})`
    );
  }
  return ln * rn;
}

function applyDiv(lhs, rhs) {
  const ln = Number(lhs);
  const rn = Number(rhs);
  if (!Number.isFinite(ln) || !Number.isFinite(rn)) {
    throw new ExprOutOfScope(
      `"/" applied to non-numeric operand (lhs=${lhs}, rhs=${rhs})`
    );
  }
  if (rn === 0) throw new ExprOutOfScope('division by zero');
  return ln / rn;
}

function applyMod(lhs, rhs) {
  const ln = Number(lhs);
  const rn = Number(rhs);
  if (!Number.isFinite(ln) || !Number.isFinite(rn)) {
    throw new ExprOutOfScope(
      `"mod" applied to non-numeric operand (lhs=${lhs}, rhs=${rhs})`
    );
  }
  if (rn === 0) throw new ExprOutOfScope('mod by zero');
  // XPath 1.0 mod is the remainder of truncating division — matches
  // the JS `%` operator for finite operands.
  return ln % rn;
}
