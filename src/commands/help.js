/**
 * help.js -- Show structured command reference, built from the registered commands.
 */

import chalk from 'chalk';
import * as ui from '../ui.js';

// "<name> [target...] [--tag <tags>]" from a command's arguments and options.
function argsOf(cmd) {
  const args = cmd.registeredArguments.map((a) => {
    const n = a.name() + (a.variadic ? '...' : '');
    return a.required ? `<${n}>` : `[${n}]`;
  });
  const opts = cmd.options.map(o => `[${o.flags.replace(/^-\w, /, '')}]`);
  return [...args, ...opts].join(' ');
}

export function registerHelp(program) {
  program
    .command('help')
    .description('Show all available commands')
    .action(() => {
      ui.heading('upex -- command reference');

      // The default action (no sub-command) has no Command object, so it is listed by hand.
      const help = program.createHelp();
      const rows = [
        ['upex', '[--app <app>]', 'Open the interactive selector and choose shortcut/app'],
        ...help.visibleCommands(program).map(c => [
          [c.name(), ...c.aliases()].join('|'),
          argsOf(c),
          help.subcommandDescription(c),
        ]),
        ['<name>', '[app] [count]', 'Open shortcut (app: vscode, cmd, claude, ...)'],
      ];

      ui.table([
        [chalk.bold('COMMAND'), chalk.bold('ARGS'), chalk.bold('DESCRIPTION')],
        ...rows.map(([cmd, args, desc]) => [chalk.bold(cmd), args || chalk.dim('--'), desc]),
      ], { header: true });
      ui.blank();
      ui.dim('Run "upex <command> --help" for details.');
      ui.blank();
    });
}
