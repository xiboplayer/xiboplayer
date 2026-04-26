// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Scaffolding test file for packages/proxy/src/migrate-cache.js.
 *
 * 140 LOC one-shot migration from per-instance cache to shared cache.
 * Called from:
 *   - xiboplayer-electron/src/main.js:393
 *   - xiboplayer-chromium/xiboplayer/server/server.js:70
 *
 * Currently zero tests. If the hardlink path chooses wrong, or the
 * subsequent rmdir catches a shared inode, a player upgrade can
 * lose cached media — forcing a full re-download at next boot, on
 * signage that may be intentionally offline.
 *
 * Per D-tests-coverage-gap.md #12: data-loss risk on upgrade.
 *
 * All tests below are `.todo`. Follow-up PR should:
 *   1. Use vi.mock('fs') OR memfs for an in-memory filesystem harness.
 *   2. Build a realistic before-state:
 *        ~/.local/share/xiboplayer/{instance-a,instance-b}/cache/123/media/{a,b,c}
 *      and a shared/ that MAY already have some of those files.
 *   3. After migrateContentCache, assert:
 *        - every source file exists at shared/cache/{cmsId}/media/
 *        - hardlink st_ino matches (no data copy)
 *        - old per-instance dir is rmdir'd
 *        - partial migration (power failure mid-loop) is idempotent
 *        - collision: if shared/ already has a file with the same name
 *          but different inode, DO NOT clobber silently
 *
 * Scaffold: overnight-audit-2026-04-21/D-tests-coverage-gap.md #12.
 */

import { describe, it } from 'vitest';

describe('migrateContentCache — happy path', () => {
  it.todo('single instance with 3 media files → hardlinked to shared + old dir removed');
  it.todo('two instances each with unique files → both merged into shared');
  it.todo('hardlink preserves inode (no data copy)');
  it.todo('file permissions preserved post-migration');
});

describe('migrateContentCache — idempotence', () => {
  it.todo('re-running after successful migration is a no-op');
  it.todo('re-running after partial (fs.link succeeded, rmdir pending) completes');
  it.todo('missing source dir (never had cache) exits clean — no throw');
});

describe('migrateContentCache — collision safety', () => {
  it.todo('shared/ already has file with same name + same inode → skip');
  it.todo('shared/ already has file with same name + DIFFERENT inode → LOG + keep shared');
  it.todo('never clobbers shared/ content under any race');
});

describe('migrateContentCache — edge cases', () => {
  it.todo('read-only source dir surfaces a clear error (not a silent EACCES)');
  it.todo('cross-filesystem: hardlink EXDEV falls back to copy+unlink OR logs clearly');
  it.todo('empty cache dir exists but no files → rmdir cleanly');
  it.todo('dataHome does not contain xiboplayer/ → no-op');
});
