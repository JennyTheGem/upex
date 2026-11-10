/**
 * remove.js -- Delete or archive a saved shortcut, and restore archived ones.
 * Usage: upex remove <name> [--archive]
 *        upex restore <name>
 */

import { removeLink, loadLinks, setLink, nameOwner, unarchived } from '../store.js';
import { resolveName } from '../fuzzy.js';
import * as ui from '../ui.js';

// Exact shortcut for `name` (archived ones too, so they can be deleted), or null after printing why.
export function exactShortcut(name, links, verb) {
  const owner = nameOwner(links, name);
  if (owner) return owner;
  const resolved = resolveName(name, links);
  if (!resolved) {
    ui.error(`Shortcut not found: ${name}`);
  } else {
    ui.warn(`No exact match. Did you mean "${resolved.name}"?`);
    ui.info(`Run: upex ${verb} ${resolved.name}`);
  }
  return null;
}

export function registerRemove(program) {
  program
    .command('remove <name>')
    .alias('rm')
    .description('Remove a saved shortcut (--archive hides it but keeps it restorable)')
    .summary('Remove a shortcut (--archive to hide it)')
    .option('--archive', 'Hide the shortcut instead of deleting it (upex restore brings it back)')
    .action((name, options) => {
      const links = loadLinks();
      const owner = exactShortcut(name, links, options.archive ? 'rm --archive' : 'rm');
      if (!owner) return;
      const entry = links[owner];

      if (options.archive) {
        if (entry.archived) {
          ui.info(`${owner} is already archived.`);
          return;
        }
        setLink(owner, { ...entry, archived: true });
        ui.success(`Archived: ${owner}`);
        ui.dim(`Restore it with: upex restore ${owner}`);
        return;
      }

      removeLink(owner);
      ui.success(`Removed: ${owner} --> ${entry.path || entry.app || entry.url}`);
    });

  program
    .command('restore <name>')
    .description('Bring back an archived shortcut (see them with: upex ls --archived)')
    .summary('Bring back an archived shortcut')
    .action((name) => {
      const links = loadLinks();
      const resolved = resolveName(name, links, true);
      if (!resolved) ui.fail(nameOwner(links, name) ? `${nameOwner(links, name)} is not archived.` : `No archived shortcut: ${name}`);
      if (!resolved.exact) {
        ui.warn(`No exact match. Did you mean "${resolved.name}"?`);
        ui.info(`Run: upex restore ${resolved.name}`);
        return;
      }
      setLink(resolved.name, unarchived(links[resolved.name]));
      ui.success(`Restored: ${resolved.name}`);
    });
}
