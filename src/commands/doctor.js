/**
 * doctor.js -- Check that upex is set up and healthy.
 * Usage: upex doctor
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import chalk from 'chalk';
import { loadLinks, loadConfig, loadWorkspaces, aliasClashes, linkIssues, LINKS_FILE } from '../store.js';
import { getAppMap, checkOpener, openerKey, APP_MAP } from '../launcher.js';
import { CMD_WRAPPER, findShimDir, rcFile } from './setup.js';
import { resolveTarget } from '../fuzzy.js';
import * as ui from '../ui.js';

const platform = os.platform();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const readText = (f) => { try { return fs.readFileSync(f, 'utf-8'); } catch { return ''; } };

const SHELL_FOLDERS = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders`;

// Documents folder from a `reg export` of SHELL_FOLDERS, %VARS% expanded; null without one.
// hex(2) is UTF-16, so a non-ASCII path survives (reg query's piped output would not).
export function documentsFrom(regText, env = process.env) {
  const m = regText.replace(/\\\r?\n\s*/g, '').match(/^"Personal"=(?:hex\(2\):([0-9a-f,]*)|"(.*)")\s*$/mi);
  if (!m) return null;
  const raw = m[1] === undefined ? m[2].replace(/\\(.)/g, '$1')
    : Buffer.from(m[1].split(',').filter(Boolean).map(h => parseInt(h, 16))).toString('utf16le').replace(/\0+$/, '');
  return raw.replace(/%([^%]+)%/g, (all, v) => env[v] ?? all) || null;
}

// Ask Windows: Documents is often moved into OneDrive. reg is ~20ms where PowerShell took ~330.
function windowsDocuments() {
  const tmp = path.join(os.tmpdir(), `upex-docs-${process.pid}.reg`);
  try {
    spawnSync('reg', ['export', SHELL_FOLDERS, tmp, '/y'], { stdio: 'ignore', timeout: 5000, windowsHide: true });
    return documentsFrom(fs.readFileSync(tmp, 'utf16le'));
  } catch {
    return null;
  } finally {
    // A locked temp file (antivirus) must not fail doctor.
    try { fs.rmSync(tmp, { force: true }); } catch { /* left in tmp */ }
  }
}

// Shell profiles that could hold the cd wrapper or completion.
function profileFiles() {
  const home = os.homedir();
  const files = [
    path.join(home, '.bashrc'),
    path.join(home, '.bash_profile'),
    rcFile('zsh'),
    path.join(path.dirname(path.dirname(rcFile('fish'))), 'config.fish'),
    rcFile('fish'),
  ];
  const docs = platform === 'win32' ? windowsDocuments() || path.join(home, 'Documents') : null;
  for (const dir of docs ? ['PowerShell', 'WindowsPowerShell'] : ['powershell']) {
    for (const name of ['Microsoft.PowerShell_profile.ps1', 'profile.ps1']) {
      files.push(path.join(docs || path.join(home, '.config'), dir, name));
    }
  }
  return files.filter(f => fs.existsSync(f));
}

function shellChecks() {
  const out = [];
  let cmdWrapper = false;

  if (platform === 'win32') {
    const shimDir = findShimDir();
    const bat = shimDir && path.join(shimDir, 'upex.bat');
    if (!shimDir) out.push(['warn', 'cmd wrapper', 'upex is not installed globally (npm link)']);
    else if (!fs.existsSync(bat)) out.push(['warn', 'cmd wrapper', 'missing, run: upex setup cmd']);
    else if (readText(bat) !== CMD_WRAPPER) out.push(['warn', 'cmd wrapper', 'outdated, run: upex setup cmd']);
    else { out.push(['ok', 'cmd wrapper', bat]); cmdWrapper = true; }
  }

  const profiles = profileFiles().map(f => ({ f, text: readText(f) }));
  const withWrapper = profiles.filter(p => p.text.includes('__resolve')).map(p => p.f);
  const withCompletion = profiles.filter(p => p.text.includes('upex completion') || p.text.includes('__names')).map(p => p.f);
  if (withWrapper.length) out.push(['ok', 'cd wrapper', withWrapper.join(', ')]);
  else if (!cmdWrapper) out.push(['warn', 'cd wrapper', 'not in any shell profile, see: upex setup']);
  // Completion is optional, so a missing one is only a hint.
  out.push(withCompletion.length
    ? ['ok', 'completion', withCompletion.join(', ')]
    : ['skip', 'completion', 'not set up (optional), see: upex completion --help']);
  return out;
}

