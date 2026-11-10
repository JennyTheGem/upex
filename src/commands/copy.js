/**
 * copy.js -- Copy a shortcut's path to the clipboard.
 * Usage: upex copy <name>
 */

import { loadLinks } from '../store.js';
import { copyToClipboard } from '../launcher.js';
import { resolveName, didYouMean } from '../fuzzy.js';
import * as ui from '../ui.js';

export function registerCopy(program) {
  program
    .command('copy <name>')
    .description('Copy shortcut path to clipboard')
    .action((name) => {
      const links = loadLinks();
      const resolved = resolveName(name, links);

      if (!resolved) ui.fail(`Shortcut not found: ${name}`, didYouMean(name, links));

      const entry = links[resolved.name];
      const targetPath = entry.path || entry.url;

      if (!targetPath) {
        ui.warn(`"${resolved.name}" is an app shortcut with no folder path.`);
        if (entry.app) {
          ui.dim(`App executable: ${entry.app}`);
        }
        process.exit(1);
      }

      try {
        copyToClipboard(targetPath);
      } catch (err) {
        ui.fail(`Failed to copy: ${err.message}`);
      }

      if (!resolved.exact) {
        ui.dim(`matched "${name}" --> "${resolved.name}"`);
      }

      ui.success(`Copied: ${targetPath}`);
    });
}

