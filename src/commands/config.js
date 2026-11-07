/**
 * config.js -- `upex config [get|set] [key] [value]`: the Settings tab from the command line.
 */

import chalk from 'chalk';
import { loadConfig, saveConfig } from '../store.js';
import { SETTINGS, readSettings, checkSettings, getInteractiveAppChoices } from '../launcher.js';
import * as ui from '../ui.js';

const fail = (msg) => {
  ui.error(msg);
  process.exit(1);
};

// Allowed values per setting; openers are the selector's row minus copy.
const choices = (key) => (key === 'defaultOpener'
  ? getInteractiveAppChoices().map(c => c.key).filter(k => k !== 'copy')
  : SETTINGS[key]);

export function registerConfig(program) {
  program
    .command('config [action] [key] [value]')
    .description('Show all settings, print one (config get sort) or change one (config set terminalLayout tabs)')
    .summary('Show or change settings')
    .action((action, key, value) => {
      const settings = readSettings();
      const known = (k) => Object.hasOwn(settings, k) || fail(checkSettings({ [k]: '' }).error);

      if (!action || action === 'list') {
        ui.heading('upex settings');
        ui.table([
          [chalk.bold('SETTING'), chalk.bold('VALUE'), chalk.bold('OPTIONS')],
          ...Object.entries(settings).map(([k, v]) => [k, chalk.bold(v), chalk.dim(choices(k).join(', '))]),
        ], { header: true });
        ui.blank();
        ui.dim('Change one with: upex config set <setting> <value>');
        ui.blank();
        return;
      }

      if (action === 'get') {
        if (!key) fail('Usage: upex config get <setting>');
        known(key);
        // Raw value only, for scripts.
        console.log(settings[key]);
        return;
      }

      if (action === 'set') {
        if (!key || value === undefined) fail('Usage: upex config set <setting> <value>');
        known(key);
        const { next, error } = checkSettings({ [key]: value });
        if (error) fail(error);
        saveConfig({ ...loadConfig(), ...next });
        ui.success(`${key} = ${next[key]}`);
        return;
      }

      fail(`Unknown action "${action}". Use: upex config, config get <setting>, config set <setting> <value>`);
    });
}