// Rows of [status, check, detail]; status is ok | warn | fail | skip.
export function runChecks() {
  let links;
  try {
    links = loadLinks();
    loadConfig();
  } catch (err) {
    return [['fail', 'store', err.message.split('\n')[0]]];
  }
  const rows = [['ok', 'store', `${plural(Object.keys(links).length, 'shortcut')} in ${LINKS_FILE}`]];
  const issues = linkIssues();
  if (issues.length) rows.push(['warn', 'entries', `fix by hand in links.json: ${issues.join('; ')}`]);

  const broken = Object.keys(links).filter(n => links[n].path && !links[n].archived && !fs.existsSync(links[n].path));
  rows.push(broken.length
    ? ['warn', 'paths', `${plural(broken.length, 'broken shortcut')}: ${broken.join(', ')} (upex check)`]
    : ['ok', 'paths', 'all paths exist']);

  const badOpener = Object.keys(links).filter(n => links[n].opener && !openerKey(links[n].opener));
  if (badOpener.length) rows.push(['warn', 'default openers', `unknown opener on: ${badOpener.join(', ')} (upex edit <name> --no-opener)`]);

  const clashes = aliasClashes(links);
  if (clashes.length) rows.push(['warn', 'aliases', `names used twice: ${clashes.join('; ')} (upex alias <name> -r <alias>)`]);

  const missing = [];
  for (const [ws, entries] of Object.entries(loadWorkspaces())) {
    for (const e of Array.isArray(entries) ? entries : []) {
      // Subpaths ("web/src") count; fuzzy matches don't.
      const ok = typeof e?.shortcut === 'string' && resolveTarget(e.shortcut, links)?.exact;
      if (!ok) missing.push(`${ws}:${e?.shortcut ?? '?'}`);
    }
  }
  if (missing.length) rows.push(['warn', 'workspaces', `missing shortcuts: ${missing.join(', ')}`]);

  // One row per opener; aliases like code/vscode share a display name.
  const seen = new Set(['Copy path']);
  for (const [key, app] of Object.entries(getAppMap())) {
    if (seen.has(app.displayName)) continue;
    seen.add(app.displayName);
    const r = checkOpener(key);
    // A missing app (WebStorm, Claude) just stays out of the opener row; a missing file manager or terminal is a problem.
    const optional = ['vscode', 'code', 'webstorm', 'claude'].includes(key) && app === APP_MAP[key];
    rows.push(r.ok ? ['ok', app.displayName, r.command] : [optional ? 'skip' : 'warn', app.displayName, r.message.split('\n')[0]]);
  }

  return [...rows, ...shellChecks()];
}

export function registerDoctor(program) {
  program
    .command('doctor')
    .description('Check the store, openers, shell wrapper and completion')
    .option('--json', 'Print JSON: [{ status, check, detail }]')
    .action((options) => {
      const rows = runChecks();
      if (options.json) {
        ui.json(rows.map(([status, check, detail]) => ({ status, check, detail })));
        if (rows.some(r => r[0] === 'fail')) process.exitCode = 1;
        return;
      }
      ui.heading('Doctor');
      ui.table(rows.map(([status, check, detail]) => [ui.tag[status], chalk.bold(check), detail]));
      ui.blank();
      const warns = rows.filter(r => r[0] === 'warn').length;
      const fails = rows.filter(r => r[0] === 'fail').length;
      if (fails) ui.error(`${plural(fails, 'problem')} found.`);
      else if (warns) ui.warn(`${plural(warns, 'warning')}, everything else is fine.`);
      else ui.success('All good.');
      ui.blank();
      if (fails) process.exit(1);
    });
}
