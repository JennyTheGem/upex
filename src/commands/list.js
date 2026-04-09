/**
 * list.js -- Show all saved shortcuts.
 * Usage: upex list
 */

import fs from 'node:fs';
import nodePath from 'node:path';
import chalk from 'chalk';
import { loadLinks } from '../store.js';
import * as ui from '../ui.js';

export function registerList(program) {
  program
    .command('list')
    .alias('ls')
    .description('List all saved shortcuts')
    .action(() => {
      const links = loadLinks();
      const entries = Object.entries(links);

      if (entries.length === 0) {
        ui.blank();
        ui.info('No shortcuts saved. Use: upex add <name> [path]');
        ui.blank();
        return;
      }

      ui.heading('Saved Shortcuts');

      const rows = [
        [chalk.bold('#'), chalk.bold('NAME'), chalk.bold('APP'), chalk.bold('PATH'), chalk.bold('STATUS')],
        ...entries.map(([name, entry], i) => {
          const filepath = entry.path;
          const appLabel = entry.app
            ? chalk.cyan(nodePath.basename(entry.app).replace(/\.[^.]+$/, ''))
            : chalk.dim('--');
          const exists = filepath ? fs.existsSync(filepath) : !entry.app;
          const pathDisplay = filepath
            ? (exists ? filepath : chalk.dim(filepath))
            : chalk.dim('(app only)');
          const status = entry.app && !filepath
            ? ui.tag.ok
            : exists ? ui.tag.ok : ui.tag.fail;
          return [
            chalk.dim(String(i + 1)),
            chalk.bold(name),
            appLabel,
            pathDisplay,
            status,
          ];
        }),
      ];

      ui.table(rows, { header: true });
      ui.blank();
      ui.separator();
      ui.dim(`${entries.length} shortcut${entries.length === 1 ? '' : 's'} total`);
      ui.blank();
    });
}
