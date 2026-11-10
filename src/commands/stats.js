/**
 * stats.js -- Most used shortcuts and openers over time, from ~/.upex/history.jsonl.
 * Usage: upex stats [--days N] [--all]
 */

import chalk from 'chalk';
import { loadLinks, loadHistory, statsFrom } from '../store.js';
import { printRows } from '../rows.js';
import * as ui from '../ui.js';

const BARS = '▁▂▃▄▅▆▇█';
export const TOP = 10;

// Right column of a ranked shortcut: removed, or its all-time opens.
export function allTime(links, name) {
  const e = Object.hasOwn(links, name) ? links[name] : null;
  return !e ? 'removed' : `${e.archived ? 'archived, ' : ''}${e.uses || 0} all time`;
}

// One block per week, scaled to the busiest week; an empty week is a dim dot.
export function sparkline(counts) {
  const max = Math.max(...counts);
  return counts.map(c => (c ? BARS[Math.ceil((c / max) * BARS.length) - 1] : chalk.dim('·'))).join('');
}

export function registerStats(program) {
  program
    .command('stats')
    .description('Show the most used shortcuts and openers, and opens per week')
    .summary('Most used shortcuts and openers over time')
    .option('-d, --days <n>', 'Window in days', '30')
    .option('--all', 'Count every recorded open')
    .action((options) => {
      const days = Number(options.days);
      if (!options.all && !(Number.isInteger(days) && days > 0)) ui.fail(`--days needs a whole number above 0, got "${options.days}".`);

      const history = loadHistory();
      if (!history.length) {
        ui.blank();
        ui.info('No opens recorded yet. Stats start counting from now, every open adds to them.');
        ui.blank();
        return;
      }

      const now = Date.now();
      const since = options.all ? 0 : now - days * 86400000;
      const stats = statsFrom(history, { since, now });
      const span = options.all ? 'all time' : `last ${days} day${days === 1 ? '' : 's'}`;
      const inSpan = options.all ? 'in total' : `in the ${span}`;
      ui.heading(`Stats, ${span}`);

      if (!stats.total) {
        ui.info(`No opens ${inSpan}. Try: upex stats --all`);
      } else {
        const links = loadLinks();
        const opens = c => `${c} open${c === 1 ? '' : 's'}`;
        printRows(stats.shortcuts.slice(0, TOP).map(([name, count]) => ({ name, text: opens(count), style: 'plain', right: chalk.dim(allTime(links, name)) })));
        if (stats.shortcuts.length > TOP) ui.dim(`  + ${stats.shortcuts.length - TOP} more`);
        ui.blank();

        if (stats.openers.length) {
          ui.dim('opened with');
          printRows(stats.openers.map(([o, c]) => ({ name: o, text: opens(c), style: 'plain' })));
          ui.blank();
        }
      }

      const peak = Math.max(...stats.perWeek);
      if (peak) {
        ui.info(`  ${sparkline(stats.perWeek)}  ${chalk.dim(`opens per week, last ${stats.perWeek.length} weeks (peak ${peak})`)}`);
        ui.blank();
      }
      ui.separator();
      ui.dim(`${stats.total} open${stats.total === 1 ? '' : 's'} ${inSpan}, ${history.length} recorded`);
      ui.blank();
    });
}
