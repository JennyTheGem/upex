/**
 * open.js -- Open a shortcut path or launch it in an app.
 * Default command: upex <name> [app]
 * Hidden command: upex __resolve <name>
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import chalk from 'chalk';
import { loadLinks, recordUse } from '../store.js';
import { findFolder, withSub } from '../fast.js';
import { resolveTarget, didYouMean } from '../fuzzy.js';
import { launchApp, launchExecutable, launchUrl, defaultOpener, openerKey } from '../launcher.js';
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
    // Let flags in the start command (e.g. "claude --model x") pass through.
    .enablePositionalOptions()
    .passThroughOptions()
    .allowUnknownOption()
    .action((name, start = []) => {
      if (!start.length) return resolveToStdout(name, { loud: true });

      const targetPath = resolveFolder(name, { loud: true });
      const cwd = isFile(targetPath) ? path.dirname(targetPath) : targetPath;
      const r = spawnSync(start.join(' '), { cwd, stdio: 'inherit', shell: true });
      process.exit(r.status ?? 1);
    });
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
  const result = launchApp(appKey, targetPath, count, startCmd, { here: !batch });

  if (!result.ok) {
    if (bail(() => ui.error(result.message))) return false;
  }

  recordUse(shortcutName, openerKey(appKey) || appKey);

  // -- Structured output card --
  if (!resolved.exact) {
    ui.dim(`matched "${name}" --> "${shortcutName}"`);
  }

  ui.card(shortcutName, [['app', chalk.bold(result.displayName || appKey)], ['path', ui.dimParent(targetPath, chalk.bold)]]);
  runHere(result);
  return true;
}
