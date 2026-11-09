/**
 * index.js -- Main entry point for the upex CLI
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { registerAdd } from './commands/add.js';
import { registerList } from './commands/list.js';
import { registerRemove } from './commands/remove.js';
import { registerRename } from './commands/rename.js';
import { registerEdit } from './commands/edit.js';
import { registerCheck } from './commands/check.js';
import { registerResolve, registerGo, registerCd, handleOpen } from './commands/open.js';
import { registerSetup } from './commands/setup.js';
import { registerHelp } from './commands/help.js';
import { registerCopy } from './commands/copy.js';
import { registerCmd } from './commands/cmd.js';
import { registerApp } from './commands/app.js';
import { registerCompletion } from './commands/completion.js';
import { registerTag, registerOpenGroup } from './commands/tag.js';
import { registerAlias } from './commands/alias.js';
import { registerWorkspace, openWorkspace, openEntries } from './commands/workspace.js';
import { loadWorkspaces, loadLinks, saveLinks, sweepExpired, StoreError } from './store.js';
import { registerRun } from './commands/run.js';
import { registerExport, registerImport } from './commands/transfer.js';
import { registerLast } from './commands/last.js';
import { registerWeb } from './commands/web.js';
import { registerWebPage } from './commands/webpage.js';
import { registerDoctor } from './commands/doctor.js';
import { registerStale } from './commands/stale.js';
import { registerStats } from './commands/stats.js';
import { registerConfig } from './commands/config.js';
import { registerPin } from './commands/pin.js';
import { registerUndo } from './commands/undo.js';
import { registerNote } from './commands/note.js';
import { registerColor } from './commands/color.js';
import { registerPick } from './commands/pick.js';
import { runInteractiveMode } from './interactive.js';
import { setting } from './launcher.js';
import { VERSION as version, updateNotice, runUpdate } from './update.js';

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
    .description('A personal file shortcut manager: instantly open project folders.')
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
  registerCd(program);
  registerSetup(program);
  registerHelp(program);
  registerCopy(program);
  registerCmd(program);
  registerApp(program);
  registerCompletion(program);
  registerTag(program);
  registerAlias(program);
  registerOpenGroup(program);
  registerWorkspace(program);
  registerRun(program);
  registerExport(program);
  registerImport(program);
  registerLast(program);
  registerWeb(program);
  registerWebPage(program);
  registerDoctor(program);
  registerStale(program);
  registerStats(program);
  registerConfig(program);
  registerPin(program);
  registerUndo(program);
  registerNote(program);
  registerColor(program);
  registerPick(program);

  // Archive expired temporary shortcuts. Skipped where stdout feeds a shell wrapper.
  program.hook('preAction', (_root, cmd) => {
    // undo: a sweep's own save would be what gets undone.
    if (cmd.name().startsWith('__') || ['go', 'cd', 'undo'].includes(cmd.name())) return;
    try {
      const { links, archived } = sweepExpired(loadLinks());
      if (!archived.length) return;
      saveLinks(links);
      console.error(chalk.dim(`  archived expired: ${archived.map(n => `${n} (upex restore ${n})`).join(', ')}`));
    } catch (err) {
      // A broken store is reported by the command itself (or upex doctor).
      if (!(err instanceof StoreError)) throw err;
    }
  });

  // Update notice: not for the selector (no name, pick), wrappers, completion (shell startup), ui (still starting) or non-terminals.
  program.hook('postAction', (_root, cmd) => {
    if (!process.stderr.isTTY || (cmd === program && !cmd.args.length)) return;
    if (cmd.name().startsWith('__') || ['go', 'cd', 'pick', 'ui', 'completion'].includes(cmd.name())) return;
    try {
      if (setting('updateCheck') === 'off') return;
    } catch { return; }
    const notice = updateNotice();
    if (notice) console.error(chalk.dim(`  ${notice}`));
  });

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
          await handleOpen(result.name, result.app, result.count || 1, result.start);
          return;
        }
        // Marked rows (Space), opened after the selector closed.
        if (result.status === 'marked') {
          if (await openEntries(result.entries)) process.exitCode = 1;
          return;
        }
        if (result.status === 'workspace') {
          await openWorkspace(loadWorkspaces(), result.name);
          return;
        }
        // Settings > Updates, Enter on a newer version.
        if (result.status === 'update') {
          await runUpdate();
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

