/**
 * fast.js -- Hot path for the cd wrappers (`go <name>`, `cd <path>`, `__resolve <name>`) without commander or the commands.
 * Anything it can't answer falls through to the full CLI.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadLinks, recordUse, sweepExpired, StoreError } from './store.js';
import { resolveTarget } from './fuzzy.js';

// Every sub-command name and alias. __resolve must not cd into a shortcut that shadows one; smoke.mjs checks this list.
export const COMMAND_NAMES = ['add', 'list', 'ls', 'remove', 'rm', 'restore', 'rename', 'edit', 'check', '__resolve', 'go',
  'setup', 'help', 'copy', 'cmd', 'app', '__names', 'completion', 'tag', 'alias', 'open', 'ws', 'workspace', 'run',
  'cd', 'export', 'import', 'last', 'ui', 'web', 'doctor', 'stale', 'stats', 'config', 'pin', 'unpin', 'undo', 'note', 'pick', 'color'];

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

// Folder for `upex cd`: an existing path (~ expanded), else a shortcut. A file gives its folder.
export function cdTarget(query) {
  const p = path.resolve(query.replace(/^~(?=$|[\\/])/, os.homedir()));
  const r = fs.existsSync(p) ? { path: p } : findFolder(query);
  if (r.error?.startsWith('Shortcut not found')) r.error = `No such folder or shortcut: ${query}`;
  if (r.path && fs.statSync(r.path).isFile()) r.path = path.dirname(r.path);
  return r;
}

// Handle `go <name>` / `__resolve <name>` if possible. Returns true when done.
export function fastPath([cmd, name, ...rest]) {
  const quiet = cmd === '__resolve';
  if ((!quiet && cmd !== 'go' && cmd !== 'cd') || !name || name.startsWith('-') || rest.length) return false;
  if (quiet && COMMAND_NAMES.includes(name)) return false;
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
  if (r.name) recordUse(r.name, 'cd');
  process.stdout.write(r.path);
  return true;
}
