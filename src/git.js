/**
 * git.js -- Cheap git status for a folder shortcut.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Return { branch, dirty } for a git repo root, or null if it isn't one.
 * Gated on a `.git` entry so we never spawn git for plain folders.
 */
export function gitStatus(dir) {
  try {
    if (!dir || !fs.existsSync(path.join(dir, '.git'))) return null;
    const run = (cmd) => execSync(cmd, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const branch = run('git rev-parse --abbrev-ref HEAD').trim();
    const dirty = run('git status --porcelain').trim().length > 0;
    return { branch: branch || 'HEAD', dirty };
  } catch {
    return null;
  }
}
