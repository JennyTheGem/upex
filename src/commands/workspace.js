/**
 * workspace.js -- Save and open named sets of shortcut+app pairs.
 * Usage: upex ws                                        -- list workspaces
 *        upex ws <name>                                 -- open every entry
 *        upex ws add <name> <shortcut> [app] [count] [start...]  -- append an entry
 *        upex ws rm <name> [shortcut]                   -- remove a workspace (or one entry)
 *
 * The [count] [start...] tail works exactly like `upex cmd`: for the `cmd`
 * opener it opens N terminals and runs the start command in each, e.g.
 *   upex ws add dev velora cmd claude --model sonnet
 */

import chalk from 'chalk';
import { loadWorkspaces, saveWorkspaces, removeWorkspace, linkExists, nameError } from '../store.js';
import { handleOpen } from './open.js';
import * as ui from '../ui.js';

// Human-readable one-liner for an entry: "shortcut:app x2 (start cmd)".
export function describeEntry(e) {
  let s = e.app ? `${e.shortcut}:${e.app}` : e.shortcut;
  if (e.count > 1) s += ` x${e.count}`;
  if (e.start) s += ` (${e.start})`;
  return s;
}

function listWorkspaces(workspaces) {
  const names = Object.keys(workspaces);
  if (!names.length) {
    ui.info('No workspaces. Add one: upex ws add <name> <shortcut> [app]');
    return;
  }
  ui.heading('Workspaces');
  for (const name of names) {
    const parts = (workspaces[name] || []).map(describeEntry);
    console.log(`  ${chalk.bold(name)}  ${chalk.dim(parts.join('  '))}`);
  }
  ui.blank();
}

// Open each entry; returns how many failed.
export async function openEntries(entries) {
  let failed = 0;
  for (const { shortcut, app, count = 1, start = '' } of entries) {
    if (!(await handleOpen(shortcut, app || undefined, count, start, { batch: true }))) failed++;
  }
  return failed;
}

export async function openWorkspace(workspaces, name) {
  const entries = Object.hasOwn(workspaces, name) && workspaces[name];
  if (!entries) {
    ui.error(`No workspace named "${name}".`);
    const names = Object.keys(workspaces);
    if (names.length) ui.dim(`Available: ${names.join(', ')}`);
    process.exit(1);
  }
  ui.dim(`Opening workspace "${name}" (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'})`);
  const failed = await openEntries(entries);
  if (failed) {
    ui.error(`${failed} of ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} failed to open.`);
    process.exitCode = 1;
  }
}

export function registerWorkspace(program) {
  program
    .command('ws [args...]')
    .alias('workspace')
    .description('Open or manage workspaces (ws add / ws rm / ws <name>)')
    // Let a start command with its own flags (e.g. "claude --model x") pass through.
    .enablePositionalOptions()
    .passThroughOptions()
    .allowUnknownOption()
    .action(async (args) => {
      const workspaces = loadWorkspaces();
      const [verb, ...rest] = args;

      if (!verb) return listWorkspaces(workspaces);

      if (verb === 'add') {
        const [name, shortcut, app, ...tail] = rest;
        if (!name || !shortcut) {
          ui.error('Usage: upex ws add <name> <shortcut> [app] [count] [start...]');
          process.exit(1);
        }
        const bad = !Object.hasOwn(workspaces, name) && nameError(name);
        if (bad) {
          ui.error(bad);
          process.exit(1);
        }
        if (!linkExists(shortcut)) {
          ui.warn(`Shortcut "${shortcut}" doesn't exist yet, adding anyway.`);
        }
        // A leading integer in the tail is the terminal count; the rest is the start command.
        let count = 1;
        let start = tail;
        if (tail.length && /^\d+$/.test(tail[0])) {
          count = Number(tail[0]);
          start = tail.slice(1);
        }
        const entry = {
          shortcut,
          ...(app && { app }),
          ...(count > 1 && { count }),
          ...(start.length && { start: start.join(' ') }),
        };
        const list = Object.hasOwn(workspaces, name) ? workspaces[name] : [];
        list.push(entry);
        saveWorkspaces({ ...workspaces, [name]: list });
        ui.success(`ws "${name}" += ${describeEntry(entry)}`);
        return;
      }

      if (verb === 'rm' || verb === 'remove') {
        const [name, shortcut] = rest;
        if (!name || !Object.hasOwn(workspaces, name)) {
          ui.error(`No workspace named "${name}".`);
          process.exit(1);
        }
        if (!shortcut) {
          removeWorkspace(name);
          ui.success(`Removed workspace "${name}".`);
          return;
        }
        const list = (workspaces[name] || []).filter(e => e.shortcut !== shortcut);
        if (list.length) saveWorkspaces({ ...workspaces, [name]: list });
        else removeWorkspace(name);
        ui.success(`ws "${name}" -= ${shortcut}`);
        return;
      }

      // Anything else is a workspace name to open.
      await openWorkspace(workspaces, verb);
    });
}
