/**
 * config.js -- `upex config [get|set|reset] [key] [value]`: the Settings tab from the command line.
 */

import chalk from 'chalk';
import { loadConfig, saveConfig } from '../store.js';
import { SETTINGS, settingValues, settingShown, readSettings, checkSettings, getInteractiveAppChoices, resetSettings } from '../launcher.js';
import * as ui from '../ui.js';

const fail = (msg) => {
  ui.error(msg);
  process.exit(1);
};

// Allowed values per setting; openers are the selector's row minus copy.
const choices = (key) => (key === 'defaultOpener'
  ? getInteractiveAppChoices().map(c => c.key).filter(k => k !== 'copy')
  : key === 'accent' ? [...SETTINGS.accent, '#rrggbb'] : settingValues(key));

// defList rows: setting, current value bold, options dim. Windows-only ones hide elsewhere.
export const settingRows = (settings = readSettings()) => Object.entries(settings).filter(([k]) => settingShown(k))
  .map(([k, v]) => ({ term: k, text: [[v, chalk.bold], [`· ${choices(k).join(', ')}`, chalk.dim]] }));

export function registerConfig(program) {
  program
    .command('config [action] [key] [value]')
    .description('Show all settings, print one (config get sort), change one (config set terminalLayout tabs) or reset to defaults (config reset [setting])')
    .summary('Show or change settings')
    .action((action, key, value) => {
      const settings = readSettings();
      const known = (k) => Object.hasOwn(settings, k) || fail(checkSettings({ [k]: '' }).error);

      if (!action || action === 'list') {
        ui.heading('Settings');
        for (const line of ui.defList(settingRows(settings))) console.log(line);
        ui.blank();
        for (const line of ui.wrap([['Change one with: upex config set <setting> <value>, back to default: upex config reset [setting]']], ui.cols())) ui.dim(line);
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

      if (action === 'reset') {
        if (key) known(key);
        saveConfig(resetSettings(loadConfig(), key ? [key] : undefined));
        ui.success(key ? `${key} = ${readSettings()[key]} (default)` : 'All settings back to their defaults');
        return;
      }

      fail(`Unknown action "${action}". Use: upex config, config get <setting>, config set <setting> <value>, config reset [setting]`);
    });
}
