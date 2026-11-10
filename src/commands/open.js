/**
 * open.js -- Open a shortcut path or launch it in an app.
 * Default command: upex <name> [app]
 * Hidden command: upex __resolve <name>
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import chalk from 'chalk';
import { loadLinks, recordUse } from '../store.js';
import { findFolder, withSub, cdTarget, fullPath, isPathArg } from '../fast.js';
import { resolveTarget, didYouMean } from '../fuzzy.js';
import { launchApp, launchExecutable, launchUrl, defaultOpener, openerKey, spawnSync } from '../launcher.js';
import * as ui from '../ui.js';

export function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// Folder path for a name and record the use. On failure prints nothing (or the reason with `loud`) and exits 1.
function resolveFolder(name, { loud = false } = {}) {
  const r = findFolder(name);
  if (r.error) {
    if (loud) ui.error(r.error);
    process.exit(1);
  }
  recordUse(r.name, 'cd');
  return r.path;
}

// Raw path to stdout (no formatting) -- consumed by `cd $(upex go <name>)`.
function resolveToStdout(name, opts) {
  process.stdout.write(resolveFolder(name, opts));
}

export function registerResolve(program) {
  program
    .command('__resolve <name>', { hidden: true })
    .description('(internal) Resolve a shortcut name to its path')
    // Wrappers send a lone `upex --help` here; exit 1 so they fall through to real help.
    .helpOption(false)
    .action((name) => {
      // Wrappers route every bare arg through here; never let fuzzy matching
      // shadow a real subcommand (e.g. "list" hijacked into a cd).
      const taken = program.commands.some(c => c.name() === name || c.aliases().includes(name));
      if (taken) process.exit(1);
      resolveToStdout(name);
    });
}

/**
 * Public path-printing command: `cd $(upex go <name>)`.
 */
export function registerGo(program) {
  program
    .command('go <name> [start...]')
    .description('Print a shortcut\'s path (cd via shell wrapper); extra args run as a command there')
    .summary('Print a path (cd via wrapper); extra args run there')
    .option('--json', 'Print { name, path } or { error } (before the name when the cd wrapper is on)')
    // Let flags in the start command (e.g. "claude --model x") pass through.
    .enablePositionalOptions()
    .passThroughOptions()
    .allowUnknownOption()
    .action((name, start = [], options) => {
      // A lone trailing --json is never a command to run.
      if (options.json || (start.length === 1 && start[0] === '--json')) {
        const r = findFolder(name);
        ui.json(r.error ? { error: r.error } : r);
        if (r.error) process.exit(1);
        return recordUse(r.name, 'cd');
      }
      if (!start.length) return resolveToStdout(name, { loud: true });

      const targetPath = resolveFolder(name, { loud: true });
      const cwd = isFile(targetPath) ? path.dirname(targetPath) : targetPath;
      const r = spawnSync(start.join(' '), [], { cwd, stdio: 'inherit', shell: true });
      process.exit(r.status ?? 1);
    });
}

// `upex cd <path> [opener]`: the wrappers cd there, then call again with the opener to open it.
export function registerCd(program) {
  program
    .command('cd <path> [opener] [count]')
    .description('Print a folder (a path, else a shortcut, else a learned folder: upex learned) for the shell wrapper to cd into; an opener opens it there, like upex <name> <opener>')
    .summary('cd into a path, shortcut or learned folder; an opener opens it there')
    .action((query, opener, count) => {
      const r = cdTarget(query);
      if (r.error) {
        ui.error(r.error);
        process.exit(1);
      }
      const result = opener && openIn(opener, r.path, Number(count) || 1);
      if (r.name) recordUse(r.name, opener ? openerKey(opener) : 'cd');
      if (!opener) return process.stdout.write(r.path);
      showOpened(r.name || path.basename(r.path) || r.path, opener, r.path, result);
    });
}

// Launch p in an opener; on failure prints why and exits (batch: returns nothing).
function openIn(appKey, p, count, startCmd = '', batch = false) {
  const result = launchApp(appKey, p, count, startCmd, { here: !batch });
  if (result.ok) return result;
  ui.error(result.message);
  if (!batch) process.exit(1);
}

function showOpened(label, appKey, p, result) {
  ui.card(label, [['app', chalk.bold(result.displayName || appKey)], ['path', ui.dimParent(p, chalk.bold)]]);
  runHere(result);
}

