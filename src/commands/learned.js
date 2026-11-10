/**
 * learned.js -- Folders learned from `upex cd` that have no shortcut yet, most used first.
 * Usage: upex learned [--clear]
 */

import { loadLinks, loadVisits, learnedFolders, clearVisits } from '../store.js';
import { printRows, tidyPath } from '../rows.js';
import * as ui from '../ui.js';

export const visitsText = n => `${n || 0} visit${n === 1 ? '' : 's'}`;

export function registerLearned(program) {
  program
    .command('learned')
    .description('List folders learned from upex cd that have no shortcut yet, most used first (upex cd <name> jumps to the top match)')
    .summary('List folders learned from upex cd')
    .option('--clear', 'Forget every learned folder')
    .action((options) => {
      if (options.clear) {
        clearVisits();
        ui.success('Forgot every learned folder.');
        return;
      }
      const now = Date.now();
      const learned = learnedFolders(loadVisits(), loadLinks()).slice(0, 20);
      if (!learned.length) {
        ui.blank();
        ui.info('Nothing learned yet. Folders you visit with: upex cd <path> show up here.');
        ui.blank();
        return;
      }
      ui.heading('Learned folders');
      printRows(learned.map(v => ({
        name: v.name,
        text: tidyPath(v.path),
        right: `${visitsText(v.uses)}, ${ui.span(now - (v.lastUsed || now))} ago`,
      })));
      ui.separator();
      ui.dim('Jump to one: upex cd <name>. Keep one as a shortcut: upex add <name> <path>');
      ui.blank();
    });
}
