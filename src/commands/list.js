/**
 * list.js -- Show all saved shortcuts.
 * Usage: upex list
 */

import fs from 'node:fs';
import chalk from 'chalk';
import { loadLinks, activeLinks, aliasesOf } from '../store.js';
import { gitStatus } from '../git.js';
import { printRows, tidyPath, showsDetail, PIN, badgeText, expiryText } from '../rows.js';
import { setting } from '../launcher.js';
import * as ui from '../ui.js';

// Compact git cell: "main" (clean, dim) or "main*" (dirty, yellow); none outside a repo.
function gitCell(filepath) {
  const git = filepath ? gitStatus(filepath) : null;
  if (!git) return '';
  return git.dirty ? chalk.yellow(`${git.branch}*`) : chalk.dim(git.branch);
}

export function registerList(program) {
  program
    .command('list [tag]')
    .alias('ls')
    .description('List all saved shortcuts (optionally filtered by tag)')
    .option('-g, --git', 'Show each folder\'s current git branch')
    .option('--archived', 'List archived shortcuts instead (upex restore <name> brings one back)')
    .option('--json', 'Print JSON: [{ name, ...entry, exists }]')
    .action((tag, options) => {
      const showGit = !!options.git;
      const all = loadLinks();
      const links = activeLinks(all, !!options.archived);
      const archivedCount = options.archived ? 0 : Object.keys(all).length - Object.keys(links).length;
      let entries = Object.entries(links);
      if (tag) {
        entries = entries.filter(([, e]) => Array.isArray(e.tags) && e.tags.includes(tag));
      }
      const exists = e => (e.path ? fs.existsSync(e.path) : !!(e.app || e.url));
      if (options.json) return ui.json(entries.map(([name, e]) => ({ name, ...e, exists: exists(e) })));

      if (entries.length === 0) {
        ui.blank();
        ui.info(tag ? `No shortcuts tagged "${tag}".` : options.archived ? 'No archived shortcuts.' : 'No shortcuts saved. Use: upex add <name> [path]');
        if (archivedCount) ui.dim(`${archivedCount} archived (upex ls --archived)`);
        ui.blank();
        return;
      }

      ui.heading(`${options.archived ? 'Archived shortcuts' : 'Shortcuts'}${tag ? ` tagged #${tag}` : ''}`);

      // Same rows as the selector: name, path (parent dim), then aliases, git, #tags and a badge on the right.
      // Piped output keeps every detail, agents read it.
      const details = process.stdout.isTTY ? setting('rowDetails') : 'both';
      const badgesOn = showsDetail(details, 'badges');
      printRows(entries.map(([name, entry]) => {
        const kind = entry.terminal ? 'cmd' : entry.app ? 'app' : entry.url ? 'url' : entry.opener;
        const badge = !badgesOn ? '' : !exists(entry) ? chalk.red('missing')
          : chalk.dim(badgeText([entry.pinned && PIN, kind, !entry.archived && expiryText(entry.expires)]));
        const aliases = aliasesOf(entry);
        const right = [
          aliases.length && chalk.dim(`(${aliases.join(', ')})`),
          showGit && gitCell(entry.path),
          showsDetail(details, 'tags') && entry.tags?.length && chalk.dim(`#${entry.tags.join(' #')}`),
          badge,
        ];
        return {
          name,
          text: entry.url || tidyPath(entry.path || entry.app || ''),
          style: entry.url ? 'url' : 'path',
          right: right.filter(Boolean).join('  '),
        };
      }));
      ui.separator();
      ui.dim(`${entries.length} shortcut${entries.length === 1 ? '' : 's'}${tag ? ` tagged #${tag}` : ' total'}`
        + (archivedCount ? `, ${archivedCount} archived (upex ls --archived)` : ''));
      ui.blank();
    });
}
