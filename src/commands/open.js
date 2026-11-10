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
import { findFolder, withSub, cdTarget, fullPath, isPathArg, COMMAND_NAMES } from '../fast.js';
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
      if (COMMAND_NAMES.includes(name)) process.exit(1);
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
      if (r.error) ui.fail(r.error);
      const result = opener && openIn(opener, r.path, Number(count) || 1);
      if (opener && !result) process.exit(1);
      if (r.name) recordUse(r.name, opener ? openerKey(opener) : 'cd');
      if (!opener) return process.stdout.write(r.path);
      showOpened(r.name || path.basename(r.path) || r.path, opener, r.path, result);
    });
}

// Launch p in an opener; on failure prints why and returns nothing.
function openIn(appKey, p, count, startCmd = '', here = true) {
  const result = launchApp(appKey, p, count, startCmd, { here });
  if (result.ok) return result;
  ui.error(result.message);
}

// Why an open failed (and a dim hint), then false.
function notOpened(msg, hint, print = ui.error) {
  print(msg);
  if (hint) ui.dim(hint);
  return false;
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
 * Open a shortcut or path (upex <name> [app]). Never exits: true when opened, else prints why and returns false.
 * `here: false` (group, workspace, selector and upex ui opens) never hands this terminal to a shell.
 */
export async function handleOpen(name, app, count = 1, startCmd = '', { here = true } = {}) {
  const links = loadLinks();

  // `upex . claude`: a path opens without a shortcut (a shortcut of that exact name still wins).
  if (isPathArg(name) && !Object.hasOwn(links, name)) {
    const p = fullPath(name);
    if (!fs.existsSync(p)) return notOpened(`No such file or folder: ${name}`);
    const appKey = app || (isFile(p) ? 'open' : defaultOpener());
    const result = openIn(appKey, p, count, startCmd, here);
    if (result) showOpened(path.basename(p) || p, appKey, p, result);
    return !!result;
  }

  const resolved = resolveTarget(name, links);
  if (!resolved) return notOpened(`Shortcut not found: ${name}`, didYouMean(name, links));

  const shortcutName = resolved.name;
  const entry = links[shortcutName];
  const matched = () => { if (!resolved.exact) ui.dim(`matched "${name}" --> "${shortcutName}"`); };

  if (resolved.sub && !entry.path) return notOpened(`"${shortcutName}" has no folder, so "${resolved.sub}" can't be opened inside it.`);

  // URL shortcut: the browser.
  if (entry.url) {
    const result = launchUrl(entry.url);
    if (!result.ok) return notOpened(result.message);
    recordUse(shortcutName, 'url');
    matched();
    ui.card(shortcutName, [['url', chalk.bold(result.url)]]);
    return true;
  }

  // App shortcut: the stored executable; a command line runs in a terminal at the home folder.
  if (entry.app && !app && !resolved.sub) {
    const result = entry.terminal ? launchApp('cmd', os.homedir(), 1, entry.app, { here }) : launchExecutable(entry.app);
    if (!result.ok) return notOpened(result.message);
    recordUse(shortcutName, entry.terminal ? 'cmd' : 'app');
    matched();
    ui.card(shortcutName, [
      ['app', chalk.bold(result.displayName)],
      ['run', entry.terminal && entry.app],
      ['path', entry.path && ui.dimParent(entry.path, chalk.bold)],
    ]);
    runHere(result);
    return true;
  }

  // Folder shortcut: the given opener, else the shortcut's own, else a file's default app or the default opener.
  const targetPath = withSub(entry, resolved.sub);
  if (!targetPath) return notOpened(`No folder path stored for "${shortcutName}".`, `This is an app shortcut. Run without an opener: upex ${shortcutName}`, ui.warn);
  if (!fs.existsSync(targetPath)) return notOpened(`Path does not exist: ${targetPath}`, `Use "upex edit ${shortcutName} <newPath>" to update.`, ui.warn);

  const appKey = app || entry.opener || (isFile(targetPath) ? 'open' : defaultOpener());
  const result = openIn(appKey, targetPath, count, startCmd, here);
  if (!result) return false;
  recordUse(shortcutName, openerKey(appKey) || appKey);
  matched();
  showOpened(shortcutName, appKey, targetPath, result);
  return true;
}
