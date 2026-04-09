/**
 * add.js — Register a new shortcut
 * Usage: upex add <name> [path]          — folder shortcut
 *        upex add <name> --app <exe>     — app shortcut (launches an executable)
 *        upex add <name> [path] --app <exe> — both
 */

import path from 'node:path';
import fs from 'node:fs';
import { setLink, linkExists } from '../store.js';
import * as ui from '../ui.js';

export function registerAdd(program) {
  program
    .command('add <name> [path]')
    .description('Register a shortcut (folder path or app executable)')
    .option('--app <exe>', 'Path or command of an application to launch')
    .action((name, targetPath, options) => {
      if (linkExists(name)) {
        ui.warn(`"${name}" already exists. Use "upex edit ${name}" to update.`);
        return;
      }

      const entry = {};

      // --app: store application executable
      if (options.app) {
        entry.app = options.app;
      }

      // Folder path (only default to cwd when no --app given)
      if (targetPath) {
        const resolved = path.resolve(targetPath);
        if (!fs.existsSync(resolved)) {
          ui.error(`Path does not exist: ${resolved}`);
          process.exit(1);
        }
        entry.path = resolved;
      } else if (!options.app) {
        // No --app and no explicit path → default to cwd
        entry.path = process.cwd();
      }

      if (!entry.path && !entry.app) {
        ui.error('Provide a folder path or --app <exe>.');
        process.exit(1);
      }

      setLink(name, entry);

      if (entry.app && entry.path) {
        ui.success(`Added: ${name}`);
        ui.dim(`  app   ${entry.app}`);
        ui.dim(`  path  ${entry.path}`);
      } else if (entry.app) {
        ui.success(`Added: ${name} --> ${entry.app}`);
      } else {
        ui.success(`Added: ${name} --> ${entry.path}`);
      }
    });
}
