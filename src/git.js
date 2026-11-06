/**
 * git.js -- Cheap git status for a folder shortcut.
 */

import { execSync, execFileSync } from 'node:child_process';
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

// origin's URL for the repo holding `dir`, or null (no repo, no origin, or no git).
export function gitRemote(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch {
    return null;
  }
}

// Browser URL for a remote: "git@github.com:me/x.git" -> "https://github.com/me/x". Null for local paths.
export function remoteWebUrl(remote) {
  const s = String(remote).trim();
  let base;
  let repo;
  // scp-like "user@host:path"; a 1-letter host is a Windows drive.
  const scp = s.match(/^(?:[^@/\\\s]+@)?([\w.-]{2,}):(?!\/\/)([^\\]+)$/);
  if (scp) {
    base = `https://${scp[1]}`;
    repo = scp[2];
  } else {
    let u;
    try { u = new URL(s); } catch { return null; }
    if (!/^(https?|ssh|git|git\+ssh):$/.test(u.protocol) || !u.hostname) return null;
    // Keep an http(s) port; an ssh port is not the web server's. Credentials are dropped.
    base = /^https?:$/.test(u.protocol) ? `${u.protocol}//${u.host}` : `https://${u.hostname}`;
    repo = u.pathname;
  }
  repo = repo.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (!repo) return null;
  const href = new URL(`${base}/${repo}`).href;
  // launchUrl puts this inside "..." in a shell: no quote, $, backtick, backslash or bare %.
  return /["$`\\]|%(?![\da-f]{2})/i.test(href) ? null : href;
}
