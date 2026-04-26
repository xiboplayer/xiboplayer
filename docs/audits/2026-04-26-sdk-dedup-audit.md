# xiboplayer SDK dedup audit — 2026-04-26

| | |
|---|---|
| Author | Pau Aliagas |
| Scope | `xibo-players/xiboplayer` monorepo only — 18 publishable packages + `packages/ai` + `packages/docs` |
| Out of scope | Form-factor wrappers (electron/chromium/tizen/webos/android/xlr) — separate audit |
| Type | Read-only audit. No code changes in this commit. |
| Companion | `zerosignage/platform` PR #196 (slice A) and PR #195 (slice B) |

## TL;DR

The SDK is in materially better dedup health than the platform side. **Three actionable findings**, total addressable: ~80 LOC of mechanical duplication + 1 phantom directory + 18 vestigial script blocks.

| # | Finding | Files | Risk | Priority |
|---|---|---|---|---|
| 1 | `packages/ai/` is a phantom directory (empty except stale `node_modules/@xiboplayer/`) | `packages/ai/` | LOW | **HIGH** (cleanup) |
| 2 | `vitest` devDep duplicated in every package — already in root devDeps | 18× `packages/*/package.json` | LOW | MEDIUM |
| 3 | `test`/`test:watch`/`test:coverage` scripts repeated in every package — `pnpm -r test` already covers it | 18× `packages/*/package.json` | LOW | LOW |

What is **NOT** dedup despite looking like it:

- 14 different `vitest.config.js` files — meaningful variation (jsdom vs node, integration timeouts, fork-isolation). Not consolidate-able to a single base without losing intent.
- `dependencies: { "@xiboplayer/utils": "workspace:*" }` showing up everywhere — that's structural composition, not duplication.
- The `exports` field per package is well-shaped — no duplication.
- Per-package `tsconfig.json` — only 1 in the entire monorepo. Already centralised.

## Methodology

1. Enumerated all `packages/*/package.json` (18 publishable, 1 phantom `ai`, 1 docs-only `docs`).
2. Diffed scripts blocks; found near-identical `test*` scripts in all but `core` and `pwa`.
3. Hashed all `vitest.config.js` — 14 files, 12 unique, only 2 dup-pairs (`crypto+expr`, `proxy+sync`). Inspected the dups; same trivial config (jsdom + globals).
4. Compared root vs per-package devDependencies.
5. Spot-checked `packages/ai/` and `packages/docs/` for content.

## Finding 1 — `packages/ai/` is a phantom directory

### Evidence

```
$ ls -la packages/ai/
drwxr-xr-x. node_modules
$ ls packages/ai/node_modules/
@xiboplayer/   # empty
```

No `package.json`. No `src/`. No `README.md`. Only a stale `node_modules` containing
an empty `@xiboplayer/` scope. mtime `2026-02-17` — the directory has been a husk for
~10 weeks.

`packages/ai` is **not** listed in the workspace's published packages (none of the
publishable list shows `@xiboplayer/ai`). The `0cs-core` (formerly `xiboplayer-ai`)
repo elsewhere is the *real* AI package; this is a dead in-tree stub.

### Proposal

`git rm -r packages/ai/` and remove from `pnpm-workspace.yaml` if listed.

### Risk

LOW. No imports, no scripts, no symlinks — verified with
`rg "@xiboplayer/ai" packages/` returning nothing meaningful.

### Effort

5 min + verification.

## Finding 2 — `vitest` devDep duplicated in every package

### Evidence

```
$ cat package.json
{
  "devDependencies": {
    "vitest": "^4.1.4",
    "@vitest/coverage-v8": "^4.1.4",
    "fake-indexeddb": "^6.2.5",
    "jsdom": "^29.0.2",
    "@biomejs/biome": "^2.4.12"
  }
}
```

Then in every `packages/*/package.json`:

```
"devDependencies": {
  "vitest": "^4.1.4"
}
```

