/**
 * help.js -- Command reference grouped by section, plus current settings. Wraps to the terminal width.
 */

import chalk from 'chalk';
import * as ui from '../ui.js';
import { StoreError } from '../store.js';
import { settingRows } from './config.js';

// Section order and members; a command not listed lands in Other.
const SECTIONS = {
  Open: ['go', 'cmd', 'run', 'open', 'ws', 'last', 'web', 'copy'],
  Shortcuts: ['add', 'edit', 'rename', 'remove', 'restore', 'list', 'tag', 'alias', 'pin', 'unpin', 'undo', 'ui'],
  Maintenance: ['check', 'stale', 'stats', 'doctor', 'export', 'import'],
  Setup: ['config', 'app', 'setup', 'completion', 'help'],
};

const dimLine = text => [`\n${text}`, chalk.dim];
// "--tag <tags>" kept on one line when wrapped.
const optsOf = cmd => cmd.options.map(o => o.flags.replace(/^-\w, /, '').replace(/ /g, '\u00a0')).join(' ');

function rowOf(help, cmd) {
  const args = cmd.registeredArguments.map((a) => {
    const n = a.name() + (a.variadic ? '...' : '');
    return a.required ? `<${n}>` : `[${n}]`;
  });
  const opts = optsOf(cmd);
  return {
    term: [chalk.bold([cmd.name(), ...cmd.aliases()].join('|')), ...args].join(' '),
    text: [[help.subcommandDescription(cmd)], ...(opts ? [dimLine(opts)] : [])],
  };
}

/** Help body lines, none wider than `total` columns. */
export function helpLines(program, total = ui.cols() + 2) {
  const help = program.createHelp();
  const groups = Object.fromEntries([...Object.keys(SECTIONS), 'Other'].map(s => [s, []]));
  // The default action has no Command object, so its rows are written by hand.
  groups.Open.push(
    { term: chalk.bold('upex'), text: [['Open the interactive selector'], dimLine('--app\u00a0<app> preselects an opener')] },
    { term: `${chalk.bold('upex')} <name> [app] [count]`, text: [['Open a shortcut (app: vscode, cmd, claude, ...)']] },
  );
  const order = Object.values(SECTIONS).flat();
  const cmds = help.visibleCommands(program)
    .sort((a, b) => (order.indexOf(a.name()) + 1 || Infinity) - (order.indexOf(b.name()) + 1 || Infinity));
  for (const c of cmds) {
    const section = Object.keys(SECTIONS).find(s => SECTIONS[s].includes(c.name())) || 'Other';
    groups[section].push(rowOf(help, c));
  }

  let settings;
  try {
    settings = settingRows();
  } catch (err) {
    if (!(err instanceof StoreError)) throw err;
  }
  if (settings) groups.Settings = settings;

  const lines = [];
  const terms = Object.values(groups).flat();
  for (const [name, rows] of Object.entries(groups)) {
    if (!rows.length) continue;
    lines.push(`  ${chalk.bold(name)}`, ...ui.defList(rows, { indent: 4, total, terms }), '');
  }
  if (!settings) lines.push(...ui.wrap([['Settings unavailable: config.json is unreadable (upex doctor).', chalk.yellow]], total - 2).map(l => `  ${l}`), '');
  const foot = 'Details: upex <command> --help. Change a setting: upex config set <setting> <value>.';
  lines.push(...ui.wrap([[foot, chalk.dim]], total - 2).map(l => `  ${l}`));
  return lines;
}

export function registerHelp(program) {
  program
    .command('help')
    .description('Show commands and settings')
    .action(() => {
      ui.heading('Help');
      for (const line of helpLines(program)) console.log(line);
      ui.blank();
    });
}
