/**
 * remove.js -- Delete a saved shortcut.
 * Usage: upex remove <name>
 */

import { removeLink, loadLinks } from '../store.js';
import { resolveName } from '../fuzzy.js';
import * as ui from '../ui.js';

export function registerRemove(program) {
  program
    .command('remove <name>')
    .alias('rm')
    .description('Remove a saved shortcut')
    .action((name) => {
      const links = loadLinks();
      const resolved = resolveName(name, links);

      if (!resolved) {
        ui.error(`Shortcut not found: ${name}`);
        return;
      }

      if (!resolved.exact) {
        ui.warn(`No exact match. Did you mean "${resolved.name}"?`);
        ui.info(`Run: upex remove ${resolved.name}`);
        return;
      }

      const entry = links[name];
      removeLink(name);
      ui.success(`Removed: ${name} --> ${entry.path || entry.app}`);
    });
}

