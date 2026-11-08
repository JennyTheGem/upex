/**
 * update.js -- Daily background check of the npm registry for a newer upex.
 * Run directly (spawned detached), it fetches the latest version into the cache.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { UPEX_DIR } from './store.js';

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

async function fetchLatest() {
  const res = await fetch(`https://registry.npmjs.org/${PKG}/latest`, { signal: AbortSignal.timeout(10000) });
  const { version } = await res.json();
  if (typeof version === 'string') writeCache({ ...readCache(), latest: version });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) fetchLatest().catch(() => {});
