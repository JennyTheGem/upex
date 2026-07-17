/**
 * tag.js -- Manage tags on shortcuts and open a whole tag group.
 * Usage: upex tag                    -- list all tags with counts
 *        upex tag <name>             -- show a shortcut's tags
 *        upex tag <name> <tags...>   -- add tags
 *        upex tag <name> -r <tags..> -- remove tags (or --clear to drop all)
 *        upex open <tag>             -- open every shortcut carrying <tag>
 */

import chalk from 'chalk';
import { loadLinks, setLink } from '../store.js';
import { resolveName } from '../fuzzy.js';
import { handleOpen } from './open.js';
import * as ui from '../ui.js';

function allTags(links) {
  const counts = {};
  for (const entry of Object.values(links)) {
    for (const t of entry.tags || []) counts[t] = (counts[t] || 0) + 1;
  }
  return counts;
}

export function registerTag(program) {
  program
    .command('tag [name] [tags...]')
    .description('List tags, or add/remove tags on a shortcut')
    .option('-r, --remove', 'Remove the listed tags instead of adding')
    .option('--clear', 'Remove all tags from the shortcut')
    .action((name, tags, options) => {
      const links = loadLinks();

      // No name: list every tag with a count.
      if (!name) {
        const counts = allTags(links);
        const entries = Object.entries(counts);
        if (!entries.length) {
          ui.info('No tags yet. Add some: upex tag <name> <tag>');
          return;
        }
        ui.heading('Tags');
        ui.table(
          [[chalk.bold('TAG'), chalk.bold('COUNT')], ...entries.map(([t, c]) => [chalk.cyan(t), String(c)])],
          { header: true },
        );
        ui.blank();
        return;
      }

      const resolved = resolveName(name, links);
      if (!resolved) {
        ui.error(`Shortcut not found: ${name}`);
        process.exit(1);
      }
      const entry = links[resolved.name];
      const current = entry.tags || [];

      // Show tags when none are supplied and no mutation flag is set.
      if (!options.clear && tags.length === 0) {
        ui.info(current.length ? `${resolved.name}: ${current.join(', ')}` : `${resolved.name} has no tags.`);
        return;
      }

      let next;
      if (options.clear) {
        next = [];
      } else if (options.remove) {
        next = current.filter(t => !tags.includes(t));
      } else {
        next = [...new Set([...current, ...tags])];
      }

      const updated = { ...entry };
      if (next.length) updated.tags = next; else delete updated.tags;
      setLink(resolved.name, updated);
      ui.success(`${resolved.name}: ${next.length ? next.join(', ') : '(no tags)'}`);
    });
}

export function registerOpenGroup(program) {
  program
    .command('open <tag>')
    .description('Open every shortcut carrying <tag> in its default opener')
    .action(async (tag) => {
      const links = loadLinks();
      const matches = Object.keys(links).filter(n => (links[n].tags || []).includes(tag));

      if (!matches.length) {
        ui.warn(`No shortcuts tagged "${tag}".`);
        const tags = Object.keys(allTags(links));
        if (tags.length) ui.dim(`Available tags: ${tags.join(', ')}`);
        process.exit(1);
      }

      ui.dim(`Opening ${matches.length} shortcut${matches.length === 1 ? '' : 's'} tagged #${tag}: ${matches.join(', ')}`);
      for (const shortcut of matches) {
        await handleOpen(shortcut, undefined, 1, '', { batch: true });
      }
    });
}
