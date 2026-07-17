/**
 * check.js -- Scan shortcuts and report broken paths.
 * Usage: upex check
 */

import fs from 'node:fs';
import chalk from 'chalk';
import { loadLinks, saveLinks, pruneBroken } from '../store.js';
import * as ui from '../ui.js';

export function registerCheck(program) {
  program
    .command('check')
    .description('Scan all shortcuts and report broken paths')
    .option('--prune', 'Remove shortcuts whose folder path no longer exists')
    .action((options) => {
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
      } else if (options.prune) {
        const { kept, removed } = pruneBroken(links);
        saveLinks(kept);
        ui.warn(`Pruned ${removed.length} broken shortcut${removed.length === 1 ? '' : 's'}.`);
        if (removed.length) ui.dim(`Removed: ${removed.join(', ')}`);
      } else {
        ui.warn(
          `${brokenCount} broken / ${entries.length} total.`
        );
        ui.dim(`Use "upex check --prune" to remove them, or "upex edit <name> <path>" to fix.`);
      }
      ui.blank();
    });
}
