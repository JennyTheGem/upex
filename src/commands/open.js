/**
 * open.js -- Open a shortcut path or launch it in an app.
 * Default command: upex <name> [app]
 * Hidden command: upex __resolve <name>
 */

import fs from 'node:fs';
import chalk from 'chalk';
import { loadLinks } from '../store.js';
import { resolveName } from '../fuzzy.js';
import { launchApp, launchExecutable } from '../launcher.js';
import * as ui from '../ui.js';

/**
 * Register the hidden __resolve command (for shell cd integration).
 */
export function registerResolve(program) {
  program
    .command('__resolve <name>', { hidden: true })
    .description('(internal) Resolve a shortcut name to its path')
    .action((name) => {
      const links = loadLinks();
      const resolved = resolveName(name, links);

      if (!resolved) {
        process.exit(1);
      }

      const entry = links[resolved.name];
      const targetPath = entry.path;

      if (!targetPath || !fs.existsSync(targetPath)) {
        process.exit(1);
      }

      // Print raw path to stdout (no formatting) -- consumed by shell function
      process.stdout.write(targetPath);
    });
}

/**
 * Handle the default open/launch action.
 */
export async function handleOpen(name, app) {
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

  const shortcutName = resolved.name;
  const entry = links[shortcutName];

  // ── App shortcut: launch stored executable directly ──
  if (entry.app && !app) {
    const result = launchExecutable(entry.app);

    if (!result.ok) {
      ui.error(result.message);
      process.exit(1);
    }

    if (!resolved.exact) {
      ui.dim(`matched "${name}" --> "${shortcutName}"`);
    }

    ui.heading(shortcutName);
    console.log(`  ${chalk.dim('app')}    ${chalk.bold(result.displayName)}`);
    if (entry.path) {
      console.log(`  ${chalk.dim('path')}   ${entry.path}`);
    }
    ui.blank();
    return;
  }

  // ── Folder shortcut: open in specified or default opener ──
  const targetPath = entry.path;

  if (!targetPath) {
    ui.warn(`No folder path stored for "${shortcutName}".`);
    ui.dim(`This is an app shortcut. Run without an opener: upex ${shortcutName}`);
    process.exit(1);
  }

  if (!fs.existsSync(targetPath)) {
    ui.warn(`Path does not exist: ${targetPath}`);
    ui.dim(`Use "upex edit ${shortcutName} <newPath>" to update.`);
    process.exit(1);
  }

  const appKey = app || 'explorer';
  const result = launchApp(appKey, targetPath);

  if (!result.ok) {
    ui.error(result.message);
    process.exit(1);
  }

  // -- Structured output card --
  if (!resolved.exact) {
    ui.dim(`matched "${name}" --> "${shortcutName}"`);
  }

  ui.heading(shortcutName);

  const appLabel = result.displayName || appKey;
  console.log(`  ${chalk.dim('app')}    ${chalk.bold(appLabel)}`);
  console.log(`  ${chalk.dim('path')}   ${targetPath}`);
  ui.blank();
}
