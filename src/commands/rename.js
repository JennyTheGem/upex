 /**
 * rename.js -- Rename a shortcut key
 * Usage: upex rename <oldName> <newName>
 */

import { renameLink, loadLinks, nameError } from '../store.js';
import { resolveName } from '../fuzzy.js';
import * as ui from '../ui.js';

export function registerRename(program) {
  program
    .command('rename <oldName> <newName>')
    .description('Rename a shortcut')
    .action((oldName, newName) => {
      const links = loadLinks();
      const resolved = resolveName(oldName, links);

      if (!resolved) {
        ui.error(`Shortcut not found: ${oldName}`);
        return;
      }

      if (!resolved.exact) {
        ui.warn(`No exact match. Did you mean "${resolved.name}"?`);
        ui.info(`Run: upex rename ${resolved.name} ${newName}`);
        return;
      }

      const bad = nameError(newName);
      if (bad) {
        ui.error(bad);
        return;
      }

      // An alias renames the shortcut it belongs to.
      const result = renameLink(resolved.name, newName);
      if (!result.ok) {
        ui.error(result.message || `Shortcut not found: ${resolved.name}`);
        return;
      }

      ui.success(`Renamed: ${resolved.name} --> ${newName}`);
    });
}
