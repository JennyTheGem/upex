/**
 * copy.js -- Copy a shortcut's path to the clipboard.
 * Usage: upex copy <name>
 */

import clipboard from 'clipboardy';
import { loadLinks } from '../store.js';
import { resolveName } from '../fuzzy.js';
import * as ui from '../ui.js';

export function registerCopy(program) {
  program
    .command('copy <name>')
    .description('Copy shortcut path to clipboard')
    .action((name) => {
      const links = loadLinks();
      const resolved = resolveName(name, links);

      if (!resolved) {
        ui.error(`Shortcut not found: ${name}`);
        const names = Object.keys(links);
        if (names.length > 0) {
          ui.dim(`Available: ${names.join(', ')}`);
        }
        process.exit(1);
      }

      const entry = links[resolved.name];
      const targetPath = entry.path || entry.url;

      if (!targetPath) {
        ui.warn(`"${resolved.name}" is an app shortcut with no folder path.`);
        if (entry.app) {
          ui.dim(`App executable: ${entry.app}`);
        }
        process.exit(1);
      }

      clipboard.writeSync(targetPath);

      if (!resolved.exact) {
        ui.dim(`matched "${name}" --> "${resolved.name}"`);
      }

      ui.success(`Copied: ${targetPath}`);
    });
}

