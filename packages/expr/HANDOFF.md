# Track B SMIL State — HANDOFF

**Agent session**: 2026-04-16
**Plan**: Track B runtime xp:state store + setvalue/expr evaluator (companion to
Track A compile-time folding shipped in xiboplayer-smil-tools commit `78cd029`).

## What landed this pass

### Commits (xiboplayer monorepo, `main`)

1. `3414b3a` — **`feat(expr): @xiboplayer/expr — runtime XPath 1.0 subset evaluator + xp:state store`**
   - New workspace package `packages/expr/` with 72 unit tests.
   - `evalExpr` / `asBool` / `ExprOutOfScope` — XPath 1.0 subset (and/or/not,
     =/!=/<=/>=, +/-/*/÷/mod, unary minus, parentheses, identifier lookup,
     `smil-language()` built-in). Ported verbatim from the compile-time folder
     in `xiboplayer-smil-tools/src/xlf-builder.js` so Track A and Track B agree
     on semantics — round-trip safety.
   - `avtSubstitute` / `avtSubstituteLossy` / `avtIdentifiers` — `{ident}`
     attribute-value templates with strict (null on unresolved) and lossy
     (empty string) modes, plus an identifier enumerator for dependency
     tracking.
   - `XpStateStore` — mutable runtime container with
     `document`/`session`/`display` scopes (session default per Q1 decision
     2026-04-16). Dot-path get/set/delete, change + change:<path> events with
     ancestor propagation, localStorage persistence for display scope,
     snapshot/reset.

2. `2c67a5a` — **`feat(renderer): wire xpIf runtime gating via @xiboplayer/expr`**
   - `RendererLite.setStateStore(store)` / `getStateStore()` / `reevaluateXpIf()`.
   - `parseWidget` captures `xpIf` / `xpDayPart` / `xpDatasource` /
     `xpJsonpath` / `xpMatch` pass-through attributes.
   - `_showWidget` checks `xpIf` before DOM bind; hidden widgets still consume
     region-timer slots (matches Track A drop semantics).
   - Auto-subscribed to store `change` events on `setStateStore`; unsubscribed
     on cleanup or store replacement. `data-xp-if=true/false` on widget DOM.
   - `xpIfHidden` / `xpIfReevaluated` renderer events.
   - 15 new integration tests in `renderer-lite.xpstate.test.js`.

3. `6470cdd` — **`chore(lockfile): register @xiboplayer/renderer → @xiboplayer/expr link`**
   - pnpm-lock sync for `pnpm install --frozen-lockfile`.

### Test counts

| Stage                                       | Tests |
| ------------------------------------------- | ----- |
| Baseline (before any Track B work)          | 1799  |
| After commit 1 (expr package)               | 1871  |
| After commit 2 (renderer integration)       | 1952  |

`pnpm test` stays green end-to-end; no regressions.

### W3C State test scope deltas (TB6)

Of the 4 State tests currently marked `"scope": "in"` in
`xiboplayer-smil-tools/test/smil3-scope.json`:

- `test-01-avt.smil` — AVT interpolation. Already in; Track B now provides
  the runtime substitution path (`avtSubstituteLossy`). **Stays in.**
- `test-02-setvalue.smil` — `<setvalue>` element. Already marked in for
  Track A fold; **Track B runtime dispatch of `<setvalue>` is NOT wired
  yet** (see "Remaining work" TB3 below).
- `test-07-expr.smil` — `expr=` attribute. Runtime evaluator now exists.
  **Stays in.**
- `test-08-language.smil` — `smil-language()` built-in. Runtime evaluator
  supports it. **Stays in.**

Of the 7 marked `"scope": "out"`, none become in-scope with just this
pass. Promotion of `test-03`/`test-06` (`<newvalue>`) and `test-11`
(`statechanged` subscription) requires TB3 (setvalue dispatcher) to land
first. **No scope update is emitted this session** — the changes would
be cosmetic until TB3 ships a parser + dispatcher for `<setvalue>`.

Once TB3 lands, a follow-up agent can promote `test-03`, `test-06`, and
`test-11` from `out` → `in` (3 promotions → 7/11 total in-scope).

## Architectural decisions taken

1. **Evaluator lives in `@xiboplayer/expr`, not ported into `xiboplayer-smil-tools`.**
   Plan called out `@xiboplayer/expr` as the preferred shape — and the
   round-trip invariant is best served by a *single source of truth* that
   both translator and renderer import. This pass creates the package; the
   cross-repo move of the translator's inline evaluator into
   `@xiboplayer/expr` is **deferred** (Track A code still has its own copy).
   The two are byte-for-byte equivalent right now and both covered by test
   suites that would catch any drift.

   **Recommended next step**: have xiboplayer-smil-tools depend on
   `@xiboplayer/expr` (publish a tag, or npm link, or git-submodule) and
   delete its inline evaluator. That's the true round-trip guarantee. For
   now the invariant is enforced by "matching test sets in both repos".

2. **Scope default = `session`** (per Q1 decision in the task brief).
   Encoded in `XpStateStore` constructor. The constructor rejects unknown
   scopes outright.

3. **Store duck-typing.** `evalExpr` accepts either a plain object (Track A's
   `xp:state-init` shape) or a store-like `{get, has}` (Track B). This kept
   the compile-time and runtime call sites symmetric without adapter shims.

4. **xpIf safe-default is `false` on evaluation error.** An unresolved
   identifier at runtime hides the widget rather than showing it. Rationale:
   a broken guard must never leak content that was meant to be suppressed
   (e.g. `xpIf="guest.minor = false"` — if `guest` is missing, hiding is
   safer than showing the age-restricted content).

5. **No `setvalue` parser / dispatcher yet.** The XLF coming out of Track A
   never carries `<setvalue>` — it's all been folded. Wiring the runtime
   dispatcher requires either (a) a new XLF schema extension Xibo CMS
   round-trips, or (b) a parallel SMIL-native playback path. This pass
   **does not** commit to either.

6. **Renderer → store coupling is one-way.** `RendererLite.setStateStore`
   is an injection; the renderer does NOT create the store. The PWA owns
   the store's lifecycle (scope-appropriate persistence + reset on layout
   change for `document` scope).

## Remaining work for next agent / session

### TB3 — `<setvalue>` / `<newvalue>` / `<delvalue>` runtime dispatch

**Not started.** Requires:

1. **Decide the carrier format.** Options:
   - (a) **XLF schema extension.** Emit `<setvalue>`/`<newvalue>`/`<delvalue>`
     as new child elements of `<media>` or `<action>` in
     `xiboplayer-smil-tools/src/xlf-builder.js`. Pro: one pipeline. Con:
     CMS round-trip risk — may need a CMS-side schema patch.
   - (b) **Reuse xp:action descriptors.** Add `effect.type = "setState"` etc.
     to the existing `xp:action` grammar. Pro: CMS already passes these
     through unchanged. Con: overloads the "action" concept.
   - (c) **Parallel SMIL playback.** Ship the raw SMIL model via a separate
     channel; renderer parses `<setvalue>` natively. Pro: spec-faithful.
     Con: two playback paths.

2. **Wire the parser.** `renderer-lite.js:parseWidget` extracts setvalue
   descriptors from whatever carrier (a) — (c) lands on.

3. **Dispatcher hook.** On widget `begin` time (reuse `widgetStart` event or
   a new `begin` timing source), call `store.set(ref, evaluate(value))`.

4. **`<newvalue>` / `<delvalue>`.** `newvalue` creates keys, `delvalue`
   removes them. Shape is symmetric with `setvalue`.

5. **Tests.** Add integration tests that drive a layout through a
   begin-time mutation and assert the store reflects the new value +
   subsequent `xpIf` on another widget flips visibility.

**Estimate**: 0.5–1 day if XLF schema path; 2–3 days if SMIL-native path.

### Cross-repo: move `evalExpr` out of `xiboplayer-smil-tools` and import
`@xiboplayer/expr` instead

One source of truth. Today both repos duplicate the evaluator. After
`@xiboplayer/expr@0.7.22` (or whatever the next publish tag is) is live,
`xiboplayer-smil-tools/package.json` should add `@xiboplayer/expr` as a
dep and `src/xlf-builder.js` should `import { evalExpr, avtSubstitute }
from '@xiboplayer/expr'` — deleting its inline copies.

**Estimate**: 1–2 hours once the package is published.

### Live `change:<path>` subscription for xpIf re-evaluation

Current implementation subscribes broadly to `change` and walks all
widgets on every state mutation. For a layout with 100s of widgets +
fast-changing state, this is O(widgets × mutations). A future
optimisation:

1. Parse the widget's `xpIf` once; collect identifiers via a new
   `exprIdentifiers(expr)` helper (mirror of `avtIdentifiers`).
2. Subscribe to `change:<id>` per identifier.
3. Mark only affected widgets dirty; re-evaluate on next animation frame.

**Estimate**: ~0.5 day. Only worth it if profiling shows re-evaluation
is a hot path.

### Full AVT runtime substitution for `src=` / `text` content

`avtSubstituteLossy` exists in `@xiboplayer/expr` but the renderer
doesn't call it yet — widget `src`/`uri`/text that still contains
unresolved `{ident}` placeholders (Track A couldn't fold) will render
with the braces visible. Hook points: `renderMedia` variants in
`renderer-lite.js` + image/text widget builders. Subscribe to
`change:<identifier>` per affected identifier; re-render on change.

**Estimate**: 0.5 day.

### TB6 scope promotions

Once TB3 ships, promote in `xiboplayer-smil-tools/test/smil3-scope.json`:

- `test-03-newvalue.smil` → `"scope": "in"`
- `test-06-newvalue.smil` → `"scope": "in"`
- `test-11-statechanged.smil` → `"scope": "in"`

Brings State-module coverage from **4/11 → 7/11**. A follow-up with
`<state src="…"/>` support (loading external state documents) could
push `test-04`/`test-09`/`test-10` to **10/11**. The remaining
`test-05-send.smil` (submission / HTTP POST) is out of scope until
xiboplayer grows an HTTP submit pathway.

## Files touched

- `packages/expr/` — new package (9 files, 1436 insertions)
- `packages/renderer/package.json` — add `@xiboplayer/expr` dep
- `packages/renderer/src/renderer-lite.js` — store + xpIf wiring
- `packages/renderer/src/index.d.ts` — type declarations
- `packages/renderer/src/renderer-lite.xpstate.test.js` — new tests
- `packages/renderer/vitest.config.js` — alias for standalone runs
- `pnpm-lock.yaml` — workspace edge

## Unresolved questions for the user

1. **Cross-repo evaluator move** — should I publish `@xiboplayer/expr@0.7.22`
   and update `xiboplayer-smil-tools` to import it, eliminating the
   duplicate? Or stage that after TB3 lands?

2. **Setvalue carrier format (a/b/c above).** This is the biggest
   architectural call for TB3 and should be made before the next agent
   picks it up. My lean: **(b) `xp:action` `effect.type = "setState"`** —
   reuses the already-wired CMS round-trip path.

3. **`@xiboplayer/expr` version bumping** — package is at `0.7.21` to match
   the rest of the monorepo. First publish will need `release-xiboplayer.yml`
   to pick it up. Verify nothing special is needed.
