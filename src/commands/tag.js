/**
 * tag.js -- Manage tags on shortcuts and open a whole tag group.
 * Usage: upex tag                    -- list all tags with counts
 *        upex tag <name>             -- show a shortcut's tags
 *        upex tag <name> <tags...>   -- add tags
 *        upex tag <name> -r <tags..> -- remove tags (or --clear to drop all)
 *        upex open <tag>             -- open every shortcut carrying <tag>
 */

import { loadLinks, setLink, activeLinks } from '../store.js';
import { resolveName } from '../fuzzy.js';
import { handleOpen } from './open.js';
import { printRows } from '../rows.js';
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
    .option('--json', 'Print JSON: { tag: count }, or { name, tags } for a shortcut')
    .action((name, tags, options) => {
      const all = loadLinks();
      const links = activeLinks(all);

      // No name: list every tag with a count.
      if (!name) {
        const counts = allTags(links);
        const entries = Object.entries(counts);
        if (options.json) return ui.json(counts);
        if (!entries.length) {
          ui.info('No tags yet. Add some: upex tag <name> <tag>');
          return;
        }
        ui.heading('Tags');
        printRows(entries.map(([t, c]) => ({ name: `#${t}`, text: `${c} shortcut${c === 1 ? '' : 's'}`, style: 'dim' })));
        ui.blank();
        return;
      }

      const resolved = resolveName(name, all);
      if (!resolved) {
        if (options.json) ui.json({ error: `Shortcut not found: ${name}` });
        else ui.error(`Shortcut not found: ${name}`);
        process.exit(1);
      }
      const entry = links[resolved.name];
      const current = entry.tags || [];

      // Show tags when none are supplied and no mutation flag is set.
      if (!options.clear && tags.length === 0) {
        if (options.json) return ui.json({ name: resolved.name, tags: current });
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
      if (options.json) return ui.json({ name: resolved.name, tags: next });
      ui.success(`${resolved.name}: ${next.length ? next.join(', ') : '(no tags)'}`);
    });
}

export function registerOpenGroup(program) {
  program
    .command('open <tag>')
    .description('Open every shortcut carrying <tag> in its default opener')
    .summary('Open every shortcut tagged <tag>')
    .action(async (tag) => {
      const links = activeLinks(loadLinks());
      const matches = Object.keys(links).filter(n => (links[n].tags || []).includes(tag));

      if (!matches.length) {
        ui.warn(`No shortcuts tagged "${tag}".`);
        const tags = Object.keys(allTags(links));
        if (tags.length) ui.dim(`Available tags: ${tags.join(', ')}`);
        process.exit(1);
      }

      ui.dim(`Opening ${matches.length} shortcut${matches.length === 1 ? '' : 's'} tagged #${tag}: ${matches.join(', ')}`);
      for (const shortcut of matches) {
        await handleOpen(shortcut, undefined, 1, '', { here: false });
      }
    });
}
