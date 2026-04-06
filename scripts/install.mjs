#!/usr/bin/env node
// AnyReach installer — sets up skill for all supported agents
// Usage: node scripts/install.mjs [--uninstall]
//
// Creates symlinks so one copy of anyreach is visible to:
//   - Claude Code: ~/.claude/skills/anyreach
//   - Codex:       ~/.agents/skills/anyreach
//   - OpenClaw:    ~/.agents/skills/anyreach (shared with Codex)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();
const SKILL_NAME = 'anyreach';

const targets = [
  { agent: 'Claude Code', dir: path.join(HOME, '.claude', 'skills', SKILL_NAME) },
  { agent: 'Codex + OpenClaw', dir: path.join(HOME, '.agents', 'skills', SKILL_NAME) },
];

const uninstall = process.argv.includes('--uninstall');

for (const { agent, dir } of targets) {
  if (uninstall) {
    // remove symlink or directory
    try {
      const stat = fs.lstatSync(dir);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(dir);
        console.log(`  removed: ${dir} (${agent})`);
      } else {
        console.log(`  skipped: ${dir} is not a symlink (${agent})`);
      }
    } catch {
      console.log(`  skipped: ${dir} does not exist (${agent})`);
    }
    continue;
  }

  // check if already correct
  try {
    const existing = fs.readlinkSync(dir);
    if (existing === ROOT) {
      console.log(`  ok: ${dir} → ${ROOT} (${agent})`);
      continue;
    }
    // symlink exists but points elsewhere
    console.log(`  exists: ${dir} → ${existing} (${agent}), skipping`);
    continue;
  } catch { /* not a symlink or doesn't exist */ }

  // check if non-symlink directory exists
  try {
    fs.statSync(dir);
    console.log(`  exists: ${dir} is not a symlink (${agent}), skipping`);
    continue;
  } catch { /* doesn't exist, proceed */ }

  // create parent dirs + symlink
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.symlinkSync(ROOT, dir);
  console.log(`  linked: ${dir} → ${ROOT} (${agent})`);
}

if (!uninstall) {
  console.log('\nDone. AnyReach is now available to all agents.');
  console.log('Run check-deps to verify: node scripts/check-deps.mjs');
}
