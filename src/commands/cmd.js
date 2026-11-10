/**
 * cmd.js -- Open a shortcut in N terminal windows, optionally running a command.
 * Usage: upex cmd <name> [count] [start command...]
 *   upex cmd velora            -- one window at velora
 *   upex cmd velora 2          -- two windows
 *   upex cmd velora claude     -- one window running "claude"
 *   upex cmd velora 2 dir      -- two windows each running "dir"
 */

import { handleOpen } from './open.js';

export function registerCmd(program) {
  program
    .command('cmd <name> [count] [start...]')
    .description('Open a shortcut in N terminal windows, optionally running a start command')
    .summary('Open N terminals, optionally running a command')
    // Let flags after the shortcut (e.g. "claude --model x") pass through as the start command.
    .enablePositionalOptions()
    .passThroughOptions()
    .allowUnknownOption()
    .action(async (name, count, start = []) => {
      // A non-numeric "count" is really the first word of the start command.
      if (count && !/^\d+$/.test(count)) [count, start] = [1, [count, ...start]];
      if (!(await handleOpen(name, 'cmd', Number(count) || 1, start.join(' ')))) process.exit(1);
    });
}
