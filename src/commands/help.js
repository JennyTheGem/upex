/**
 * help.js -- Show structured command reference.
 */

import chalk from 'chalk';
import * as ui from '../ui.js';

const COMMANDS = [
  ['upex',      '[--app <app>]',          'Open the interactive selector and choose shortcut/app'],
  ['add',       '<name> [path] [--app]',  'Register a folder or app shortcut'],
  ['list',      '[tag]',                  'Show all saved shortcuts (alias: ls)'],
  ['remove',    '<name>',                 'Delete a shortcut (alias: rm)'],
  ['rename',    '<old> <new>',            'Rename a shortcut'],
  ['edit',      '<name> [path]',          'Update a shortcut path'],
  ['copy',      '<name>',                 'Copy shortcut path to clipboard'],
  ['go',        '<name> [start...]',      'cd via wrapper; extra args run as a command there'],
  ['cmd',       '<name> [count] [start]', 'Open N terminals, optionally running a command'],
  ['run',       '<name> [script]',        'Run a package.json script in a terminal'],
  ['last',      '',                        'Reopen the most recent shortcut (alias: upex -)'],
  ['tag',       '<name> [tags...]',       'List/add/remove tags (-r to remove)'],
  ['open',      '<tag>',                  'Open every shortcut carrying a tag'],
  ['ws',        '[name|add|rm] ...',      'Open or manage workspaces'],
  ['export',    '[file]',                 'Export shortcuts + config as JSON'],
  ['import',    '<file> [--replace]',     'Import a bundle (merge or replace)'],
  ['app',       '[alias] [command]',      'Manage custom openers'],
  ['check',     '[--prune]',              'Report (or remove) broken paths'],
  ['completion','[shell]',                'Print a shell completion script'],
  ['setup',     '[cmd]',                  'Shell integration ("setup cmd" installs the cmd wrapper)'],
  ['help',      '',                        'Show this reference'],
  ['<name>',    '[app]',                  'Open shortcut (app: vscode, cmd, ...)'],
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
