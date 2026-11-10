/**
 * color.js -- Color label per shortcut, a dot before the name in the selector and upex ui.
 * Usage: upex color <name>          show it
 *        upex color <name> <value>  set it (palette name, #rrggbb or one emoji)
 *        upex color <name> --clear  remove it
 */

import { loadLinks, setLink, parseColor, colorOf, COLORS } from '../store.js';
import { exactShortcut } from './remove.js';
import * as ui from '../ui.js';

export function registerColor(program) {
  program
    .command('color <name> [value]')
    .description(`Show, set or clear a color label on a shortcut: ${COLORS.join(', ')}, #rrggbb or one emoji (a dot before the name in the selector and upex ui)`)
    .summary('Color label on a shortcut')
    .option('--clear', 'Remove the color label')
    .action((name, value, options) => {
      const links = loadLinks();
      const owner = exactShortcut(name, links, 'color');
      if (!owner) process.exit(1);
      const entry = links[owner];
      if (!options.clear && value === undefined) {
        const now = colorOf(entry);
        ui.info(now ? `${owner}: ${ui.colorLabel(now)}` : `${owner} has no color. Add one: upex color ${owner} blue`);
        return;
      }
      const r = options.clear ? { color: '' } : parseColor(value);
      if (r.error) ui.fail(r.error);
      const { color, ...rest } = entry;
      setLink(owner, r.color ? { ...rest, color: r.color } : rest);
      ui.success(r.color ? `${owner}: ${ui.colorLabel(r.color)}` : `${owner}: color removed`);
    });
}
