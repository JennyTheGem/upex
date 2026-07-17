/**
 * add.js — Register a new shortcut
 * Usage: upex add <name> [path]        — folder shortcut (defaults to cwd)
 *        upex add <name> <app> --app   — app shortcut (the path IS the executable)
 */

import path from 'node:path';
import fs from 'node:fs';
import { setLink, linkExists } from '../store.js';
import * as ui from '../ui.js';

// "work,personal" -> ["work", "personal"]; undefined -> undefined (leave field off).
export function parseTags(value) {
  if (!value) return undefined;
  const tags = value.split(',').map(t => t.trim()).filter(Boolean);
  return tags.length ? tags : undefined;
}

export function registerAdd(program) {
  program
    .command('add <name> [target]')
    .description('Register a shortcut (folder, or an app with --app, or a URL with --url)')
    .option('--app', 'Treat <target> as an application to launch')
    .option('--url', 'Treat <target> as a URL to open in the browser')
    .option('-t, --tag <tags>', 'Comma-separated tags to attach')
    .action((name, targetPath, options) => {
      if (linkExists(name)) {
        ui.warn(`"${name}" already exists. Use "upex edit ${name}" to update.`);
        return;
      }

      const tags = parseTags(options.tag);

      // URL shortcut: the positional is a URL, opened in the browser.
      if (options.url) {
        if (!targetPath) {
          ui.error('Provide the URL: upex add <name> <url> --url');
          process.exit(1);
        }
        setLink(name, { url: targetPath, ...(tags && { tags }) });
        ui.success(`Added: ${name} --> ${targetPath}`);
        return;
      }

      // App shortcut: the positional is the executable/command, stored raw.
      if (options.app) {
        if (!targetPath) {
          ui.error('Provide the app path or command: upex add <name> <app> --app');
          process.exit(1);
        }
        setLink(name, { app: targetPath, ...(tags && { tags }) });
        ui.success(`Added: ${name} --> ${targetPath}`);
        return;
      }

      // Folder shortcut (defaults to cwd).
      const resolved = targetPath ? path.resolve(targetPath) : process.cwd();
      if (!fs.existsSync(resolved)) {
        ui.error(`Path does not exist: ${resolved}`);
        process.exit(1);
      }
      setLink(name, { path: resolved, ...(tags && { tags }) });
      ui.success(`Added: ${name} --> ${resolved}`);
    });
}
