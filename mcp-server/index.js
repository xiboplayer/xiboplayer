#!/usr/bin/env node

/**
 * XiboPlayer documentation indexer
 *
 * Pre-builds docs-index.json for the MCP server.
 * Can be hosted on gh-pages for remote consumption.
 */

import { readFile, writeFile } from 'fs/promises';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { glob } from 'glob';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SDK_ROOT = resolve(__dirname, '..');

const PWA_ROOT = process.env.XIBO_PWA_ROOT || resolve(SDK_ROOT, 'packages/pwa');
const ELECTRON_ROOT = process.env.XIBO_ELECTRON_ROOT || resolve(SDK_ROOT, '../xiboplayer-electron');
const CHROMIUM_ROOT = process.env.XIBO_CHROMIUM_ROOT || resolve(SDK_ROOT, '../xiboplayer-chromium');

async function safeRead(path) {
  try { return await readFile(path, 'utf-8'); } catch { return null; }
}

function extractHeadings(content) {
  const headings = [];
  for (const line of content.split('\n')) {
    const m = line.match(/^(#{1,6})\s+(.+)$/);
    if (m) headings.push({ level: m[1].length, text: m[2].trim() });
  }
  return headings;
}

function extractExports(content) {
  const exports = [];
  for (const line of content.split('\n')) {
    const m = line.match(/export\s+(?:default\s+)?(?:class|function|const|let)\s+(\w+)/);
    if (m) exports.push(m[1]);
    const reExport = line.match(/export\s+\{([^}]+)\}/);
    if (reExport) {
      exports.push(...reExport[1].split(',').map(s => s.trim().split(/\s+as\s+/).pop().trim()));
    }
  }
  return [...new Set(exports)];
}

function countJSDoc(content) {
  return (content.match(/\/\*\*/g) || []).length;
}

async function buildIndex() {
  console.log('Building XiboPlayer documentation index...');

  const index = {
    version: '1.0.0',
    updated: new Date().toISOString(),
    statistics: { packages: 0, sourceFiles: 0, symbols: 0, readmes: 0, players: 0 },
    packages: [],
    players: [],
    readmes: [],
  };

  // SDK packages
  console.log('Indexing SDK packages...');
  const pkgDirs = await glob('packages/*/', { cwd: SDK_ROOT });
  for (const dir of pkgDirs) {
    const pkgPath = join(SDK_ROOT, dir);
    const pkgJsonStr = await safeRead(join(pkgPath, 'package.json'));
    if (!pkgJsonStr) continue;

    const pkg = JSON.parse(pkgJsonStr);
    const pkgName = dir.replace('packages/', '').replace('/', '');
    const readme = await safeRead(join(pkgPath, 'README.md'));

    // Count source stats
    const srcFiles = await glob('src/**/*.{js,ts}', { cwd: pkgPath, ignore: ['**/*.test.*'] });
    let totalLines = 0, totalJSDoc = 0, allExports = [];
    for (const f of srcFiles) {
      const content = await safeRead(join(pkgPath, f));
      if (!content) continue;
      totalLines += content.split('\n').length;
      totalJSDoc += countJSDoc(content);
      allExports.push(...extractExports(content));
    }

    index.packages.push({
      name: pkg.name || `@xiboplayer/${pkgName}`,
      shortName: pkgName,
      version: pkg.version,
      description: pkg.description || '',
      dependencies: Object.keys(pkg.dependencies || {}),
      sourceFiles: srcFiles.length,
      sourceLines: totalLines,
      jsdocCount: totalJSDoc,
      exports: [...new Set(allExports)],
      hasReadme: !!readme,
      readmeHeadings: readme ? extractHeadings(readme) : [],
    });

    if (readme) {
      index.readmes.push({ path: `packages/${pkgName}/README.md`, headings: extractHeadings(readme), size: readme.length });
    }

    index.statistics.packages++;
    index.statistics.sourceFiles += srcFiles.length;
    index.statistics.symbols += allExports.length;
  }

  // Root README
  const rootReadme = await safeRead(join(SDK_ROOT, 'README.md'));
  if (rootReadme) {
    index.readmes.push({ path: 'README.md', headings: extractHeadings(rootReadme), size: rootReadme.length });
    index.statistics.readmes++;
  }

  // Player repos
  console.log('Indexing player repos...');
  const players = [
    { name: 'xiboplayer-pwa', root: PWA_ROOT, files: ['src/main.ts', 'public/sw-pwa.js'],
      sdkPackages: ['core', 'renderer', 'schedule', 'xmds', 'xmr', 'cache', 'stats', 'settings', 'utils'] },
    { name: 'xiboplayer-electron', root: ELECTRON_ROOT, files: ['src/main.js', 'src/preload.js'],
      sdkPackages: ['proxy'] },
    { name: 'xiboplayer-chromium', root: CHROMIUM_ROOT, files: ['server/server.js'],
      sdkPackages: ['proxy'] },
  ];

  for (const player of players) {
    const readme = await safeRead(join(player.root, 'README.md'));
    let totalLines = 0;
    for (const f of player.files) {
      const content = await safeRead(join(player.root, f));
      if (content) totalLines += content.split('\n').length;
    }

    index.players.push({
      name: player.name,
      sdkPackages: player.sdkPackages,
      sourceFiles: player.files,
      sourceLines: totalLines,
      hasReadme: !!readme,
    });

    if (readme) {
      index.readmes.push({ path: `${player.name}/README.md`, headings: extractHeadings(readme), size: readme.length });
    }

    index.statistics.players++;
    index.statistics.readmes++;
  }

  // Write
  const outPath = join(__dirname, 'docs-index.json');
  await writeFile(outPath, JSON.stringify(index, null, 2));

  console.log('\nIndex built:');
  console.log(`  Packages: ${index.statistics.packages}`);
  console.log(`  Source files: ${index.statistics.sourceFiles}`);
  console.log(`  Exported symbols: ${index.statistics.symbols}`);
  console.log(`  READMEs: ${index.readmes.length}`);
  console.log(`  Players: ${index.statistics.players}`);
  console.log(`  Saved to: ${outPath}`);
}

buildIndex().catch(error => {
  console.error('Indexing failed:', error);
  process.exit(1);
});
