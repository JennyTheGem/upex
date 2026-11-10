/**
 * size.js -- Folder size and file count for the selector's detail pane, off the render path.
 * Windows: robocopy /L reads sizes from the directory listing (Node would open every file to stat it).
 * macOS / Linux: du -sk and find | wc -l.
 */

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const TTL = 60000; // a cached size older than this is looked up again when shown
const WAIT = 250; // ms on a row before its lookup starts, so scrolling spawns nothing
const LIMIT = 60000; // a walk running longer is killed and shows no size
const cache = new Map(); // dir -> { at, info }
let job = null; // { dir, timer, kill }

// robocopy's summary: rows of 6 numbers (dirs, files, bytes, ...) under labels in the OS language.
export function parseRobocopy(text) {
  const rows = String(text ?? '').split(/\r?\n/).map(l => l.match(/^\s*[^:\d]+:\s+(\d+)(?:\s+\d+){5}\s*$/)?.[1]).filter(Boolean);
  return rows.length >= 3 ? { files: Number(rows[1]), bytes: Number(rows[2]) } : null;
}

// `du -sk dir; find dir -type f | wc -l`: KB on the first line, the file count on the last.
export function parseDu(text) {
  const lines = String(text ?? '').trim().split(/\r?\n/);
  const kb = lines[0]?.match(/^\d+/)?.[0];
  const files = lines.length > 1 ? lines.at(-1).trim().match(/^\d+$/)?.[0] : null;
  return kb && files ? { files: Number(files), bytes: Number(kb) * 1024 } : null;
}

// 835 MB, 3.2 GB, 12 KB.
export function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  for (; n >= 1024 && i < units.length - 1; i++) n /= 1024;
  return `${i && n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

// The command that sizes `dir` on `platform`: [file, args, parse].
export function sizeCommand(dir, platform = os.platform()) {
  if (platform === 'win32') {
    // A trailing \ would escape the closing quote; a drive root keeps one as "C:\.".
    const d = path.win32.resolve(dir).replace(/\\$/, '\\.');
    return ['robocopy', [d, 'NUL', '/L', '/E', '/NFL', '/NDL', '/NJH', '/BYTES', '/XJ', '/R:0', '/W:0', '/MT:16'], parseRobocopy];
  }
  // -H: a symlinked folder is sized, not the link.
  return ['sh', ['-c', 'du -skH -- "$1" 2>/dev/null; find -H "$1" -type f 2>/dev/null | wc -l', 'sh', dir], parseDu];
}

function start(dir, onDone) {
  const [file, args, parse] = sizeCommand(dir);
  const win = os.platform() === 'win32';
  const self = job = { dir, timer: null, kill: () => {} };
  self.timer = setTimeout(() => {
    // Detached elsewhere: sh, du and find get their own process group, so one kill stops all three
    // (execFile drops `detached`, hence spawn).
    const child = spawn(file, args, { windowsHide: true, detached: !win, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', b => { out += b; });
    // robocopy exits non-zero on success too (and on a denied folder), so the exit code is ignored.
    const done = () => {
      clearTimeout(self.timer);
      if (job !== self) return;
      job = null;
      // A walk that hit LIMIT would hit it again: not retried this session.
      cache.set(dir, self.slow ? { at: Infinity, info: null } : { at: Date.now(), info: parse(out) });
      onDone?.();
    };
    child.on('error', done).on('close', done);
    self.kill = () => { try { process.kill(win ? child.pid : -child.pid); } catch { /* already gone */ } };
    self.timer = setTimeout(() => { self.slow = true; self.kill(); }, LIMIT);
  }, WAIT);
}

// Cached { files, bytes } of `dir`, or null (not looked up yet, or failed). Stale or missing starts a lookup,
// dropping one for another folder; `onDone` runs when it lands, so the caller redraws and asks again.
export function sizeOf(dir, onDone) {
  const hit = cache.get(dir);
  if ((!hit || Date.now() - hit.at > TTL) && job?.dir !== dir) {
    stopSize();
    start(dir, onDone);
  }
  return hit?.info ?? null;
}

// Selector closing: drop a waiting or running lookup so it can't hold the process open.
export function stopSize() {
  if (!job) return;
  clearTimeout(job.timer);
  job.kill();
  job = null;
}
