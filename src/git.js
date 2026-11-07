/**
 * git.js -- Cheap git status for a folder shortcut.
 */

import { execSync, execFile, execFileSync } from 'node:child_process';
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
  // A host the URL parser rejects ("git@1.2.3.4.5:x"): null, never a throw.
  let href;
  try { href = new URL(`${base}/${repo}`).href; } catch { return null; }
  // launchUrl puts this inside "..." in a shell: no quote, $, backtick, backslash or bare %.
  return /["$`\\]|%(?![\da-f]{2})/i.test(href) ? null : href;
}

// Selector detail pane: a fuller status, run off the render path and cached per folder.
const TTL = 5000; // a cached status older than this is refreshed when shown again
const cache = new Map(); // dir -> { at, info }
let job = null; // the one running lookup: { ac }

// `git status --porcelain=v2 --branch`: branch, ahead/behind, changed (untracked included) file count.
export function parseStatus(text) {
  const out = { branch: '', ahead: 0, behind: 0, changed: 0 };
  for (const l of String(text).split('\n')) {
    if (l.startsWith('# branch.head ')) out.branch = l.slice(14).trim();
    else if (l.startsWith('# branch.ab ')) [out.ahead, out.behind] = l.slice(12).trim().split(' ').map(n => Math.abs(Number(n)) || 0);
    else if (l.trim() && !l.startsWith('#')) out.changed++;
  }
  return out;
}

// `git log -1 --format="%ct %s"`: commit time (ms) and subject. Empty repo: null.
export function parseLog(text) {
  const m = String(text ?? '').match(/^(\d+) ?(.*)/);
  return m ? { time: Number(m[1]) * 1000, subject: m[2].trim() } : null;
}

function start(dir, onDone) {
  const ac = new AbortController();
  job = { ac };
  // --no-optional-locks: never take the index lock another git (or agent) may want.
  const git = (...args) => new Promise(res => execFile('git', ['--no-optional-locks', '-C', dir, ...args],
    // No maxBuffer cap: thousands of changes would otherwise fail like "not a repo".
    { timeout: 4000, windowsHide: true, maxBuffer: Infinity, signal: ac.signal }, (err, out) => res(err ? null : out)));
  Promise.all([git('status', '--porcelain=v2', '--branch'), git('log', '-1', '--format=%ct %s'), git('remote', 'get-url', 'origin')])
    .then(([status, log, remote]) => {
      if (ac.signal.aborted) return;
      job = null;
      cache.set(dir, { at: Date.now(), info: status == null ? null : { ...parseStatus(status), last: parseLog(log), web: remote ? remoteWebUrl(remote) : null } });
      onDone?.();
    });
}

// Cached status of `dir` (null: not a repo, or not looked up yet). Stale or missing starts a lookup
// unless one is running; `onDone` runs when it lands, so the caller redraws and asks again.
export function gitOf(dir, onDone) {
  const hit = cache.get(dir);
  if (!job && (!hit || Date.now() - hit.at > TTL)) start(dir, onDone);
  return hit?.info ?? null;
}

// Selector closing: drop a running lookup so it can't hold the process open.
export function stopGit() {
  job?.ac.abort();
  job = null;
}
