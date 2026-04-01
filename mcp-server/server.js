#!/usr/bin/env node

/**
 * XiboPlayer SDK & Players MCP Server
 *
 * Provides RAG access to SDK packages, player source, JSDoc symbols,
 * and events across the xiboplayer ecosystem.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFile } from 'fs/promises';
import { join, dirname, resolve, basename } from 'path';
import { fileURLToPath } from 'url';
import { glob } from 'glob';
import { CICD_TOOLS } from './tools/cicd.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SDK_ROOT = resolve(__dirname, '..');

// Sibling repos (configurable via env)
const PWA_ROOT = process.env.XIBO_PWA_ROOT || resolve(SDK_ROOT, 'packages/pwa');
const ELECTRON_ROOT = process.env.XIBO_ELECTRON_ROOT || resolve(SDK_ROOT, '../xiboplayer-electron');
const CHROMIUM_ROOT = process.env.XIBO_CHROMIUM_ROOT || resolve(SDK_ROOT, '../xiboplayer-chromium');
const KIOSK_ROOT = process.env.XIBO_KIOSK_ROOT || resolve(SDK_ROOT, '../xiboplayer-kiosk');
const AI_ROOT = process.env.XIBO_AI_ROOT || resolve(SDK_ROOT, '../xiboplayer-ai');
const ANSIBLE_ROOT = process.env.XIBO_ANSIBLE_ROOT || resolve(SDK_ROOT, '../../tecman_ansible');

let documentIndex = [];
let packageIndex = [];
let symbolIndex = [];

// ── Indexing ──────────────────────────────────────────────

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

/**
 * Extract exported symbols from a JS/TS source file.
 * Finds: export class X, export function X, export const X,
 *        class X (default), emit('event-name'
 */
function extractSymbols(content, filePath, packageName) {
  const symbols = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Classes
    const classMatch = line.match(/(?:export\s+)?class\s+(\w+)/);
    if (classMatch) {
      const jsdoc = extractJSDocAbove(lines, i);
      symbols.push({
        name: classMatch[1], type: 'class', package: packageName,
        file: filePath, line: i + 1, jsdoc,
      });
    }

    // Functions
    const funcMatch = line.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
    if (funcMatch && !classMatch) {
      const jsdoc = extractJSDocAbove(lines, i);
      symbols.push({
        name: funcMatch[1], type: 'function', package: packageName,
        file: filePath, line: i + 1, jsdoc,
      });
    }

    // Exported constants (non-trivial)
    const constMatch = line.match(/export\s+(?:const|let)\s+(\w+)\s*=/);
    if (constMatch) {
      symbols.push({
        name: constMatch[1], type: 'const', package: packageName,
        file: filePath, line: i + 1, jsdoc: extractJSDocAbove(lines, i),
      });
    }

    // Events: emit('name' or emit("name"
    const emitMatch = line.match(/\.emit\(\s*['"]([^'"]+)['"]/);
    if (emitMatch) {
      symbols.push({
        name: emitMatch[1], type: 'event', package: packageName,
        file: filePath, line: i + 1,
        jsdoc: extractJSDocAbove(lines, i) || line.trim(),
      });
    }
  }
  return symbols;
}

function extractJSDocAbove(lines, lineIndex) {
  // Walk backwards from lineIndex to find a /** ... */ block
  let end = lineIndex - 1;
  while (end >= 0 && lines[end].trim() === '') end--;
  if (end < 0 || !lines[end].trim().endsWith('*/')) return '';

  let start = end;
  while (start >= 0 && !lines[start].trim().startsWith('/**')) start--;
  if (start < 0) return '';

  return lines.slice(start, end + 1).map(l => l.trim()).join('\n');
}

