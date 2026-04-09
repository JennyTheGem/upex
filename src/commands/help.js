/**
 * help.js -- Show structured command reference.
 */

import chalk from 'chalk';
import * as ui from '../ui.js';

const COMMANDS = [
  ['upex',     '[--app <app>]',          'Open the interactive selector and choose shortcut/app'],
  ['add',      '<name> [path] [--app]',  'Register a folder or app shortcut'],
  ['list',     '',                        'Show all saved shortcuts (alias: ls)'],
  ['remove',   '<name>',                 'Delete a shortcut (alias: rm)'],
  ['rename',   '<old> <new>',            'Rename a shortcut'],
  ['edit',     '<name> [path]',          'Update a shortcut path'],
  ['copy',     '<name>',                 'Copy shortcut path to clipboard'],
  ['check',    '',                        'Report broken paths'],
  ['setup',    '',                        'Shell integration instructions'],
  ['help',     '',                        'Show this reference'],
  ['<name>',   '[app]',                  'Open shortcut (app: vscode, cmd, ...)'],
];

export function registerHelp(program) {
  program
    .command('help')
    .description('Show all available commands')
    .action(() => {
      ui.heading('upex -- command reference');

      const rows = [
        [chalk.bold('COMMAND'), chalk.bold('ARGS'), chalk.bold('DESCRIPTION')],
        ...COMMANDS.map(([cmd, args, desc]) => [
          chalk.bold(cmd),
          args || chalk.dim('--'),
          desc,
        ]),
      ];

      ui.table(rows, { header: true });
      ui.blank();
      ui.dim('Run "upex <command> --help" for details.');
      ui.blank();
    });
}
