/**
 * run.js -- Run a package.json script in a terminal at a shortcut's folder.
 * Usage: upex run <name> [script]
 *   upex run velora          -- list available scripts
 *   upex run velora dev      -- open a terminal running "<pm> run dev" at velora
 */

import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { loadLinks } from '../store.js';
import { resolveName } from '../fuzzy.js';
import { handleOpen } from './open.js';
import * as ui from '../ui.js';

// Pick a package manager from the lockfile present in the folder (npm default).
function detectPm(dir) {
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(dir, 'bun.lockb')) || fs.existsSync(path.join(dir, 'bun.lock'))) return 'bun';
  return 'npm';
}

function readScripts(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
    return pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  } catch {
    return null;
  }
}

export function registerRun(program) {
  program
    .command('run <name> [script]')
    .description('Run a package.json script in a terminal at the shortcut folder')
    .summary('Run a package.json script in a terminal')
    .action((name, script) => {
      const links = loadLinks();
      const resolved = resolveName(name, links);
      if (!resolved) {
        ui.error(`Shortcut not found: ${name}`);
        process.exit(1);
      }

      const dir = links[resolved.name].path;
      if (!dir || !fs.existsSync(dir)) {
        ui.error(`No valid folder for "${resolved.name}".`);
        process.exit(1);
      }

      const scripts = readScripts(dir);
      if (!scripts) {
        ui.error(`No package.json in ${dir}`);
        process.exit(1);
      }

      const pm = detectPm(dir);

      // No script given: list what's available.
      if (!script) {
        const names = Object.keys(scripts);
        if (!names.length) {
          ui.info('No scripts defined in package.json.');
          return;
        }
        ui.heading(`Scripts (${pm}) -- ${resolved.name}`);
        ui.table(
          [[chalk.bold('SCRIPT'), chalk.bold('COMMAND')], ...names.map(n => [chalk.cyan(n), chalk.dim(scripts[n])])],
          { header: true },
        );
        ui.blank();
        ui.dim(`Run one: upex run ${resolved.name} <script>`);
        return;
      }

      if (!Object.hasOwn(scripts, script)) {
        ui.error(`No "${script}" script in ${resolved.name}. Available: ${Object.keys(scripts).join(', ') || '(none)'}`);
        process.exit(1);
      }

      return handleOpen(resolved.name, 'cmd', 1, `${pm} run ${script}`);
    });
}