async function indexSDKPackages() {
  const pkgDirs = await glob('packages/*/', { cwd: SDK_ROOT });

  for (const dir of pkgDirs) {
    const pkgPath = join(SDK_ROOT, dir);
    const pkgJsonStr = await safeRead(join(pkgPath, 'package.json'));
    if (!pkgJsonStr) continue;

    const pkg = JSON.parse(pkgJsonStr);
    const readme = await safeRead(join(pkgPath, 'README.md'));
    const pkgName = dir.replace('packages/', '').replace('/', '');

    // Package metadata
    packageIndex.push({
      name: pkg.name || `@xiboplayer/${pkgName}`,
      shortName: pkgName,
      version: pkg.version,
      description: pkg.description || '',
      dependencies: Object.keys(pkg.dependencies || {}),
      exports: pkg.exports ? Object.keys(pkg.exports) : [],
      readme: readme || '',
    });

    // Index README as document
    if (readme) {
      documentIndex.push({
        type: 'readme', path: `packages/${pkgName}/README.md`,
        content: readme, headings: extractHeadings(readme),
        package: pkgName,
      });
    }

    // Index source files for symbols
    const srcFiles = await glob('src/**/*.{js,ts}', { cwd: pkgPath, ignore: ['**/*.test.*', '**/*.spec.*'] });
    for (const srcFile of srcFiles) {
      const content = await safeRead(join(pkgPath, srcFile));
      if (!content) continue;

      const relPath = `packages/${pkgName}/${srcFile}`;
      documentIndex.push({
        type: 'source', path: relPath, content, package: pkgName,
        headings: [], // source files don't have markdown headings
      });

      const syms = extractSymbols(content, relPath, pkgName);
      symbolIndex.push(...syms);
    }
  }
}

async function indexPlayerRepo(repoRoot, playerName, sourceFiles) {
  const readme = await safeRead(join(repoRoot, 'README.md'));
  if (readme) {
    documentIndex.push({
      type: 'readme', path: `${playerName}/README.md`,
      content: readme, headings: extractHeadings(readme),
      package: playerName,
    });
  }

  for (const srcFile of sourceFiles) {
    const content = await safeRead(join(repoRoot, srcFile));
    if (!content) continue;

    const relPath = `${playerName}/${srcFile}`;
    documentIndex.push({
      type: 'source', path: relPath, content, package: playerName,
      headings: [],
    });

    const syms = extractSymbols(content, relPath, playerName);
    symbolIndex.push(...syms);
  }
}

