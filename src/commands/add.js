/**
 * add.js -- Register a new shortcut
 * Usage: upex add [name] [path]        folder shortcut (defaults to cwd; no name or "." = folder's name)
 *        upex add <name> <app> --app   app shortcut (the path IS the executable)
 *        upex add <name> "<line>" --cmd  command line, run in a terminal window
 */

import path from 'node:path';
import fs from 'node:fs';
import { setLink, loadLinks, nameError, takenError, checkAliases } from '../store.js';
import { withOpener } from './edit.js';
import * as ui from '../ui.js';

// "work,personal" -> ["work", "personal"]; undefined -> undefined (leave field off).
export function parseTags(value) {
  if (!value) return undefined;
  const tags = value.split(',').map(t => t.trim()).filter(Boolean);
  return tags.length ? tags : undefined;
}

const UNIT = { m: 60000, h: 3600000, d: 86400000, w: 604800000 };

// "30m", "12h", "7d", "2w" -> milliseconds, or null when it isn't one.
export function parseDuration(value) {
  const m = /^(\d+)([mhdw])$/i.exec(String(value ?? '').trim());
  return m && Number(m[1]) > 0 ? Number(m[1]) * UNIT[m[2].toLowerCase()] : null;
}

// Name for `upex add` / `upex add .`: the folder's basename, spaces as dashes.
export const defaultName = (dir) => path.basename(path.resolve(dir)).trim().replace(/\s+/g, '-');

export function registerAdd(program) {
  program
    .command('add [name] [target]')
    .description('Register a shortcut (folder, or an app with --app, a command line with --cmd, or a URL with --url)')
    .summary('Register a folder, app (--app), command (--cmd) or URL (--url)')
    .option('--app', 'Treat <target> as an application to launch')
    .option('--url', 'Treat <target> as a URL to open in the browser')
    .option('--cmd', 'Treat <target> as a command line to run in a terminal window')
    .option('-t, --tag <tags>', 'Comma-separated tags to attach')
    .option('-o, --opener <app>', 'Open this folder shortcut in <app> by default')
    .option('--alias <names>', 'Comma-separated extra names for the shortcut')
    .option('--ttl <time>', 'Archive the shortcut automatically after this long (30m, 12h, 7d, 2w)')
    .action((name, targetPath, options) => {
      if (options.opener && (options.app || options.url || options.cmd)) {
        ui.error('A default opener only applies to folder shortcuts.');
        process.exit(1);
      }

      const ttl = options.ttl === undefined ? null : parseDuration(options.ttl);
      if (options.ttl !== undefined && !ttl) {
        ui.error(`Invalid --ttl "${options.ttl}". Use a number plus m, h, d or w, e.g. 7d.`);
        process.exit(1);
      }

      // No name, or ".", names a folder shortcut after its folder (cwd by default). Others need a real name.
      if (!name || name === '.') name = options.app || options.url || options.cmd ? undefined : defaultName(targetPath || '.');
      const bad = nameError(name);
      if (bad) {
        ui.error(bad);
        process.exit(1);
      }

      const links = loadLinks();
      const taken = takenError(links, name);
      if (taken) {
        ui.warn(taken);
        if (Object.hasOwn(links, name) && !links[name].archived) ui.dim(`Use "upex edit ${name}" to update.`);
        return;
      }

      const { aliases, error } = checkAliases(links, undefined, parseTags(options.alias) || [], name);
      if (error) {
        ui.error(error);
        process.exit(1);
      }
      const tags = parseTags(options.tag);
      const now = Date.now();
      const extra = { ...(tags && { tags }), ...(aliases.length && { aliases }), added: now, ...(ttl && { expires: now + ttl }) };

      // URL shortcut: the positional is a URL, opened in the browser.
      if (options.url) {
        if (!targetPath) {
          ui.error('Provide the URL: upex add <name> <url> --url');
          process.exit(1);
        }
        setLink(name, { url: targetPath, ...extra });
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
        setLink(name, { app: targetPath, ...(options.cmd && { terminal: true }), ...extra });
        ui.success(`Added: ${name} --> ${targetPath}`);
        return;
      }

      // Folder shortcut (defaults to cwd).
      const resolved = targetPath ? path.resolve(targetPath) : process.cwd();
      if (!fs.existsSync(resolved)) {
        ui.error(`Path does not exist: ${resolved}`);
        process.exit(1);
      }
      let entry = { path: resolved, ...extra };
      if (options.opener) entry = withOpener(entry, options.opener);
      if (!entry) process.exit(1);
      setLink(name, entry);
      ui.success(`Added: ${name} --> ${resolved}`);
    });
}
