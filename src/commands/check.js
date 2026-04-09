/**
 * check.js -- Scan shortcuts and report broken paths.
 * Usage: upex check
 */

import fs from 'node:fs';
import chalk from 'chalk';
import { loadLinks } from '../store.js';
import * as ui from '../ui.js';

export function registerCheck(program) {
  program
    .command('check')
    .description('Scan all shortcuts and report broken paths')
    .action(() => {
      const links = loadLinks();
      const entries = Object.entries(links);

      if (entries.length === 0) {
        ui.info('No shortcuts saved.');
        return;
      }

      ui.heading('Health Check');

      let brokenCount = 0;

      const rows = [
        [chalk.bold('NAME'), chalk.bold('PATH'), chalk.bold('STATUS')],
        ...entries.map(([name, entry]) => {
          const filepath = entry.path;
          if (!filepath) {
            // App-only shortcut, no path to check
            return [
              chalk.bold(name),
              chalk.dim('(app only)'),
              ui.tag.skip,
            ];
          }
          const exists = fs.existsSync(filepath);
          if (!exists) brokenCount++;
          return [
            chalk.bold(name),
            exists ? filepath : chalk.dim(filepath),
            exists ? ui.tag.ok : ui.tag.fail,
          ];
        }),
      ];

      ui.table(rows, { header: true });
      ui.blank();
      ui.separator();

      if (brokenCount === 0) {
        ui.success(`All ${entries.length} shortcut${entries.length === 1 ? '' : 's'} valid.`);
      } else {
        ui.warn(
          `${brokenCount} broken / ${entries.length} total.`
        );
        ui.dim(`Use "upex edit <name> <path>" to fix or "upex remove <name>" to delete.`);
      }
      ui.blank();
    });
}