async function loadIndex() {
  documentIndex = [];
  packageIndex = [];
  symbolIndex = [];

  // SDK root README
  const rootReadme = await safeRead(join(SDK_ROOT, 'README.md'));
  if (rootReadme) {
    documentIndex.push({
      type: 'readme', path: 'README.md', content: rootReadme,
      headings: extractHeadings(rootReadme), package: 'sdk',
    });
  }

  await indexSDKPackages();

  // Player repos
  await indexPlayerRepo(PWA_ROOT, 'pwa', [
    'src/main.ts', 'public/sw-pwa.js',
  ]);
  await indexPlayerRepo(ELECTRON_ROOT, 'xiboplayer-electron', [
    'src/main.js', 'src/preload.js',
  ]);
  await indexPlayerRepo(CHROMIUM_ROOT, 'xiboplayer-chromium', [
    'server/server.js',
  ]);

  // Kiosk scripts
  await indexPlayerRepo(KIOSK_ROOT, 'xiboplayer-kiosk', [
    'kiosk/gnome-kiosk-script.xibo.sh',
    'kiosk/gnome-kiosk-script.xibo-init.sh',
    'kiosk/xibo-show-ip.sh',
    'kiosk/xibo-show-cms.sh',
    'rpm/xiboplayer-kiosk.spec',
  ]);

  // AI service
  await indexPlayerRepo(AI_ROOT, 'xiboplayer-ai', [
    'src/agent.js', 'src/app.js', 'src/mcp.js', 'src/tools.js', 'src/server.js',
  ]);

  // Ansible playbooks (as documents, not source)
  const ansibleReadme = await safeRead(join(ANSIBLE_ROOT, 'README.md'));
  if (ansibleReadme) {
    documentIndex.push({
      type: 'readme', path: 'tecman_ansible/README.md',
      content: ansibleReadme, headings: extractHeadings(ansibleReadme),
      package: 'ansible',
    });
  }
  for (const playbook of ['install.yml', 'deploy-pwa.yml', 'deploy-xibo-cms.yml', 'deploy-xibo-ai.yml',
    'release-xiboplayer.yml', 'swag-configure.yml', 'publish-npm.yml']) {
    const content = await safeRead(join(ANSIBLE_ROOT, 'playbooks/services', playbook));
    if (content) {
      documentIndex.push({
        type: 'source', path: `tecman_ansible/playbooks/services/${playbook}`,
        content, package: 'ansible', headings: [],
      });
    }
  }

  // Deduplicate events by name
  const seen = new Set();
  symbolIndex = symbolIndex.filter(s => {
    if (s.type !== 'event') return true;
    const key = `${s.name}@${s.package}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.error(`Indexed: ${documentIndex.length} docs, ${packageIndex.length} packages, ${symbolIndex.length} symbols`);
}

// ── Search ───────────────────────────────────────────────

function searchDocuments(query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const results = [];

  for (const doc of documentIndex) {
    let score = 0;
    const text = (doc.content || '').toLowerCase();

    // Each word that matches adds to score; all must match for base score
    const matchCount = words.filter(w => text.includes(w)).length;
    if (matchCount === words.length) score += 10 + matchCount * 2;
    else if (matchCount > 0) score += matchCount * 2;

    if (doc.headings) {
      for (const h of doc.headings) {
        const ht = h.text.toLowerCase();
        const headingMatches = words.filter(w => ht.includes(w)).length;
        if (headingMatches > 0) score += (20 - h.level * 2) * headingMatches / words.length;
      }
    }

    // Boost package name matches
    if (doc.package) {
      const pn = doc.package.toLowerCase();
      for (const w of words) {
        if (pn.includes(w)) score += 15;
      }
    }

    if (score > 0) results.push({ doc, score });
  }

  // Also search symbols
  for (const sym of symbolIndex) {
    const sn = sym.name.toLowerCase();
    const symMatches = words.filter(w => sn.includes(w)).length;
    if (symMatches > 0) {
      results.push({
        doc: {
          type: 'symbol', path: sym.file, package: sym.package,
          content: `${sym.type} ${sym.name} (line ${sym.line})\n${sym.jsdoc || ''}`,
          headings: [],
        },
        score: sn === words.join(' ') ? 30 : 8 + symMatches * 4,
      });
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(r => r.doc);
}

function formatSearchResults(results) {
  return results.map(doc => {
    let out = `**${doc.path}** (${doc.type}${doc.package ? ` · ${doc.package}` : ''})\n`;
    if (doc.headings?.length > 0) {
      out += doc.headings.slice(0, 5).map(h =>
        `${'  '.repeat(h.level - 1)}- ${h.text}`
      ).join('\n') + '\n';
    }
    if (doc.type === 'symbol') {
      out += doc.content + '\n';
    }
    return out;
  }).join('\n---\n\n');
}

// ── Tool implementations ─────────────────────────────────

function getPackageInfo(name) {
  const n = name.replace('@xiboplayer/', '');
  return packageIndex.find(p => p.shortName === n || p.name === name) || null;
}

function listPackages() {
  return packageIndex.map(p => ({
    name: p.name, version: p.version, description: p.description,
    deps: p.dependencies.length,
  }));
}

function getSymbolInfo(name) {
  const q = name.toLowerCase();
  return symbolIndex.filter(s =>
    s.name.toLowerCase() === q || s.name.toLowerCase().includes(q)
  ).slice(0, 10);
}

// ── MCP Server ───────────────────────────────────────────

async function main() {
  console.error('Starting XiboPlayer MCP Server...');
  await loadIndex();

  const server = new Server(
    { name: 'xiboplayer-docs', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'query_docs',
        description: 'Search across all XiboPlayer SDK packages, player source code, and documentation. Returns matching docs, symbols, and events.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query (e.g., "video rendering", "download-request event", "PlayerCore")',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_package_info',
        description: 'Get detailed information about a specific @xiboplayer/* SDK package including version, exports, dependencies, and README.',
        inputSchema: {
          type: 'object',
          properties: {
            package: {
              type: 'string',
              description: 'Package name (e.g., "core", "@xiboplayer/renderer", "proxy")',
            },
          },
          required: ['package'],
        },
      },
      {
        name: 'list_packages',
        description: 'List all @xiboplayer/* SDK packages with version and description.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get_symbol_info',
        description: 'Find a class, function, event, or constant by name across the SDK and players. Returns file path, line number, and JSDoc.',
        inputSchema: {
          type: 'object',
          properties: {
            symbol: {
              type: 'string',
              description: 'Symbol name (e.g., "PlayerCore", "RendererLite", "download-request", "fetchWithRetry")',
            },
          },
          required: ['symbol'],
        },
      },
      // CI/CD tools (workflow runs, releases, version drift, PRs)
      ...CICD_TOOLS.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case 'query_docs': {
        const results = searchDocuments(args.query);
        return {
          content: [{
            type: 'text',
            text: results.length > 0
              ? formatSearchResults(results)
              : `No results for: ${args.query}`,
          }],
        };
      }

      case 'get_package_info': {
        const pkg = getPackageInfo(args.package);
        if (!pkg) {
          return { content: [{ type: 'text', text: `Package not found: ${args.package}\n\nAvailable: ${packageIndex.map(p => p.shortName).join(', ')}` }] };
        }
        const symbols = symbolIndex.filter(s => s.package === pkg.shortName);
        const classes = symbols.filter(s => s.type === 'class').map(s => s.name);
        const functions = symbols.filter(s => s.type === 'function').map(s => s.name);
        const events = symbols.filter(s => s.type === 'event').map(s => s.name);

        let text = `# ${pkg.name} v${pkg.version}\n\n`;
        text += `${pkg.description}\n\n`;
        text += `**Dependencies:** ${pkg.dependencies.join(', ') || 'none'}\n`;
        text += `**Exports:** ${pkg.exports.join(', ') || 'default'}\n\n`;
        if (classes.length) text += `**Classes:** ${classes.join(', ')}\n`;
        if (functions.length) text += `**Functions:** ${functions.join(', ')}\n`;
        if (events.length) text += `**Events:** ${events.join(', ')}\n`;
        text += `\n---\n\n${pkg.readme}`;
        return { content: [{ type: 'text', text }] };
      }

      case 'list_packages': {
        const pkgs = listPackages();
        let text = '| Package | Version | Description | Deps |\n|---------|---------|-------------|------|\n';
        for (const p of pkgs) {
          text += `| ${p.name} | ${p.version} | ${p.description} | ${p.deps} |\n`;
        }
        return { content: [{ type: 'text', text }] };
      }

      case 'get_symbol_info': {
        const syms = getSymbolInfo(args.symbol);
        if (syms.length === 0) {
          return { content: [{ type: 'text', text: `Symbol not found: ${args.symbol}` }] };
        }
        const text = syms.map(s => {
          let out = `### ${s.type} \`${s.name}\`\n`;
          out += `**Package:** ${s.package} | **File:** ${s.file}:${s.line}\n`;
          if (s.jsdoc) out += `\n\`\`\`\n${s.jsdoc}\n\`\`\`\n`;
          return out;
        }).join('\n---\n\n');
        return { content: [{ type: 'text', text }] };
      }

      default: {
        // Check CI/CD tools
        const cicdTool = CICD_TOOLS.find(t => t.name === name);
        if (cicdTool) {
          const text = await cicdTool.handler(args || {});
          return { content: [{ type: 'text', text }] };
        }
        throw new Error(`Unknown tool: ${name}`);
      }
    }
  });

  // Resources: expose READMEs
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: documentIndex
      .filter(d => d.type === 'readme')
      .map(d => ({
        uri: `xiboplayer://${d.path}`,
        name: d.path,
        mimeType: 'text/markdown',
        description: d.headings?.[0]?.text || d.package,
      })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const path = uri.replace('xiboplayer://', '');
    const doc = documentIndex.find(d => d.path === path);
    if (!doc) throw new Error(`Resource not found: ${path}`);
    return {
      contents: [{ uri, mimeType: 'text/markdown', text: doc.content }],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('XiboPlayer MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
