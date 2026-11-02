/**
 * interactive.js -- Interactive shortcut selector for `upex` with no arguments.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import chalk from 'chalk';
import Fuse from 'fuse.js';
import { getInteractiveAppChoices, isTerminalApp } from './launcher.js';
import { loadLinks, frecency, removeLink, setLink, renameLink, linkExists, loadWorkspaces, removeWorkspace } from './store.js';
import { describeEntry } from './commands/workspace.js';
import * as ui from './ui.js';

const MAX_VISIBLE_CHOICES = 8;
const DEFAULT_APP_KEY = 'explorer';

function buildChoices() {
  // Most-used / most-recent first, ties alphabetical.
  return Object.entries(loadLinks())
    .map(([name, entry]) => ({
      name,
      path: entry.path || entry.app || entry.url || '',
      app: entry.app || null,
      isApp: !!entry.app,
      isUrl: !!entry.url,
      tags: entry.tags || [],
      exists: entry.path ? fs.existsSync(entry.path) : !!(entry.app || entry.url),
      searchText: `${name} ${entry.path || ''} ${entry.app || ''} ${entry.url || ''} ${(entry.tags || []).join(' ')}`,
      score: frecency(entry),
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

// Workspaces in the same { name, path, searchText } shape so filterChoices works on them.
function buildWorkspaceChoices() {
  return Object.entries(loadWorkspaces()).map(([name, entries]) => {
    const summary = (entries || []).map(describeEntry).join('  ');
    return { name, path: summary, searchText: `${name} ${summary}` };
  });
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

function formatAppChoices(appChoices, selectedAppIndex, cmdCount) {
  return appChoices
    .map((choice, index) => {
      const suffix = isTerminalApp(choice.key) && cmdCount > 1 ? ` x${cmdCount}` : '';
      const label = `${choice.label}${suffix}`;
      return index === selectedAppIndex ? chalk.bold(`[${label}]`) : label;
    })
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

const PROMPT_LABEL = {
  edit: name => `new path for "${name}" (blank = cwd):`,
  rename: name => `rename "${name}" to:`,
  add: () => 'new shortcut name (path = cwd):',
};

const VIEWS = { shortcuts: 'Shortcuts', workspaces: 'Workspaces' };

export function renderInteractiveView({
  query,
  choices,
  selectedIndex,
  appChoices,
  selectedAppIndex,
  cmdCount,
  view = 'shortcuts',
  workspaces = [],
  wsIndex = 0,
  mode = 'browse',
  action = null,
  inputBuffer = '',
  flash = '',
}) {
  const isWs = view === 'workspaces';
  const list = isWs ? workspaces : choices;
  const index = isWs ? wsIndex : selectedIndex;
  const nameWidth = Math.max(
    4,
    ...list.slice(0, MAX_VISIBLE_CHOICES).map(choice => choice.name.length),
    12,
  );

  // App and URL shortcuts launch directly — no opener row.
  const currentChoice = list[index];
  const selectedIsApp = currentChoice?.isApp || currentChoice?.isUrl;

  const lines = [];
  lines.push('');
  lines.push(chalk.dim('  ┌─────────────────────┐'));
  lines.push(`  ${chalk.dim('│')}  ${chalk.bold('Shortcut Selector')}  ${chalk.dim('│')}`);
  lines.push(chalk.dim('  └─────────────────────┘'));
  lines.push('');
  const tabs = Object.entries(VIEWS).map(([key, label]) => (key === view ? chalk.bold(`[${label}]`) : label)).join('  ');
  lines.push(`  ${chalk.dim('view')}    ${tabs}`);
  lines.push(`  ${chalk.dim('filter')}  ${query || chalk.dim('(type to search)')}`);

  if (isWs) {
    lines.push(chalk.dim('  keys    Enter=open all  Tab=shortcuts  Up/Down=navigate  ^D=del  Esc=cancel'));
  } else {
    // Hide opener row for app shortcuts, they launch directly
    if (selectedIsApp) {
      lines.push(`  ${chalk.dim('open')}    ${chalk.cyan('launch app')}`);
    } else {
      lines.push(`  ${chalk.dim('open')}    ${formatAppChoices(appChoices, selectedAppIndex, cmdCount)}`);
    }
    const countHint = isTerminalApp(appChoices[selectedAppIndex]?.key) ? '  ^Up/^Down=count' : '';
    lines.push(chalk.dim(`  keys    Enter=open  Tab=workspaces  Up/Down=navigate  Left/Right=app${countHint}  ^E=edit ^R=rename ^A=add ^D=del  Esc=cancel`));
  }
  lines.push(chalk.dim('  ────────────────────────────────────────────────────────────────────────────'));

  // Live-action status line (input prompt / delete confirm / error flash).
  if (mode === 'input') {
    const target = currentChoice?.name || '';
    lines.push(`  ${chalk.cyan('▸')} ${PROMPT_LABEL[action](target)} ${inputBuffer}${chalk.dim('▏')}`);
  } else if (mode === 'confirm') {
    lines.push(`  ${chalk.yellow('?')} delete ${isWs ? 'workspace ' : ''}"${currentChoice?.name}"?  ${chalk.dim('(y / n)')}`);
  } else if (flash) {
    lines.push(`  ${chalk.yellow(flash)}`);
  }

  if (list.length === 0) {
    lines.push(isWs && !query
      ? `  ${chalk.dim('No workspaces yet. Add one: upex ws add <name> <shortcut> [app], or use upex ui')}`
      : `  ${ui.tag.warn}  No matches`);
    return lines.join('\n');
  }

  if (isWs) {
    const { start, end } = getVisibleWindow(list, index);
    for (let i = start; i < end; i++) {
      lines.push(`  ${i === index ? '>' : ' '} ${formatName(list[i].name, nameWidth)}  ${chalk.dim(list[i].path)}`);
    }
    if (list.length > MAX_VISIBLE_CHOICES) {
      lines.push(chalk.dim(`  showing ${start + 1}-${end} of ${list.length}`));
    }
    return lines.join('\n');
  }

  const { start, end } = getVisibleWindow(choices, selectedIndex);
  const visibleChoices = choices.slice(start, end);

  for (let i = 0; i < visibleChoices.length; i++) {
    const choiceIndex = start + i;
    const choice = visibleChoices[i];
    const cursor = choiceIndex === selectedIndex ? '>' : ' ';
    const status = choice.exists ? ui.tag.ok : ui.tag.fail;
    const badge = choice.isApp ? chalk.cyan('[*APP]') : choice.isUrl ? chalk.blue('[*URL]') : status;
    const tags = choice.tags && choice.tags.length ? chalk.dim(`  #${choice.tags.join(' #')}`) : '';
    const label = `${formatName(choice.name, nameWidth)}  ${badge}  ${choice.path}${tags}`;
    lines.push(`  ${cursor} ${label}`);
  }

  if (choices.length > MAX_VISIBLE_CHOICES) {
    lines.push(chalk.dim(`  showing ${start + 1}-${end} of ${choices.length}`));
  }

  return lines.join('\n');
}

export async function runInteractiveMode({ preferredApp, stdin = process.stdin, stdout = process.stdout } = {}) {
  let choices = buildChoices();
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
    let view = 'shortcuts'; // Tab toggles 'shortcuts' | 'workspaces'
    let wsChoices = buildWorkspaceChoices();
    let filteredWs = wsChoices;
    let wsIndex = 0;
    let cmdCount = 1;
    let renderedLineCount = 0;
    let mode = 'browse';   // 'browse' | 'input' | 'confirm'
    let action = null;     // 'edit' | 'rename' | 'add'
    let inputBuffer = '';
    let flash = '';
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
        cmdCount,
        view,
        workspaces: filteredWs,
        wsIndex,
        mode,
        action,
        inputBuffer,
        flash,
      });

      // Clip to terminal width: a wrapped line occupies 2+ rows, which would
      // desync renderedLineCount and leave stale rows behind on redraw.
      const width = Math.max(1, (stdout.columns || 80) - 1);
      const clipped = output.split('\n').map(line => ui.truncate(line, width));

      clearRendered();

      stdout.write(clipped.join('\n') + '\n');
      renderedLineCount = clipped.length;
    };

    const updateFilter = () => {
      filteredWs = filterChoices(wsChoices, query);
      wsIndex = Math.max(0, Math.min(wsIndex, filteredWs.length - 1));
      filteredChoices = filterChoices(choices, query);
      if (filteredChoices.length === 0) {
        selectedIndex = 0;
        return;
      }
      if (selectedIndex >= filteredChoices.length) {
        selectedIndex = filteredChoices.length - 1;
      }
    };

    // Reload from disk after a mutation and try to keep `name` selected.
    const rebuild = (name) => {
      choices = buildChoices();
      wsChoices = buildWorkspaceChoices();
      updateFilter();
      const idx = name ? filteredChoices.findIndex(c => c.name === name) : -1;
      selectedIndex = idx >= 0 ? idx : Math.min(selectedIndex, Math.max(0, filteredChoices.length - 1));
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

    const startAction = (name) => {
      action = name;
      inputBuffer = '';
      mode = 'input';
    };

    // Commit the pending input action; returns false + sets flash on validation error.
    const commitInput = (target) => {
      const buf = inputBuffer.trim();

      if (action === 'add') {
        if (!buf) { flash = 'name required'; return false; }
        if (linkExists(buf)) { flash = `"${buf}" already exists`; return false; }
        setLink(buf, { path: process.cwd() });
        rebuild(buf);
        return true;
      }

      if (action === 'edit') {
        const resolved = buf ? path.resolve(buf) : process.cwd();
        if (!fs.existsSync(resolved)) { flash = 'path not found'; return false; }
        const links = loadLinks();
        setLink(target, { ...(links[target] || {}), path: resolved });
        rebuild(target);
        return true;
      }

      if (action === 'rename') {
        if (!buf) { flash = 'name required'; return false; }
        const result = renameLink(target, buf);
        if (!result.ok) {
          flash = result.reason === 'exists' ? `"${buf}" already exists` : 'not found';
          return false;
        }
        rebuild(buf);
        return true;
      }

      return true;
    };

    const handleKey = (str, key = {}) => {
      flash = '';

      if (key.ctrl && key.name === 'c') {
        stdout.write('\n');
        finish({ status: 'cancelled' });
        return;
      }

      // ── Confirm-delete mode ──
      if (mode === 'confirm') {
        if (key.name === 'y' && view === 'workspaces') {
          const victim = filteredWs[wsIndex];
          if (victim) removeWorkspace(victim.name);
          rebuild();
        } else if (key.name === 'y') {
          const victim = filteredChoices[selectedIndex];
          if (victim) removeLink(victim.name);
          rebuild();
        }
        mode = 'browse';
        redraw();
        return;
      }

      // ── Inline input mode (edit / rename / add) ──
      if (mode === 'input') {
        const target = filteredChoices[selectedIndex]?.name;

        if (key.name === 'escape') {
          mode = 'browse';
          redraw();
          return;
        }
        if (key.name === 'return') {
          if (commitInput(target)) mode = 'browse';
          redraw();
          return;
        }
        if (key.name === 'backspace') {
          inputBuffer = inputBuffer.slice(0, -1);
          redraw();
          return;
        }
        if (!key.ctrl && !key.meta && str && str >= ' ' && str.charCodeAt(0) !== 127) {
          inputBuffer += str;
          redraw();
        }
        return;
      }

      // ── Browse mode ──
      if (key.name === 'escape') {
        stdout.write('\n');
        finish({ status: 'cancelled' });
        return;
      }

      if (key.name === 'tab') {
        view = view === 'shortcuts' ? 'workspaces' : 'shortcuts';
        query = '';
        updateFilter();
        redraw();
        return;
      }

      if (view === 'workspaces') {
        const n = filteredWs.length;
        if (key.ctrl && key.name === 'd') {
          if (n > 0) { mode = 'confirm'; redraw(); }
          return;
        }
        if (key.name === 'return') {
          if (n > 0) finish({ status: 'workspace', name: filteredWs[wsIndex].name });
          return;
        }
        if ((key.name === 'up' || key.name === 'down') && n > 0) {
          wsIndex = (wsIndex + (key.name === 'up' ? n - 1 : 1)) % n;
          redraw();
          return;
        }
        // Shortcut-only keys (^A/^E/^R, Left/Right) do nothing here.
        if (key.ctrl || key.name === 'left' || key.name === 'right' || key.name === 'up' || key.name === 'down') return;
      }

      // Live actions (Ctrl+key so they never clash with search typing).
      if (key.ctrl && key.name === 'a') { startAction('add'); redraw(); return; }
      if (key.ctrl && key.name === 'd') {
        if (filteredChoices.length > 0) { mode = 'confirm'; redraw(); }
        return;
      }
      if (key.ctrl && key.name === 'e') {
        const target = filteredChoices[selectedIndex];
        if (target && !target.isApp && !target.isUrl) { startAction('edit'); redraw(); }
        return;
      }
      if (key.ctrl && key.name === 'r') {
        if (filteredChoices.length > 0) { startAction('rename'); redraw(); }
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

        const appKey = appChoices[selectedAppIndex]?.key || DEFAULT_APP_KEY;
        finish({
          status: 'selected',
          name: selected.name,
          app: appKey,
          count: isTerminalApp(appKey) ? cmdCount : 1,
        });
        return;
      }

      // Ctrl+Up/Down sets the terminal count; plain Up/Down navigates.
      const countKey = key.ctrl && isTerminalApp(appChoices[selectedAppIndex]?.key);

      if (key.name === 'up') {
        if (countKey) {
          cmdCount = Math.min(9, cmdCount + 1);
          redraw();
        } else if (!key.ctrl && filteredChoices.length > 0) {
          selectedIndex = selectedIndex === 0 ? filteredChoices.length - 1 : selectedIndex - 1;
          redraw();
        }
        return;
      }

      if (key.name === 'down') {
        if (countKey) {
          cmdCount = Math.max(1, cmdCount - 1);
          redraw();
        } else if (!key.ctrl && filteredChoices.length > 0) {
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

      if (!key.ctrl && !key.meta && str && str >= ' ' && str.charCodeAt(0) !== 127) {
        query += str;
        updateFilter();
        redraw();
      }
    };

    // Store errors in a handler must reject (bin/upex.js prints them), not crash uncaught.
    const onKeypress = (str, key) => {
      try {
        handleKey(str, key);
      } catch (error) {
        fail(error);
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
