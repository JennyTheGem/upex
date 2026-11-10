/**
 * edit.js -- Update the target of an existing shortcut.
 * Usage: upex edit <name> [target] [--opener <app> | --no-opener]
 *   folder shortcut: target is the new path (defaults to cwd)
 *   URL / app shortcut: target is the new URL / command (required)
 */

import path from 'node:path';
import fs from 'node:fs';
import { setLink, loadLinks, targetField } from '../store.js';
import { resolveName } from '../fuzzy.js';
import { openerKey } from '../launcher.js';
import * as ui from '../ui.js';

// Entry with the opener set (string) or cleared (false); null after printing why not.
export function withOpener(entry, opener) {
  const { opener: _old, ...rest } = entry;
  if (opener === false) return rest;
  if (!entry.path) {
    ui.error('A default opener only applies to folder shortcuts.');
    return null;
  }
  const key = openerKey(opener);
  if (!key) {
    ui.error(`Unknown opener "${opener}". Add custom ones with "upex app".`);
    return null;
  }
  return { ...rest, opener: key };
}

export function registerEdit(program) {
  program
    .command('edit <name> [target]')
    .description('Update a shortcut\'s path (or URL / app command) or its default opener')
    .summary('Update a shortcut\'s path, URL, command or opener')
    .option('-o, --opener <app>', 'Open this folder shortcut in <app> by default')
    .option('--no-opener', 'Clear the default opener')
    .action((name, target, options) => {
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

      // An alias edits the shortcut it belongs to.
      name = resolved.name;
      const entry = links[name];
      const field = targetField(entry);

      // Only the opener changes: leave the target alone.
      if (options.opener !== undefined && !target) {
        const next = withOpener(entry, options.opener);
        if (!next) process.exit(1);
        setLink(name, next);
        ui.success(next.opener ? `${name} now opens in ${next.opener}` : `${name}: default opener cleared`);
        return;
      }

      let value = target;

      if (field === 'path') {
        value = target ? path.resolve(target) : process.cwd();
        if (!fs.existsSync(value)) ui.fail(`Path does not exist: ${value}`);
      } else if (!value) {
        ui.fail(`Provide the new ${field === 'url' ? 'URL' : 'app path or command'}: upex edit ${name} <${field}>`);
      }

      const next = options.opener === undefined ? entry : withOpener(entry, options.opener);
      if (!next) process.exit(1);
      setLink(name, { ...next, [field]: value });
      ui.success(`Updated: ${name}`);
      ui.dim(`Old: ${entry[field] || '(none)'}`);
      ui.dim(`New: ${value}`);
    });
}
