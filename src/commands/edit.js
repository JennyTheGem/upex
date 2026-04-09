/**
 * edit.js -- Update the path for an existing shortcut.
 * Usage: upex edit <name> [newPath]
 */

import path from 'node:path';
import fs from 'node:fs';
import { setLink, loadLinks } from '../store.js';
import { resolveName } from '../fuzzy.js';
import * as ui from '../ui.js';

export function registerEdit(program) {
  program
    .command('edit <name> [newPath]')
    .description('Update the path for an existing shortcut')
    .action((name, newPath) => {
      const links = loadLinks();
      const resolved = resolveName(name, links);

      if (!resolved) {
        ui.error(`Shortcut not found: ${name}`);
        return;
      }

      if (!resolved.exact) {
        ui.warn(`No exact match. Did you mean "${resolved.name}"?`);
        ui.info(`Run: upex edit ${resolved.name}${newPath ? ' ' + newPath : ''}`);
        return;
      }

      const targetPath = newPath ? path.resolve(newPath) : process.cwd();

      if (!fs.existsSync(targetPath)) {
        ui.error(`Path does not exist: ${targetPath}`);
        process.exit(1);
      }

      const entry = links[name];
      const oldPath = entry.path || '(none)';
      // Preserve existing app field when editing the path
      const updated = { ...entry, path: targetPath };
      setLink(name, updated);
      ui.success(`Updated: ${name}`);
      ui.dim(`Old: ${oldPath}`);
      ui.dim(`New: ${targetPath}`);
    });
}
