/**
 * stale.js -- List shortcuts not opened in a while and offer to archive them.
 * Usage: upex stale [days] [--yes]
 */

import readline from 'node:readline/promises';
import chalk from 'chalk';
import { loadLinks, saveLinks, staleLinks } from '../store.js';
import { printRows, tidyPath } from '../interactive.js';
import { setting } from '../launcher.js';
import * as ui from '../ui.js';

export function registerStale(program) {
  program
    .command('stale [days]')
    .description('List shortcuts not opened in [days] (default: the staleAfter setting, 60) and offer to archive them')
    .summary('List unused shortcuts, offer to archive them')
    .option('-y, --yes', 'Archive all listed shortcuts without asking')
    .action(async (days = setting('staleAfter'), options) => {
      if (!/^\d+$/.test(days)) {
        ui.error(`Days must be a whole number, got "${days}".`);
        process.exit(1);
      }
      const now = Date.now();
      const stale = staleLinks(loadLinks(), Number(days), now);
      if (!stale.length) {
        ui.success(`Every shortcut was opened in the last ${days} days.`);
        return;
      }

      ui.heading(`Not opened in ${days}+ days`);
      printRows(stale.map(({ name, entry, since }) => ({
        name,
        text: entry.url || tidyPath(entry.path || entry.app || ''),
        style: entry.url ? 'url' : 'path',
        right: entry.lastUsed ? `${ui.span(now - since)} ago` : chalk.dim(since ? `never, added ${ui.span(now - since)} ago` : 'never'),
      })));
      ui.separator();

      let pick = stale.map(s => s.name);
      if (!options.yes) {
        if (!process.stdin.isTTY) {
          ui.dim(`Archive them with: upex stale ${days} --yes (or upex rm <name> --archive)`);
          return;
        }
        pick = await ask(pick);
      }
      if (!pick.length) return;

      // Fresh load so edits made while the prompt was open survive.
      const links = loadLinks();
      const done = pick.filter(n => Object.hasOwn(links, n) && !links[n].archived);
      for (const n of done) links[n] = { ...links[n], archived: true };
      saveLinks(links);
      ui.success(`Archived ${done.length}: ${done.join(', ')}`);
      ui.dim('Restore one with: upex restore <name>');
    });
}

// y/n per name, a = this and the rest, q = stop. Returns the names to archive.
async function ask(names) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // Ctrl+C archives nothing.
  rl.on('SIGINT', () => { rl.close(); process.exit(130); });
  const pick = [];
  try {
    for (let i = 0; i < names.length; i++) {
      // Closed stdin rejects the question: stop like q.
      const a = (await rl.question(`  Archive ${chalk.bold(names[i])}? [y/n/a/q] `).catch(() => 'q')).trim().toLowerCase();
      if (a === 'q') break;
      if (a === 'a') { pick.push(...names.slice(i)); break; }
      if (a === 'y') pick.push(names[i]);
    }
  } finally {
    rl.close();
  }
  return pick;
}
