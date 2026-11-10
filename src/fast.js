/**
 * fast.js -- Hot path for the cd wrappers (`go <name>`, `cd <path>`, `__resolve <name>`) and completion (`__names`) without commander or the commands.
 * Anything it can't answer falls through to the full CLI.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadLinks, recordUse, sweepExpired, StoreError, loadVisits, learnedFolders, recordVisit, completionNames } from './store.js';
import { resolveTarget } from './fuzzy.js';

// Every sub-command in registration order: [names and aliases, file in commands/, register function]. index.js loads only the file it needs.
export const COMMANDS = [
  ['add', 'add', 'registerAdd'], ['list ls', 'list', 'registerList'], ['remove rm restore', 'remove', 'registerRemove'],
  ['rename', 'rename', 'registerRename'], ['edit', 'edit', 'registerEdit'], ['check', 'check', 'registerCheck'],
  ['__resolve', 'open', 'registerResolve'], ['go', 'open', 'registerGo'], ['cd', 'open', 'registerCd'],
  ['learned', 'learned', 'registerLearned'], ['setup', 'setup', 'registerSetup'], ['help', 'help', 'registerHelp'],
  ['copy', 'copy', 'registerCopy'], ['cmd', 'cmd', 'registerCmd'], ['app', 'app', 'registerApp'],
  ['__names completion', 'completion', 'registerCompletion'], ['tag', 'tag', 'registerTag'], ['alias', 'alias', 'registerAlias'],
  ['open', 'tag', 'registerOpenGroup'], ['ws workspace', 'workspace', 'registerWorkspace'], ['run', 'run', 'registerRun'],
  ['export', 'transfer', 'registerExport'], ['import', 'transfer', 'registerImport'], ['last', 'last', 'registerLast'],
  ['ui', 'web', 'registerWeb'], ['web', 'webpage', 'registerWebPage'], ['doctor', 'doctor', 'registerDoctor'],
  ['stale', 'stale', 'registerStale'], ['stats', 'stats', 'registerStats'], ['config', 'config', 'registerConfig'],
  ['pin unpin', 'pin', 'registerPin'], ['undo', 'undo', 'registerUndo'], ['note', 'note', 'registerNote'],
  ['color', 'color', 'registerColor'], ['pick', 'pick', 'registerPick'],
];
// Every sub-command name and alias. __resolve must not cd into a shortcut that shadows one; smoke.mjs checks this list.
export const COMMAND_NAMES = COMMANDS.flatMap(c => c[0].split(' '));

// Folder path of a shortcut plus an optional subpath ("web/src").
export const withSub = (entry, sub) => (entry.path && sub ? path.join(entry.path, sub) : entry.path);

// Folder for a name: { name, path } or { error }.
export function findFolder(query) {
  // go/__resolve skip the sweep, so treat expired as archived here (not saved).
  const { links } = sweepExpired(loadLinks());
  const resolved = resolveTarget(query, links);
  if (!resolved) return { error: `Shortcut not found: ${query}` };
  const p = withSub(links[resolved.name], resolved.sub);
  if (!p || !fs.existsSync(p)) return { error: p ? `Path does not exist: ${p}` : `No folder path for "${resolved.name}".` };
  return { name: resolved.name, path: p };
}

// Absolute path, ~ expanded.
export const fullPath = (q) => path.resolve(q.replace(/^~(?=$|[\\/])/, os.homedir()));

// An explicit path (., .., ./x, ~/x or absolute), never a shortcut name.
export const isPathArg = (s) => /^(~|\.\.?)([\\/]|$)/.test(s) || path.isAbsolute(s);

// Folder for `upex cd`: an existing path (~ expanded), else a shortcut, else the most used learned folder of that name. A file gives its folder.
export function cdTarget(query) {
  const p = fullPath(query);
  let r = fs.existsSync(p) ? { path: p } : findFolder(query);
  if (r.error?.startsWith('Shortcut not found')) {
    const [hit] = learnedFolders(loadVisits(), {}, { query });
    r = hit ? { path: hit.path } : { error: `No such folder or shortcut: ${query}` };
  }
  if (r.path && fs.statSync(r.path).isFile()) r.path = path.dirname(r.path);
  return r;
}

// Handle `go <name>` / `__resolve <name>` / `__names` if possible. Returns true when done.
export function fastPath([cmd, name, ...rest]) {
  if (cmd === '__names' && name === undefined) {
    try { process.stdout.write(completionNames()); } catch (err) {
      if (err instanceof StoreError) return false;
      throw err;
    }
    return true;
  }
  const quiet = cmd === '__resolve';
  if ((!quiet && cmd !== 'go' && cmd !== 'cd') || !name || name.startsWith('-') || rest.length) return false;
  // A command name or a lone path (upex .) is never a cd: the wrapper runs or opens it.
  if (quiet && (COMMAND_NAMES.includes(name) || isPathArg(name))) process.exit(1);
  let r;
  try { r = cmd === 'cd' ? cdTarget(name) : findFolder(name); } catch (err) {
    if (err instanceof StoreError) return false;
    throw err;
  }
  // Failures go to the full CLI for its messages, except __resolve, which fails silently anyway.
  if (r.error) {
    if (quiet) process.exit(1);
    return false;
  }
  // A plain path (only cd gives one) is learned instead.
  if (r.name) recordUse(r.name, 'cd');
  else recordVisit(r.path);
  process.stdout.write(r.path);
  return true;
}