// Terminal layout 'here': the shell takes over this terminal until it exits.
function runHere(result) {
  if (!result.inPlace) return;
  ui.dim('exit to come back');
  process.exitCode = result.inPlace();
}

/**
 * Handle the default open/launch action.
 * Returns true when opened; in batch mode a failure returns false instead of exiting.
 */
export async function handleOpen(name, app, count = 1, startCmd = '', { batch = false } = {}) {
  // In batch mode (group/workspace open) a bad shortcut must not exit the whole run.
  const bail = (fn) => { fn(); if (batch) return true; process.exit(1); };

  const links = loadLinks();

  // `upex . claude`: a path opens without a shortcut (a shortcut of that exact name still wins).
  if (isPathArg(name) && !Object.hasOwn(links, name)) {
    const p = fullPath(name);
    if (!fs.existsSync(p)) {
      if (bail(() => ui.error(`No such file or folder: ${name}`))) return false;
    }
    const appKey = app || (isFile(p) ? 'open' : defaultOpener());
    const result = openIn(appKey, p, count, startCmd, batch);
    if (result) showOpened(path.basename(p) || p, appKey, p, result);
    return !!result;
  }

  const resolved = resolveTarget(name, links);

  if (!resolved) {
    if (bail(() => {
      ui.error(`Shortcut not found: ${name}`);
      const hint = didYouMean(name, links);
      if (hint) ui.dim(hint);
    })) return false;
  }

  const shortcutName = resolved.name;
  const entry = links[shortcutName];

  if (resolved.sub && !entry.path) {
    if (bail(() => ui.error(`"${shortcutName}" has no folder, so "${resolved.sub}" can't be opened inside it.`))) return false;
  }

  // ── URL shortcut: open in the browser directly ──
  if (entry.url) {
    const result = launchUrl(entry.url);
    if (!result.ok) {
      if (bail(() => ui.error(result.message))) return false;
    }
    recordUse(shortcutName, 'url');
    if (!resolved.exact) {
      ui.dim(`matched "${name}" --> "${shortcutName}"`);
    }
    ui.card(shortcutName, [['url', chalk.bold(result.url)]]);
    return true;
  }

  // ── App shortcut: launch stored executable directly ──
  if (entry.app && !app && !resolved.sub) {
    // A command line opens a terminal in the home folder and runs there.
    const result = entry.terminal ? launchApp('cmd', os.homedir(), 1, entry.app, { here: !batch }) : launchExecutable(entry.app);

    if (!result.ok) {
      if (bail(() => ui.error(result.message))) return false;
    }

    recordUse(shortcutName, entry.terminal ? 'cmd' : 'app');

    if (!resolved.exact) {
      ui.dim(`matched "${name}" --> "${shortcutName}"`);
    }

    ui.card(shortcutName, [
      ['app', chalk.bold(result.displayName)],
      ['run', entry.terminal && entry.app],
      ['path', entry.path && ui.dimParent(entry.path, chalk.bold)],
    ]);
    runHere(result);
    return true;
  }

  // ── Folder shortcut: open in specified or default opener ──
  const targetPath = withSub(entry, resolved.sub);

  if (!targetPath) {
    if (bail(() => {
      ui.warn(`No folder path stored for "${shortcutName}".`);
      ui.dim(`This is an app shortcut. Run without an opener: upex ${shortcutName}`);
    })) return false;
  }

  if (!fs.existsSync(targetPath)) {
    if (bail(() => {
      ui.warn(`Path does not exist: ${targetPath}`);
      ui.dim(`Use "upex edit ${shortcutName} <newPath>" to update.`);
    })) return false;
  }

  // No opener given: the shortcut's own, else a file opens in its default app and a folder in the default opener.
  const appKey = app || entry.opener || (isFile(targetPath) ? 'open' : defaultOpener());
  const result = openIn(appKey, targetPath, count, startCmd, batch);
  if (!result) return false;

  recordUse(shortcutName, openerKey(appKey) || appKey);

  // -- Structured output card --
  if (!resolved.exact) {
    ui.dim(`matched "${name}" --> "${shortcutName}"`);
  }

  showOpened(shortcutName, appKey, targetPath, result);
  return true;
}
