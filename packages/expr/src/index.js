// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * @xiboplayer/expr — SMIL State (Track B) runtime
 *
 * Two halves:
 *   1. `evalExpr` — XPath 1.0 subset evaluator, matching the compile-time
 *      folder in xiboplayer-smil-tools so Track A and Track B agree on
 *      what an `expr=` attribute means.
 *   2. `XpStateStore` — mutable runtime state with document/session/display
 *      scopes, feeding the evaluator and emitting change events the
 *      renderer uses to re-evaluate `xp:if=` conditional visibility.
 */

export { evalExpr, asBool, ExprOutOfScope } from './expr.js';
export { avtSubstitute, avtSubstituteLossy, avtIdentifiers } from './avt.js';
export { XpStateStore } from './state.js';
export { parseXpStateInit } from './xp-state-init.js';
