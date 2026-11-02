/**
 * add.js -- Register a new shortcut
 * Usage: upex add <name> [path]        folder shortcut (defaults to cwd)
 *        upex add <name> <app> --app   app shortcut (the path IS the executable)
 *        upex add <name> "<line>" --cmd  command line, run in a terminal window
 */

import path from 'node:path';
import fs from 'node:fs';
import { setLink, linkExists, nameError } from '../store.js';
import { withOpener } from './edit.js';
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
    .description('Register a shortcut (folder, or an app with --app, a command line with --cmd, or a URL with --url)')
    .summary('Register a folder, app (--app), command (--cmd) or URL (--url)')
    .option('--app', 'Treat <target> as an application to launch')
    .option('--url', 'Treat <target> as a URL to open in the browser')
    .option('--cmd', 'Treat <target> as a command line to run in a terminal window')
    .option('-t, --tag <tags>', 'Comma-separated tags to attach')
    .option('-o, --opener <app>', 'Open this folder shortcut in <app> by default')
    .action((name, targetPath, options) => {
      if (options.opener && (options.app || options.url || options.cmd)) {
        ui.error('A default opener only applies to folder shortcuts.');
        process.exit(1);
      }

      const bad = nameError(name);
      if (bad) {
        ui.error(bad);
        process.exit(1);
      }

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
      // --cmd: a command line run in a terminal window instead.
      if (options.app || options.cmd) {
        if (!targetPath) {
          ui.error(options.cmd
            ? 'Provide the command line in quotes: upex add <name> "<command>" --cmd'
            : 'Provide the app path or command: upex add <name> <app> --app');
          process.exit(1);
        }
        setLink(name, { app: targetPath, ...(options.cmd && { terminal: true }), ...(tags && { tags }) });
        ui.success(`Added: ${name} --> ${targetPath}`);
        return;
      }

      // Folder shortcut (defaults to cwd).
      const resolved = targetPath ? path.resolve(targetPath) : process.cwd();
      if (!fs.existsSync(resolved)) {
        ui.error(`Path does not exist: ${resolved}`);
        process.exit(1);
      }
      let entry = { path: resolved, ...(tags && { tags }) };
      if (options.opener) entry = withOpener(entry, options.opener);
      if (!entry) process.exit(1);
      setLink(name, entry);
      ui.success(`Added: ${name} --> ${resolved}`);
    });
}
