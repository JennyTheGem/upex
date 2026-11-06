/**
 * stats.js -- Most used shortcuts and openers over time, from ~/.upex/history.jsonl.
 * Usage: upex stats [--days N] [--all]
 */

import chalk from 'chalk';
import { loadLinks, loadHistory, statsFrom } from '../store.js';
import * as ui from '../ui.js';

const BARS = '▁▂▃▄▅▆▇█';
const TOP = 10;

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
      if (!options.all && !(Number.isInteger(days) && days > 0)) {
        ui.error(`--days needs a whole number above 0, got "${options.days}".`);
        process.exit(1);
      }

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
        const rows = [[chalk.bold('#'), chalk.bold('SHORTCUT'), chalk.bold('OPENS'), chalk.bold('ALL TIME')]];
        stats.shortcuts.slice(0, TOP).forEach(([name, count], i) => {
          const entry = Object.hasOwn(links, name) ? links[name] : null;
          const nameCell = !entry ? chalk.dim(`${name} (removed)`)
            : entry.archived ? chalk.dim(`${name} (archived)`) : chalk.bold(name);
          rows.push([chalk.dim(String(i + 1)), nameCell, String(count), chalk.dim(entry ? String(entry.uses || 0) : '--')]);
        });
        ui.table(rows, { header: true });
        if (stats.shortcuts.length > TOP) ui.dim(`+ ${stats.shortcuts.length - TOP} more`);
        ui.blank();

        if (stats.openers.length) {
          ui.table([[chalk.bold('OPENER'), chalk.bold('OPENS')], ...stats.openers.map(([o, c]) => [o, String(c)])], { header: true });
          ui.blank();
        }
      }

      const peak = Math.max(...stats.perWeek);
      if (peak) {
        ui.info(`${sparkline(stats.perWeek)}  ${chalk.dim(`opens per week, last ${stats.perWeek.length} weeks (peak ${peak})`)}`);
        ui.blank();
      }
      ui.separator();
      ui.dim(`${stats.total} open${stats.total === 1 ? '' : 's'} ${inSpan}, ${history.length} recorded`);
      ui.blank();
    });
}
