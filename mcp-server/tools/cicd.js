// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * CI/CD tools for the XiboPlayer MCP server.
 * Wraps `gh` CLI to query workflow runs, releases, and version info.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);

const REPOS = [
  'xibo-players/xiboplayer',
  'xibo-players/xiboplayer-electron',
  'xibo-players/xiboplayer-chromium',
  'xibo-players/xiboplayer-kiosk',
  'xibo-players/xiboplayer-ai',
  'xibo-players/xiboplayer-android',
  'xibo-players/xiboplayer-webos',
  'xibo-players/xibo-players.github.io',
  'xibo-players/arexibo',
  'xibo-players/.github',
];

async function gh(args) {
  try {
    const { stdout } = await execFileP('gh', args, { timeout: 15000 });
    return stdout.trim();
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

/** List recent workflow runs across all repos or a specific one */
export async function listWorkflowRuns(repo, limit = 5) {
  const repos = repo ? [repo] : REPOS;
  const results = [];

  for (const r of repos) {
    const raw = await gh([
      'run', 'list', '--repo', r,
      '--limit', String(limit),
      '--json', 'databaseId,name,status,conclusion,headBranch,createdAt,url',
    ]);
    try {
      const runs = JSON.parse(raw);
      if (runs.length > 0) {
        results.push({ repo: r, runs });
      }
    } catch (_) {
      results.push({ repo: r, error: raw });
    }
  }
  return results;
}

/** Get the latest release for each repo */
export async function listLatestReleases(repo) {
  const repos = repo ? [repo] : REPOS;
  const results = [];

  for (const r of repos) {
    const raw = await gh([
      'release', 'view', '--repo', r,
      '--json', 'tagName,name,publishedAt,url',
    ]);
    try {
      const rel = JSON.parse(raw);
      results.push({ repo: r, ...rel });
    } catch (_) {
      // No release or error
      if (!raw.includes('not found')) {
        results.push({ repo: r, error: raw });
      }
    }
  }
  return results;
}

/** Check version consistency: package.json/spec vs CI default-version */
export async function checkVersionDrift() {
  const drift = [];

  for (const r of REPOS) {
    // Get package.json version
    const pkgRaw = await gh([
      'api', `repos/${r}/contents/package.json`,
      '--jq', '.content',
    ]);
    let pkgVersion = null;
    try {
      const content = Buffer.from(pkgRaw, 'base64').toString('utf-8');
      pkgVersion = JSON.parse(content).version;
    } catch (_) {}

    // Get default-version from CI workflows
    const wfFiles = await gh([
      'api', `repos/${r}/contents/.github/workflows`,
      '--jq', '.[].name',
    ]);
    if (wfFiles.startsWith('Error')) continue;

    for (const wf of wfFiles.split('\n').filter(Boolean)) {
      const wfRaw = await gh([
        'api', `repos/${r}/contents/.github/workflows/${wf}`,
        '--jq', '.content',
      ]);
      try {
        const content = Buffer.from(wfRaw, 'base64').toString('utf-8');
        const matches = content.match(/default-version:\s*'([^']+)'/g);
        if (matches && pkgVersion) {
          for (const m of matches) {
            const ver = m.match(/default-version:\s*'([^']+)'/)[1];
            if (ver !== pkgVersion) {
              drift.push({
                repo: r,
                workflow: wf,
                defaultVersion: ver,
                packageVersion: pkgVersion,
              });
            }
          }
        }
      } catch (_) {}
    }
  }
  return drift;
}

/** Get open PRs across all repos */
export async function listOpenPRs(repo) {
  const repos = repo ? [repo] : REPOS;
  const results = [];

  for (const r of repos) {
    const raw = await gh([
      'pr', 'list', '--repo', r, '--state', 'open',
      '--json', 'number,title,author,createdAt,url,headRefName',
    ]);
    try {
      const prs = JSON.parse(raw);
      if (prs.length > 0) {
        results.push({ repo: r, prs });
      }
    } catch (_) {}
  }
  return results;
}

export const CICD_TOOLS = [
  {
    name: 'list_workflow_runs',
    description: 'List recent CI/CD workflow runs across xiboplayer repos. Shows status, conclusion, branch, and URL.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Specific repo (e.g., "xibo-players/xiboplayer"). Omit for all repos.' },
        limit: { type: 'number', description: 'Number of runs per repo (default: 5)' },
      },
    },
    handler: async (args) => {
      const results = await listWorkflowRuns(args.repo, args.limit || 5);
      return formatWorkflowRuns(results);
    },
  },
  {
    name: 'list_releases',
    description: 'List the latest release for each xiboplayer repo. Shows tag, name, date, and URL.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Specific repo. Omit for all repos.' },
      },
    },
    handler: async (args) => {
      const results = await listLatestReleases(args.repo);
      return formatReleases(results);
    },
  },
  {
    name: 'check_version_drift',
    description: 'Check all repos for version drift between package.json/spec and CI workflow default-version values.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const drift = await checkVersionDrift();
      if (drift.length === 0) return 'No version drift detected across all repos.';
      let text = `Found ${drift.length} version drift issue(s):\n\n`;
      for (const d of drift) {
        text += `- **${d.repo}** \`${d.workflow}\`: default-version \`${d.defaultVersion}\` != package.json \`${d.packageVersion}\`\n`;
      }
      return text;
    },
  },
  {
    name: 'list_open_prs',
    description: 'List all open pull requests across xiboplayer repos.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Specific repo. Omit for all repos.' },
      },
    },
    handler: async (args) => {
      const results = await listOpenPRs(args.repo);
      return formatPRs(results);
    },
  },
];

function formatWorkflowRuns(results) {
  if (results.length === 0) return 'No recent workflow runs found.';
  let text = '';
  for (const { repo, runs, error } of results) {
    text += `### ${repo}\n`;
    if (error) { text += `Error: ${error}\n\n`; continue; }
    text += '| Status | Workflow | Branch | Created |\n|--------|----------|--------|---------|\n';
    for (const r of runs) {
      const icon = r.conclusion === 'success' ? 'pass' : r.conclusion === 'failure' ? 'FAIL' : r.status;
      text += `| ${icon} | ${r.name} | ${r.headBranch} | ${r.createdAt?.slice(0, 10)} |\n`;
    }
    text += '\n';
  }
  return text;
}

function formatReleases(results) {
  if (results.length === 0) return 'No releases found.';
  let text = '| Repo | Tag | Published | URL |\n|------|-----|-----------|-----|\n';
  for (const r of results) {
    if (r.error) continue;
    text += `| ${r.repo} | ${r.tagName} | ${r.publishedAt?.slice(0, 10) || 'N/A'} | ${r.url || ''} |\n`;
  }
  return text;
}

function formatPRs(results) {
  if (results.length === 0) return 'No open PRs across any repo.';
  let text = '';
  for (const { repo, prs } of results) {
    text += `### ${repo}\n`;
    for (const pr of prs) {
      text += `- #${pr.number} **${pr.title}** (${pr.headRefName}) — ${pr.author?.login || 'unknown'}\n`;
    }
    text += '\n';
  }
  return text;
}
