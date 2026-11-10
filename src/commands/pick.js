/**
 * pick.js -- Choose shortcuts in the selector, print their paths for scripts and pipes.
 * Usage: upex pick   (e.g. cd "$(upex pick)", upex pick | clip)
 */

import chalk, { chalkStderr } from 'chalk';
import { loadLinks, loadWorkspaces } from '../store.js';
import { resolveTarget } from '../fuzzy.js';
import { withSub } from '../fast.js';
import { runUpdate } from '../update.js';
import * as ui from '../ui.js';

// Names a selector result stands for: the row, the marked rows, or a workspace's entries.
export function pickedNames(result, workspaces = {}) {
  if (result.status === 'selected') return [result.name];
  if (result.status === 'marked') return result.entries.map(e => e.shortcut);
  if (result.status === 'workspace') return (workspaces[result.name] || []).map(e => e.shortcut);
  return [];
}

// Folder path, else URL, else app command; gone or empty entries are skipped.
// Resolved like opening does, so a workspace entry's alias or subpath ("web/src") works too.
export const pickedPaths = (names, links) => names.map((n) => {
  const r = resolveTarget(n, links);
  const e = r && links[r.name];
  return e && (withSub(e, r.sub) || (!r.sub && (e.url || e.app)));
}).filter(Boolean);

export function registerPick(program) {
  program
    .command('pick')
    .description('Choose shortcuts in the selector (drawn on stderr) and print their paths to stdout, one per line; Esc prints nothing and exits 1')
    .summary('Selector that prints the chosen path')
    .action(async () => {
      if (!process.stdin.isTTY || !process.stderr.isTTY) ui.fail('upex pick needs a terminal (stdin and stderr)');
      // Colors follow the terminal the selector draws on, not the pipe.
      chalk.level = chalkStderr.level;
      const { runInteractiveMode } = await import('../interactive.js');
      const result = await runInteractiveMode({ stdout: process.stderr, picker: true });
      if (result.status === 'update') { await runUpdate(); process.exitCode ||= 1; return; }
      const paths = pickedPaths(pickedNames(result, result.status === 'workspace' ? loadWorkspaces() : {}), loadLinks());
      if (!paths.length) { process.exitCode = 1; return; }
      process.stdout.write(paths.join('\n') + '\n');
    });
}
