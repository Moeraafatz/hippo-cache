import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '../..');
const SKILL_SRC = path.join(PACKAGE_ROOT, 'skills/hippo-cache/SKILL.md');

function readSkillSource() {
  return fs.readFileSync(SKILL_SRC, 'utf8');
}

function writeSafeFile(targetPath, content) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, 'utf8');
  return targetPath;
}

function mergeJsonMcp(targetPath, serverEntry) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  let existing = {};
  if (fs.existsSync(targetPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    } catch {
      existing = {};
    }
  }
  existing.mcpServers = existing.mcpServers || {};
  existing.mcpServers['hippo-cache'] = serverEntry;
  fs.writeFileSync(targetPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  return targetPath;
}

function buildCursorRule(skillBody) {
  const stripped = skillBody.replace(/^---[\s\S]*?---\s*/, '');
  return `---
description: Token-frugal cognitive memory rules via hippo-cache MCP (ACT-R decay, HippoRAG PPR, bi-temporal truth, submodular knapsack).
alwaysApply: true
---

${stripped}`;
}

function buildMcpEntry(dbPath, namespace, binPath) {
  if (binPath) {
    return {
      command: 'node',
      args: ['--no-warnings=ExperimentalWarning', binPath, 'mcp', '--db', dbPath, '--ns', namespace]
    };
  }
  return {
    command: 'npx',
    args: ['-y', 'hippo-cache', 'mcp', '--db', dbPath, '--ns', namespace]
  };
}

/**
 * Installs portable Skills (SKILL.md / .mdc), MCP configs, and optional hooks
 * for Claude Code, Codex CLI, Cursor, Windsurf, and Antigravity.
 */
export function installAgentAdapters({
  targetDir = process.cwd(),
  targets = ['all'],
  dbPath = '.hippo-cache/memory.db',
  namespace = 'default',
  useLocalBin = true
} = {}) {
  const skillBody = readSkillSource();
  const binPath = useLocalBin ? path.join(PACKAGE_ROOT, 'bin/hippo-cache.js') : null;
  const mcpEntry = buildMcpEntry(dbPath, namespace, binPath);
  const selected = new Set(targets.includes('all') ? ['claude', 'codex', 'cursor', 'windsurf', 'antigravity'] : targets);
  const created = [];

  if (selected.has('claude')) {
    created.push(writeSafeFile(path.join(targetDir, '.claude/skills/hippo-cache/SKILL.md'), skillBody));
    created.push(mergeJsonMcp(path.join(targetDir, '.mcp.json'), mcpEntry));
  }

  if (selected.has('codex')) {
    created.push(writeSafeFile(path.join(targetDir, '.codex/skills/hippo-cache/SKILL.md'), skillBody));
    const tomlPath = path.join(targetDir, '.codex/hippo-cache.config.toml');
    const cmdStr = mcpEntry.command;
    const argsStr = JSON.stringify(mcpEntry.args);
    const tomlBlock = `# Append to ~/.codex/config.toml or project .codex/config.toml
[mcp_servers.hippo-cache]
command = "${cmdStr}"
args = ${argsStr}
`;
    created.push(writeSafeFile(tomlPath, tomlBlock));
  }

  if (selected.has('cursor')) {
    created.push(writeSafeFile(path.join(targetDir, '.cursor/rules/hippo-cache.mdc'), buildCursorRule(skillBody)));
    created.push(mergeJsonMcp(path.join(targetDir, '.cursor/mcp.json'), mcpEntry));
  }

  if (selected.has('windsurf')) {
    created.push(writeSafeFile(path.join(targetDir, '.windsurf/rules/hippo-cache.md'), skillBody));
  }

  if (selected.has('antigravity')) {
    created.push(writeSafeFile(path.join(targetDir, '.agent/skills/hippo-cache/SKILL.md'), skillBody));
  }

  return {
    targets: [...selected],
    files: created,
    mcpEntry
  };
}
