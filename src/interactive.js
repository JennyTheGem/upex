/**
 * interactive.js -- Interactive shortcut selector for `upex` with no arguments.
 */

import fs from 'node:fs';
import readline from 'node:readline';
import chalk from 'chalk';
import Fuse from 'fuse.js';
import { getInteractiveAppChoices } from './launcher.js';
import { loadLinks } from './store.js';
import * as ui from './ui.js';

const MAX_VISIBLE_CHOICES = 8;
const DEFAULT_APP_KEY = 'explorer';

function buildChoices() {
  return Object.entries(loadLinks())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => ({
      name,
      path: entry.path || entry.app || '',
      app: entry.app || null,
      isApp: !!entry.app,
      exists: entry.path ? fs.existsSync(entry.path) : !!entry.app,
      searchText: `${name} ${entry.path || ''} ${entry.app || ''}`,
    }));
}

export function filterChoices(choices, query) {
  const trimmed = query.trim();
  if (!trimmed) return choices;

  const fuse = new Fuse(choices, {
    keys: ['name', 'path', 'searchText'],
    threshold: 0.35,
    includeScore: true,
  });

  return fuse.search(trimmed).map(result => result.item);
}

function formatName(name, width) {
  return chalk.bold(name.padEnd(width));
}

function formatAppChoices(appChoices, selectedAppIndex) {
  return appChoices
    .map((choice, index) => (
      index === selectedAppIndex
        ? chalk.bold(`[${choice.label}]`)
        : choice.label
    ))
    .join('  ');
}

function getVisibleWindow(choices, selectedIndex, maxVisible = MAX_VISIBLE_CHOICES) {
  if (choices.length <= maxVisible) {
    return { start: 0, end: choices.length };
  }

  const half = Math.floor(maxVisible / 2);
  let start = Math.max(0, selectedIndex - half);
  let end = start + maxVisible;

  if (end > choices.length) {
    end = choices.length;
    start = end - maxVisible;
  }

  return { start, end };
}

export function renderInteractiveView({
  query,
  choices,
  selectedIndex,
  appChoices,
  selectedAppIndex,
  focus,
}) {
  const nameWidth = Math.max(
    4,
    ...choices.slice(0, MAX_VISIBLE_CHOICES).map(choice => choice.name.length),
    12,
  );

  // Check if the currently selected shortcut is an app shortcut
  const currentChoice = choices[selectedIndex];
  const selectedIsApp = currentChoice?.isApp;

  const lines = [];
  lines.push('');
  lines.push(chalk.dim('  ┌─────────────────────┐'));
  lines.push(`  ${chalk.dim('│')}  ${chalk.bold('Shortcut Selector')}  ${chalk.dim('│')}`);
  lines.push(chalk.dim('  └─────────────────────┘'));
  lines.push('');
  lines.push(`  ${chalk.dim('filter')}  ${query || chalk.dim('(type to search)')}`);

  // Hide opener row for app shortcuts — they launch directly
  if (selectedIsApp) {
    lines.push(`    ${chalk.dim('open')}    ${chalk.cyan('launch app')}`);
  } else {
    lines.push(`  ${focus === 'app' ? '>' : ' '} ${chalk.dim('open')}    ${formatAppChoices(appChoices, selectedAppIndex)}`);
  }

  lines.push(chalk.dim('  keys    Enter=open  Tab=switch  Up/Down=navigate  Left/Right=app  Backspace=delete  Esc=cancel'));
  lines.push(chalk.dim('  ────────────────────────────────────────────────────────────────────────────'));

  if (choices.length === 0) {
    lines.push(`  ${ui.tag.warn}  No matches`);
    return lines.join('\n');
  }

  const { start, end } = getVisibleWindow(choices, selectedIndex);
  const visibleChoices = choices.slice(start, end);

  for (let i = 0; i < visibleChoices.length; i++) {
    const choiceIndex = start + i;
    const choice = visibleChoices[i];
    const cursor = choiceIndex === selectedIndex ? '>' : ' ';
    const status = choice.exists ? ui.tag.ok : ui.tag.fail;
    const label = choice.isApp
      ? `${formatName(choice.name, nameWidth)}  ${chalk.cyan('[*APP]')}  ${choice.path}`
      : `${formatName(choice.name, nameWidth)}  ${status}  ${choice.path}`;
    lines.push(`  ${cursor} ${label}`);
  }

  if (choices.length > MAX_VISIBLE_CHOICES) {
    lines.push(chalk.dim(`  showing ${start + 1}-${end} of ${choices.length}`));
  }

  return lines.join('\n');
}

