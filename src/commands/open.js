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
import { resolveTarget, didYouMean } from '../fuzzy.js';
import { launchApp, launchExecutable, launchUrl, defaultOpener } from '../launcher.js';
import * as ui from '../ui.js';

export function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// Folder path of a shortcut plus an optional subpath ("web/src").
const withSub = (entry, sub) => (entry.path && sub ? path.join(entry.path, sub) : entry.path);

// Resolve a name to a usable folder path and record the use.
// On failure prints nothing (or `loud` message) and exits 1.
function resolveFolder(name, { loud = false } = {}) {
  const links = loadLinks();
  const resolved = resolveTarget(name, links);

  if (!resolved) {
    if (loud) ui.error(`Shortcut not found: ${name}`);
    process.exit(1);
  }

  const entry = links[resolved.name];
  const targetPath = withSub(entry, resolved.sub);

  if (!targetPath || !fs.existsSync(targetPath)) {
    if (loud) ui.error(targetPath ? `Path does not exist: ${targetPath}` : `No folder path for "${resolved.name}".`);
    process.exit(1);
  }

  recordUse(resolved.name);
  return targetPath;
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
    recordUse(shortcutName);
    if (!resolved.exact) {
      ui.dim(`matched "${name}" --> "${shortcutName}"`);
    }
    ui.heading(shortcutName);
    console.log(`  ${chalk.dim('url')}    ${chalk.bold(result.url)}`);
    ui.blank();
    return true;
  }

  // ── App shortcut: launch stored executable directly ──
  if (entry.app && !app && !resolved.sub) {
    // A command line opens a terminal in the home folder and runs there.
    const result = entry.terminal ? launchApp('cmd', os.homedir(), 1, entry.app) : launchExecutable(entry.app);

    if (!result.ok) {
      if (bail(() => ui.error(result.message))) return false;
    }

    recordUse(shortcutName);

    if (!resolved.exact) {
      ui.dim(`matched "${name}" --> "${shortcutName}"`);
    }

    ui.heading(shortcutName);
    console.log(`  ${chalk.dim('app')}    ${chalk.bold(result.displayName)}`);
    if (entry.terminal) console.log(`  ${chalk.dim('run')}    ${entry.app}`);
    if (entry.path) {
      console.log(`  ${chalk.dim('path')}   ${entry.path}`);
    }
    ui.blank();
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
  const result = launchApp(appKey, targetPath, count, startCmd);

  if (!result.ok) {
    if (bail(() => ui.error(result.message))) return false;
  }

  recordUse(shortcutName);

  // -- Structured output card --
  if (!resolved.exact) {
    ui.dim(`matched "${name}" --> "${shortcutName}"`);
  }

  ui.heading(shortcutName);

  const appLabel = result.displayName || appKey;
  console.log(`  ${chalk.dim('app')}    ${chalk.bold(appLabel)}`);
  console.log(`  ${chalk.dim('path')}   ${targetPath}`);
  ui.blank();
  return true;
}
