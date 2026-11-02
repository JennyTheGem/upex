/**
 * list.js -- Show all saved shortcuts.
 * Usage: upex list
 */

import fs from 'node:fs';
import nodePath from 'node:path';
import chalk from 'chalk';
import { loadLinks } from '../store.js';
import { gitStatus } from '../git.js';
import * as ui from '../ui.js';

// Compact git cell: "main" (clean) or "main*" (dirty).
function gitCell(filepath) {
  const git = filepath ? gitStatus(filepath) : null;
  if (!git) return chalk.dim('--');
  return git.dirty ? chalk.yellow(`${git.branch}*`) : chalk.magenta(git.branch);
}

export function registerList(program) {
  program
    .command('list [tag]')
    .alias('ls')
    .description('List all saved shortcuts (optionally filtered by tag)')
    .option('-g, --git', 'Show each folder\'s current git branch')
    .action((tag, options) => {
      const showGit = !!options.git;
      const links = loadLinks();
      let entries = Object.entries(links);
      if (tag) {
        entries = entries.filter(([, e]) => Array.isArray(e.tags) && e.tags.includes(tag));
      }

      if (entries.length === 0) {
        ui.blank();
        ui.info(tag ? `No shortcuts tagged "${tag}".` : 'No shortcuts saved. Use: upex add <name> [path]');
        ui.blank();
        return;
      }

      ui.heading(tag ? `Shortcuts tagged #${tag}` : 'Saved Shortcuts');

      const header = [chalk.bold('#'), chalk.bold('NAME'), chalk.bold('APP'), chalk.bold('PATH')];
      if (showGit) header.push(chalk.bold('GIT'));
      header.push(chalk.bold('TAGS'), chalk.bold('STATUS'));

      const rows = [
        header,
        ...entries.map(([name, entry], i) => {
          const filepath = entry.path;
          const appLabel = entry.terminal ? chalk.cyan('cmd')
            : entry.app
            ? chalk.cyan(nodePath.basename(entry.app).replace(/\.[^.]+$/, ''))
            : entry.url ? chalk.cyan('url') : chalk.dim(entry.opener || '--');
          const exists = filepath ? fs.existsSync(filepath) : !!(entry.app || entry.url);
          const pathDisplay = filepath
            ? (exists ? filepath : chalk.dim(filepath))
            : entry.url ? chalk.blue(entry.url) : entry.terminal ? entry.app : chalk.dim('(app only)');
          const status = exists ? ui.tag.ok : ui.tag.fail;
          const tags = Array.isArray(entry.tags) && entry.tags.length
            ? chalk.dim(entry.tags.join(', '))
            : chalk.dim('--');
          const row = [chalk.dim(String(i + 1)), chalk.bold(name), appLabel, pathDisplay];
          if (showGit) row.push(gitCell(filepath));
          row.push(tags, status);
          return row;
        }),
      ];

      ui.table(rows, { header: true });
      ui.blank();
      ui.separator();
      ui.dim(`${entries.length} shortcut${entries.length === 1 ? '' : 's'}${tag ? ` tagged #${tag}` : ' total'}`);
      ui.blank();
    });
}
