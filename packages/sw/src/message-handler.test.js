// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Scaffolding test file for packages/sw/src/message-handler.js.
 *
 * 98 LOC of SW postMessage contract between PwaPlayer client and
 * ServiceWorker. Currently zero tests as of 2026-04-21.
 *
 * Per D-tests-coverage-gap.md #9 (sw/message-handler.js): unknown op,
 * stale-client, timeout semantics all uncovered.
 *
 * All tests below are `.todo`. Follow-up PR should:
 *   1. Build a fake `event` object shaped like SW MessageEvent.
 *   2. Inject a mock downloadManager with the minimum interface
 *      MessageHandler touches (addFile, removeFile, getStoreKey).
 *   3. Replace each .todo with a real test.
 *
 * Scaffold: overnight-audit-2026-04-21/D-tests-coverage-gap.md #9.
 */

import { describe, it } from 'vitest';

describe('MessageHandler.handleMessage — contract', () => {
  it.todo('unknown message.type → no-op (no throw, no warn-spam)');
  it.todo('type=ADD_FILE without data → posts back {error:"data required"}');
  it.todo('type=ADD_FILE with valid file → forwards to downloadManager');
  it.todo('type=REMOVE_FILE → forwards to downloadManager and acks');
  it.todo('type=PING → replies with PONG + sw version');
});

describe('MessageHandler.handleMessage — client lifecycle', () => {
  it.todo('event.source null (stale client) → swallows without throwing');
  it.todo('event.source.postMessage throws (client closed) → caught + logged once');
  it.todo('concurrent ADD_FILE messages maintain per-file ordering');
});

describe('MessageHandler — key derivation (storeKeyFrom)', () => {
  it.todo('path with query string drops ?params');
  it.todo('path with leading slash is stripped');
  it.todo('missing path falls back to {type}/{id}');
  it.todo('empty path + empty type/id does not throw');
});

describe('MessageHandler — download queue integration', () => {
  it.todo('ADD_FILE of already-downloading key is idempotent (no double enqueue)');
  it.todo('REMOVE_FILE mid-download cancels cleanly');
  it.todo('downloadManager rejection surfaces as postMessage{error}');
});
