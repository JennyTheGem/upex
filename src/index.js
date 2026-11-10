/**
 * index.js -- Main entry point for the upex CLI
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { COMMANDS } from './fast.js';
import { loadWorkspaces, loadLinks, saveLinks, sweepExpired, StoreError } from './store.js';
import { VERSION as version, updateNotice, runUpdate } from './update.js';

const label = `upex v${version}`;
const title = `${label} -- shortcut manager`;
const w = title.length + 4;
const BANNER = `
  ${chalk.dim('┌' + '─'.repeat(w) + '┐')}
  ${chalk.dim('│')}  ${chalk.bold(label)} -- shortcut manager  ${chalk.dim('│')}
  ${chalk.dim('└' + '─'.repeat(w) + '┘')}
`;

// Commands a run needs: just its own for `upex <command>`, none for a shortcut or --version,
// all for help, completion, the selector and a leading option.
function needed([first, ...rest]) {
  if (!rest.length && (first === '-v' || first === '--version')) return [];
  if (!first || first.startsWith('-') || first === 'help' || first === 'completion') return COMMANDS;
  return COMMANDS.filter(c => c[0].split(' ').includes(first));
}

// `argv` (process.argv) loads only the commands it needs; without it, all.
export async function createProgram(argv) {
  const cmds = argv ? needed(argv.slice(2)) : COMMANDS;
  const files = [...new Set(cmds.map(c => c[1]))];
  const mods = Object.fromEntries(await Promise.all(files.map(async f => [f, await import(`./commands/${f}.js`)])));
  const program = new Command();

  program
    .name('upex')
    .description('A personal file shortcut manager: instantly open project folders.')
    .version(version, '-v, --version')
    .option('-a, --app <app>', 'Preselect app for the interactive selector')
    // Stripped and handled in bin/upex.js; listed here for help.
    .option('--dry-run', 'Print the commands an open would run instead of running them (anywhere on the line)')
    .enablePositionalOptions()
    .passThroughOptions()
    .addHelpText('beforeAll', BANNER);

  for (const [, file, register] of cmds) mods[file][register](program);

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
  program.hook('postAction', async (_root, cmd) => {
    if (!process.stderr.isTTY || (cmd === program && !cmd.args.length)) return;
    if (cmd.name().startsWith('__') || ['go', 'cd', 'pick', 'ui', 'completion'].includes(cmd.name())) return;
    const { setting } = await import('./launcher.js');
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
    .argument('[name]', 'Shortcut name, or a path (., ~/x, C:\\x) to open')
    .argument('[app]', 'App to open the folder in (e.g. vscode, webstorm)')
    .argument('[count]', 'How many windows to open (cmd only)')
    .action(async (name, app, count) => {
      // Only handle if it's the root command (not a sub-command)
      // Commander calls this for sub-commands too, but name will be the subcommand name
      // We need to check if name matches a known sub-command
      const { handleOpen } = await import('./commands/open.js');
      if (!name) {
        const [{ runInteractiveMode }, { openEntries, openWorkspace }] = await Promise.all([import('./interactive.js'), import('./commands/workspace.js')]);
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

