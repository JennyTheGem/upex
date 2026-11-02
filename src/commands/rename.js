 /**
 * rename.js -- Rename a shortcut key
 * Usage: upex rename <oldName> <newName>
 */

import { renameLink, loadLinks } from '../store.js';
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

      const result = renameLink(oldName, newName);
      if (!result.ok) {
        if (result.reason === 'exists') {
          ui.error(`"${newName}" already exists. Remove it first or pick a different name.`);
        } else {
          ui.error(`Shortcut not found: ${oldName}`);
        }
        return;
      }

      ui.success(`Renamed: ${oldName} --> ${newName}`);
    });
}
