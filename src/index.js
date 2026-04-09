/**
 * index.js — Main entry point for the upex CLI
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { registerAdd } from './commands/add.js';
import { registerList } from './commands/list.js';
import { registerRemove } from './commands/remove.js';
import { registerRename } from './commands/rename.js';
import { registerEdit } from './commands/edit.js';
import { registerCheck } from './commands/check.js';
import { registerResolve, handleOpen } from './commands/open.js';
import { registerSetup } from './commands/setup.js';
import { registerHelp } from './commands/help.js';
import { registerCopy } from './commands/copy.js';
import { runInteractiveMode } from './interactive.js';

const BANNER = `
  ${chalk.dim('┌──────────────────────────────────┐')}
  ${chalk.dim('│')}  ${chalk.bold('upex v1.0.0')} -- shortcut manager  ${chalk.dim('│')}
  ${chalk.dim('└──────────────────────────────────┘')}
`;

export function createProgram() {
  const program = new Command();

  program
    .name('upex')
    .description('A personal file shortcut manager — instantly open project folders.')
    .version('1.0.0', '-v, --version')
    .option('-a, --app <app>', 'Preselect app for the interactive selector')
    .enablePositionalOptions()
    .passThroughOptions()
    .addHelpText('beforeAll', BANNER);

  // Register all sub-commands
  registerAdd(program);
  registerList(program);
  registerRemove(program);
  registerRename(program);
  registerEdit(program);
  registerCheck(program);
  registerResolve(program);
  registerSetup(program);
  registerHelp(program);
  registerCopy(program);

  // Default action: upex <name> [app]
  // Commander doesn't support a default positional command well,
  // so we handle unknown commands manually.
  program
    .argument('[name]', 'Shortcut name to open')
    .argument('[app]', 'App to open the folder in (e.g. vscode, webstorm)')
    .action(async (name, app) => {
      // Only handle if it's the root command (not a sub-command)
      // Commander calls this for sub-commands too, but name will be the subcommand name
      // We need to check if name matches a known sub-command
      if (!name) {
        const result = await runInteractiveMode({ preferredApp: program.opts().app });
        if (result.status === 'selected') {
          await handleOpen(result.name, result.app);
          return;
        }
        if (result.status === 'noninteractive') {
          program.outputHelp();
        }
        return;
      }

      const subCommands = program.commands.map(c => c.name()).concat(
        program.commands.flatMap(c => c.aliases())
      );

      if (subCommands.includes(name)) {
        // Let commander handle it
        return;
      }

      await handleOpen(name, app);
    });

  return program;
}