export async function runInteractiveMode({ preferredApp, stdin = process.stdin, stdout = process.stdout } = {}) {
  const choices = buildChoices();
  const appChoices = getInteractiveAppChoices();

  if (choices.length === 0) {
    ui.blank();
    ui.info('No shortcuts saved. Use: upex add <name> [path]');
    ui.blank();
    return { status: 'empty' };
  }

  if (!stdin.isTTY || !stdout.isTTY) {
    return { status: 'noninteractive' };
  }

  return new Promise((resolve, reject) => {
    let query = '';
    let filteredChoices = choices;
    let selectedIndex = 0;
    let focus = 'shortcut';
    let renderedLineCount = 0;
    let selectedAppIndex = Math.max(
      0,
      appChoices.findIndex(choice => choice.key === (preferredApp || DEFAULT_APP_KEY)),
    );

    const clearRendered = () => {
      if (renderedLineCount > 0) {
        readline.moveCursor(stdout, 0, -renderedLineCount);
        readline.clearScreenDown(stdout);
        renderedLineCount = 0;
      }
    };

    const redraw = () => {
      const output = renderInteractiveView({
        query,
        choices: filteredChoices,
        selectedIndex,
        appChoices,
        selectedAppIndex,
        focus,
      });

      clearRendered();

      stdout.write(output + '\n');
      renderedLineCount = output.split('\n').length;
    };

    const updateFilter = () => {
      filteredChoices = filterChoices(choices, query);
      if (filteredChoices.length === 0) {
        selectedIndex = 0;
        return;
      }
      if (selectedIndex >= filteredChoices.length) {
        selectedIndex = filteredChoices.length - 1;
      }
    };

    const cleanup = () => {
      stdin.removeListener('keypress', onKeypress);
      if (stdin.isTTY) {
        stdin.setRawMode(false);
      }
      stdin.pause();
    };

    const finish = (result) => {
      clearRendered();
      cleanup();
      resolve(result);
    };

    const fail = (error) => {
      cleanup();
      reject(error);
    };

    const onKeypress = (str, key = {}) => {
      if (key.ctrl && key.name === 'c') {
        stdout.write('\n');
        finish({ status: 'cancelled' });
        return;
      }

      if (key.name === 'escape') {
        stdout.write('\n');
        finish({ status: 'cancelled' });
        return;
      }

      if (key.name === 'return') {
        if (filteredChoices.length === 0) {
          return;
        }

        const selected = filteredChoices[selectedIndex];

        // App shortcuts launch directly — ignore the opener selector
        if (selected.isApp) {
          finish({
            status: 'selected',
            name: selected.name,
            app: null,
          });
          return;
        }

        finish({
          status: 'selected',
          name: selected.name,
          app: appChoices[selectedAppIndex]?.key || DEFAULT_APP_KEY,
        });
        return;
      }

      if (key.name === 'tab') {
        focus = focus === 'shortcut' ? 'app' : 'shortcut';
        redraw();
        return;
      }

      if (key.name === 'up') {
        if (focus === 'shortcut' && filteredChoices.length > 0) {
          selectedIndex = selectedIndex === 0 ? filteredChoices.length - 1 : selectedIndex - 1;
          redraw();
        }
        return;
      }

      if (key.name === 'down') {
        if (focus === 'shortcut' && filteredChoices.length > 0) {
          selectedIndex = selectedIndex === filteredChoices.length - 1 ? 0 : selectedIndex + 1;
          redraw();
        }
        return;
      }

      if (key.name === 'left') {
        selectedAppIndex = selectedAppIndex === 0 ? appChoices.length - 1 : selectedAppIndex - 1;
        redraw();
        return;
      }

      if (key.name === 'right') {
        selectedAppIndex = selectedAppIndex === appChoices.length - 1 ? 0 : selectedAppIndex + 1;
        redraw();
        return;
      }

      if (key.name === 'backspace') {
        if (query.length > 0) {
          query = query.slice(0, -1);
          updateFilter();
          redraw();
        }
        return;
      }

      if (!key.ctrl && !key.meta && str && str >= ' ' && str !== '\u007f') {
        query += str;
        updateFilter();
        redraw();
      }
    };

    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('keypress', onKeypress);

    try {
      redraw();
    } catch (error) {
      fail(error);
    }
  });
}


