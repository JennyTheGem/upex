/**
 * index.js — Main entry point for the upex CLI
 */

import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import chalk from 'chalk';
import { registerAdd } from './commands/add.js';
import { registerList } from './commands/list.js';
import { registerRemove } from './commands/remove.js';
import { registerRename } from './commands/rename.js';
import { registerEdit } from './commands/edit.js';
import { registerCheck } from './commands/check.js';
import { registerResolve, registerGo, handleOpen } from './commands/open.js';
import { registerSetup } from './commands/setup.js';
import { registerHelp } from './commands/help.js';
import { registerCopy } from './commands/copy.js';
import { registerCmd } from './commands/cmd.js';
import { registerApp } from './commands/app.js';
import { registerCompletion } from './commands/completion.js';
import { registerTag, registerOpenGroup } from './commands/tag.js';
import { registerWorkspace } from './commands/workspace.js';
import { registerRun } from './commands/run.js';
import { registerExport, registerImport } from './commands/transfer.js';
import { registerLast } from './commands/last.js';
import { runInteractiveMode } from './interactive.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

const label = `upex v${version}`;
const title = `${label} -- shortcut manager`;
const w = title.length + 4;
const BANNER = `
  ${chalk.dim('┌' + '─'.repeat(w) + '┐')}
  ${chalk.dim('│')}  ${chalk.bold(label)} -- shortcut manager  ${chalk.dim('│')}
  ${chalk.dim('└' + '─'.repeat(w) + '┘')}
`;

export function createProgram() {
  const program = new Command();

  program
    .name('upex')
    .description('A personal file shortcut manager — instantly open project folders.')
    .version(version, '-v, --version')
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
  registerGo(program);
  registerSetup(program);
  registerHelp(program);
  registerCopy(program);
  registerCmd(program);
  registerApp(program);
  registerCompletion(program);
  registerTag(program);
  registerOpenGroup(program);
  registerWorkspace(program);
  registerRun(program);
  registerExport(program);
  registerImport(program);
  registerLast(program);

  // Default action: upex <name> [app]
  // Commander doesn't support a default positional command well,
  // so we handle unknown commands manually.
  program
    .argument('[name]', 'Shortcut name to open')
    .argument('[app]', 'App to open the folder in (e.g. vscode, webstorm)')
    .argument('[count]', 'How many windows to open (cmd only)')
    .action(async (name, app, count) => {
      // Only handle if it's the root command (not a sub-command)
      // Commander calls this for sub-commands too, but name will be the subcommand name
      // We need to check if name matches a known sub-command
      if (!name) {
        const result = await runInteractiveMode({ preferredApp: program.opts().app });
        if (result.status === 'selected') {
          await handleOpen(result.name, result.app, result.count || 1);
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

      await handleOpen(name, app, Number(count) || 1);
    });

  return program;
}

