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
    .command('cmd <name> [rest...]')
    .description('Open a shortcut in N terminal windows, optionally running a start command')
    // Let flags after the shortcut (e.g. "claude --model x") pass through as the start command.
    .enablePositionalOptions()
    .passThroughOptions()
    .allowUnknownOption()
    .action((name, rest = []) => {
      // A leading integer is the window count; anything else is the start command.
      let count = 1;
      let start = rest;
      if (rest.length && /^\d+$/.test(rest[0])) {
        count = Number(rest[0]);
        start = rest.slice(1);
      }
      return handleOpen(name, 'cmd', count, start.join(' '));
    });
}
