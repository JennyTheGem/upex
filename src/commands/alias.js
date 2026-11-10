/**
 * alias.js -- Extra names for a shortcut.
 * Usage: upex alias                     -- list every shortcut with aliases
 *        upex alias <name>              -- show a shortcut's aliases
 *        upex alias <name> <aliases...> -- add aliases
 *        upex alias <name> -r <aliases> -- remove aliases (or --clear to drop all)
 */

import { loadLinks, setLink, activeLinks, aliasesOf, checkAliases } from '../store.js';
import { resolveName } from '../fuzzy.js';
import { printRows } from '../rows.js';
import * as ui from '../ui.js';

export function registerAlias(program) {
  program
    .command('alias [name] [aliases...]')
    .description('List aliases, or add/remove extra names for a shortcut')
    .option('-r, --remove', 'Remove the listed aliases instead of adding')
    .option('--clear', 'Remove all aliases from the shortcut')
    .action((name, aliases, options) => {
      const links = loadLinks();

      if (!name) {
        const rows = Object.entries(activeLinks(links)).filter(([, e]) => aliasesOf(e).length);
        if (!rows.length) {
          ui.info('No aliases yet. Add one: upex alias <name> <alias>');
          return;
        }
        ui.heading('Aliases');
        printRows(rows.map(([n, e]) => ({ name: n, text: aliasesOf(e).join(', '), style: 'plain' })));
        ui.blank();
        return;
      }

      const resolved = resolveName(name, links);
      if (!resolved) ui.fail(`Shortcut not found: ${name}`);
      if (!resolved.exact) {
        ui.warn(`No exact match. Did you mean "${resolved.name}"?`);
        return;
      }
      const owner = resolved.name;
      const entry = links[owner];
      const current = aliasesOf(entry);

      if (!options.clear && !aliases.length) {
        ui.info(current.length ? `${owner}: ${current.join(', ')}` : `${owner} has no aliases.`);
        return;
      }

      let next = [];
      if (options.remove) {
        next = current.filter(a => !aliases.includes(a));
      } else if (!options.clear) {
        const checked = checkAliases(links, owner, [...current, ...aliases]);
        if (checked.error) ui.fail(checked.error);
        next = checked.aliases;
      }

      const { aliases: _old, ...rest } = entry;
      setLink(owner, next.length ? { ...rest, aliases: next } : rest);
      ui.success(`${owner}: ${next.length ? next.join(', ') : '(no aliases)'}`);
    });
}
