/**
 * edit.js -- Update the target of an existing shortcut.
 * Usage: upex edit <name> [target]
 *   folder shortcut: target is the new path (defaults to cwd)
 *   URL / app shortcut: target is the new URL / command (required)
 */

import path from 'node:path';
import fs from 'node:fs';
import { setLink, loadLinks, targetField } from '../store.js';
import { resolveName } from '../fuzzy.js';
import * as ui from '../ui.js';

export function registerEdit(program) {
  program
    .command('edit <name> [target]')
    .description('Update a shortcut\'s path (or URL / app command)')
    .action((name, target) => {
      const links = loadLinks();
      const resolved = resolveName(name, links);

      if (!resolved) {
        ui.error(`Shortcut not found: ${name}`);
        return;
      }

      if (!resolved.exact) {
        ui.warn(`No exact match. Did you mean "${resolved.name}"?`);
        ui.info(`Run: upex edit ${resolved.name}${target ? ' ' + target : ''}`);
        return;
      }

      const entry = links[name];
      const field = targetField(entry);
      let value = target;

      if (field === 'path') {
        value = target ? path.resolve(target) : process.cwd();
        if (!fs.existsSync(value)) {
          ui.error(`Path does not exist: ${value}`);
          process.exit(1);
        }
      } else if (!value) {
        ui.error(`Provide the new ${field === 'url' ? 'URL' : 'app path or command'}: upex edit ${name} <${field}>`);
        process.exit(1);
      }

      setLink(name, { ...entry, [field]: value });
      ui.success(`Updated: ${name}`);
      ui.dim(`Old: ${entry[field] || '(none)'}`);
      ui.dim(`New: ${value}`);
    });
}
