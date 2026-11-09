/**
 * update.js -- Daily background check of the npm registry for a newer upex.
 * Run directly (spawned detached), it fetches the latest version into the cache.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { UPEX_DIR } from './store.js';
import { error } from './ui.js';

export const PKG = '@uplift-beyond/upex';
export const { version: VERSION } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
const CACHE = path.join(UPEX_DIR, 'update.json');
const DAY = 24 * 60 * 60 * 1000;

const readCache = () => { try { return JSON.parse(fs.readFileSync(CACHE, 'utf-8')); } catch { return {}; } };
const writeCache = (c) => { try { fs.mkdirSync(UPEX_DIR, { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify(c)); } catch {} };

// Is version a newer than b? Plain x.y.z, a pre-release tag is ignored.
export function isNewer(a, b) {
  const p = v => String(v).split('-')[0].split('.').map(Number);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

// The notice line from the cache, or ''. Starts a background check when the cache is a day old. Never throws.
export function updateNotice(now = Date.now()) {
  try {
    const cache = readCache();
    // abs: a clock set back must not stop checks until it catches up.
    if (!(Math.abs(now - cache.checked) < DAY)) {
      // Stamp first, so commands run meanwhile (or offline) don't spawn another check.
      writeCache({ ...cache, checked: now });
      // cwd: don't hold the user's folder (Windows can't delete it meanwhile). A spawn error is emitted async, ignore it.
      spawn(process.execPath, [fileURLToPath(import.meta.url)], { cwd: UPEX_DIR, detached: true, stdio: 'ignore', windowsHide: true })
        .on('error', () => {}).unref();
    }
    return isNewer(cache.latest, VERSION) ? `update available ${VERSION} -> ${cache.latest}, run npm i -g ${PKG}@latest` : '';
  } catch {
    return '';
  }
}

// Newest version seen by a check, or undefined.
export const cachedLatest = () => readCache().latest;

// Fetches the latest version from npm into the cache and returns it. Throws when npm can't be reached.
export async function fetchLatest(now = Date.now()) {
  const res = await fetch(`https://registry.npmjs.org/${PKG}/latest`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`npm answered ${res.status}`);
  const { version } = await res.json();
  if (typeof version !== 'string') throw new Error('npm sent no version');
  writeCache({ ...readCache(), latest: version, checked: now });
  return version;
}

// The Settings line for a version: newer one out, or up to date.
export const updateText = latest => (isNewer(latest, VERSION) ? `v${latest} out, Enter updates` : `v${VERSION} is the latest`);

// npm i -g of the latest upex (Settings > Updates). npm's output goes to stderr, stdout stays clean for upex pick.
export async function runUpdate() {
  // shell on Windows: npm is npm.cmd. The args are fixed, nothing to escape.
  const code = await new Promise(resolve => spawn('npm', ['i', '-g', `${PKG}@latest`], { stdio: ['inherit', 2, 2], shell: process.platform === 'win32' })
    .on('error', () => resolve(1)).on('close', c => resolve(c ?? 1)));
  if (code) {
    error(`update failed, try npm i -g ${PKG}@latest yourself`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) fetchLatest().catch(() => {});