This is **redundant under pnpm workspaces**: pnpm hoists workspace devDeps and the root
already declares `vitest`. The per-package entries don't pin different versions —
they're all `^4.1.4`. Pure boilerplate.

### Proposal

Remove `"vitest": "^4.1.4"` from each `packages/*/package.json` `devDependencies`.
Verify `pnpm install --frozen-lockfile` still resolves cleanly. Run `pnpm -r test` to
confirm.

The same applies to `@vitest/coverage-v8` if it appears (spot-check pending PR-time).

### Risk

LOW. pnpm's hoisting semantics already serve `vitest` from the root. The lockfile may
need regeneration but the surface effect is zero.

If we ever need different vitest versions per-package, we can add it back to one
package only — the root devDep doesn't lock all packages to the same version, just
provides a default.

### Effort

15 min + lockfile + CI verify.

## Finding 3 — Per-package `test*` scripts vestigial

### Evidence

In every package:

```
"scripts": {
  "test": "vitest run",
  "test:watch": "vitest",
  "test:coverage": "vitest run --coverage"
}
```

Three identical lines × 18 packages = **54 boilerplate script entries**.

The workspace root already provides:

```
"scripts": {
  "test": "vitest run",                              # invokes vitest at root
  "test:watch": "vitest",
  "test:coverage": "vitest run --coverage",
  "test:integration": "VITEST_INTEGRATION=1 vitest run",
  "test:all": "pnpm test && pnpm test:integration"
}
```

Plus `pnpm -r run test` runs the per-package `test` script (which exists *because* the
boilerplate is there). Removing the per-package scripts means root-level
`pnpm test` and `pnpm -r test` both still work — vitest discovers tests from the root,
walking `packages/*/`.

The only real win for keeping per-package scripts is operator muscle memory:
`cd packages/cache && pnpm test`. That's a real concern; this finding is **soft** until
operator preference is checked.

### Proposal — two options

- **Option A — remove all per-package `test*` scripts**.
  Operators run `pnpm test` from the root, optionally with `--filter @xiboplayer/cache`.
  Cleaner, less drift.

- **Option B — leave them as-is**.
  54 lines of boilerplate is cheap. Per-package CD is a real workflow.

Audit recommends **B (leave as-is) at v1**. If operator usage tells us nobody actually
`cd`s into packages, revisit.

### Effort

If A: 30 min + CI verify.
If B: 0 min — close the finding as wontfix.

## What's healthy (don't change)

- `pnpm-workspace.yaml` + `workspace:*` cross-references — clean composition.
- Single root `tsconfig.json`. Per-package overrides absent — meaning JS-only or
  inheriting cleanly.
- Single root `biome.json` — no duplication.
- Per-package `exports` map is precise (named subpath exports, not wildcard) — good
  ESM hygiene.
- `packages/cms-testing/vitest.config.js` deliberately diverges from the default
  (Node env, integration timeouts, fork-isolation) — meaningful customisation, not
  duplication.

## What this audit deliberately does NOT touch

- Form-factor wrapper repos (electron / chromium / tizen / webos / android / xlr). Separate audit when slice-D survey reaches them.
- `arexibo` — Rust native player, different toolchain.
- `xiboplayer-ai` (now `zerosignage/0cs-core`) — covered by RFC #195.
- `xiboplayer-www` — separate Nuxt audit if/when warranted.
- Test coverage gaps — `cd ~/Devel/tecman/xibo-players/xiboplayer && pnpm test:coverage` reports thresholds (50% lines / 40% branches per memory) but coverage is a quality issue, not a dup issue.
- Source code dedup within packages (e.g. shared utility extraction across `cache` / `proxy` / `sync`). That requires reading the source, not metadata; out of scope for a 1-h audit pass.

## Follow-up issues

3 issues filed against `xibo-players/xiboplayer`, one per finding. Each links back to this audit doc and to the relevant evidence section.

---

*Generated as part of autonomous audit session 2026-04-26. See also: `zerosignage/platform` PR #196 (slice A) and #195 (slice B).*
