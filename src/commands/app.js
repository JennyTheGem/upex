/**
 * app.js -- Manage user-defined openers stored in ~/.upex/config.json.
 * Usage: upex app                     -- list custom apps
 *        upex app <alias> <command>   -- add/update a custom app
 *        upex app <alias> --remove    -- remove a custom app
 */

import chalk from 'chalk';
import { loadConfig, saveConfig } from '../store.js';
import * as ui from '../ui.js';

export function registerApp(program) {
  program
    .command('app [alias] [command]')
    .description('Manage custom openers (e.g. "upex app cursor cursor")')
    .option('--remove', 'Remove the named custom app')
    .action((alias, command, options) => {
      const config = loadConfig();
      const apps = config.apps && typeof config.apps === 'object' ? config.apps : {};

      // No alias: list what's defined.
      if (!alias) {
        const entries = Object.entries(apps);
        if (entries.length === 0) {
          ui.info('No custom apps. Add one: upex app <alias> <command>');
          return;
        }
        ui.heading('Custom Apps');
        ui.table(
          [[chalk.bold('ALIAS'), chalk.bold('COMMAND')], ...entries.map(([a, c]) => [chalk.bold(a), c])],
          { header: true },
        );
        ui.blank();
        return;
      }

      if (options.remove) {
        if (!(alias in apps)) {
          ui.error(`No custom app named "${alias}".`);
          return;
        }
        delete apps[alias];
        saveConfig({ ...config, apps });
        ui.success(`Removed custom app: ${alias}`);
        return;
      }

      if (!command) {
        ui.error('Provide a command: upex app <alias> <command>');
        return;
      }

      apps[alias] = command;
      saveConfig({ ...config, apps });
      ui.success(`Saved custom app: ${alias} --> ${command}`);
      ui.dim(`Use it: upex <shortcut> ${alias}`);
    });
}
