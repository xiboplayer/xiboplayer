// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Standalone test server script.
 * Starts the proxy server serving the PWA dist for e2e tests.
 * Invoked by playwright.config.ts webServer.command.
 *
 * When TEST_INJECT_CONFIG=1 is set, the proxy injects CMS config into
 * index.html so the player skips the setup screen — used by player.spec tests.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { startServer } from '../../../../packages/proxy/src/index.js';
import { computeCmsId } from '../../../../packages/utils/src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PWA_DIST = path.resolve(__dirname, '../../dist');
const PORT = parseInt(process.env.TEST_PORT || '18765', 10);

// Default test CMS config — proxy will inject this into index.html
const cmsUrl = `http://localhost:${PORT}`;
const pwaConfig = {
  cmsUrl,
  cmsKey: 'test-key-12345',
  displayName: 'E2E Test Display',
  hardwareKey: 'test-hardware-key-e2e',
  cmsId: computeCmsId(cmsUrl),
  transport: 'xmds',
  controls: {
    keyboard: { enabled: true, setupKey: true },
    mouse: { statusBarOnHover: true },
  },
};

startServer({
  port: PORT,
  pwaPath: PWA_DIST,
  appVersion: '0.0.0-test',
  pwaConfig,
  relaxSslCerts: false,
}).then(({ port }) => {
  console.log(`Test server ready on port ${port}`);
});
