/**
 * interactive.js -- Interactive shortcut selector for `upex` with no arguments.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import chalk from 'chalk';
import Fuse from 'fuse.js';
import { getInteractiveAppChoices, getAppMap, isTerminalApp, TERMINAL_LAYOUTS, terminalLayout, hasWindowsTerminal } from './launcher.js';
import { loadLinks, frecency, removeLink, setLink, renameLink, linkExists, loadWorkspaces, removeWorkspace, nameError, loadConfig, saveConfig } from './store.js';
import { describeEntry } from './commands/workspace.js';
import * as ui from './ui.js';

const MAX_VISIBLE_CHOICES = 8;
const MAX_WIDTH = 100;
const DEFAULT_APP_KEY = 'explorer';

function buildChoices() {
  // Most-used / most-recent first, ties alphabetical.
  return Object.entries(loadLinks())
    .map(([name, entry]) => ({
      name,
      path: entry.path || entry.app || entry.url || '',
      app: entry.app || null,
      isApp: !!entry.app,
      isCmd: !!(entry.app && entry.terminal),
      isUrl: !!entry.url,
      tags: entry.tags || [],
      opener: entry.opener ? String(entry.opener).toLowerCase() : null,
      exists: entry.path ? fs.existsSync(entry.path) : !!(entry.app || entry.url),
      searchText: `${name} ${entry.path || ''} ${entry.app || ''} ${entry.url || ''} ${(entry.tags || []).join(' ')}`,
      score: frecency(entry),
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

// Folder shortcuts on the Shortcuts tab, app + URL shortcuts on the Apps tab.
export const inView = (view) => (c) => (view === 'apps') === !!(c.isApp || c.isUrl);

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
    includeMatches: true,
  });

  // `hits` = matched char ranges in the name, for highlighting.
  return fuse.search(trimmed).map(({ item, matches = [] }) => ({ ...item, hits: matches.find(m => m.key === 'name')?.indices }));
}

const HOME = os.homedir();

// Home dir prefix -> "~" (case-insensitive on Windows).
export function tidyPath(p) {
  const head = p.slice(0, HOME.length);
  const same = os.platform() === 'win32' ? head.toLowerCase() === HOME.toLowerCase() : head === HOME;
  return same && /^([/\\]|$)/.test(p.slice(HOME.length)) ? `~${p.slice(HOME.length)}` : p;
}

const vis = s => ui.stripAnsi(s).length;
// Selection highlight: dark gray bar (bright black on 16-color terminals).
const highlight = s => (chalk.level >= 2 ? chalk.bgAnsi256(238) : chalk.bgBlackBright)(s);
const keyHint = pairs => '  ' + pairs.filter(Boolean).map(([k, label]) => `${k} ${chalk.dim(label)}`).join('  ');
const underlineHits = (s, hits = []) => [...s].map((ch, i) => (hits.some(([a, b]) => i >= a && i <= b) ? chalk.underline(ch) : ch)).join('');

// Keeps the end of a too-long string, where the folder name is.
const clipStart = (s, n) => (s.length <= n ? s : n <= 1 ? '…'.slice(0, n) : `…${s.slice(-(n - 1))}`);

// One list row: "› name  path ..... #tags  badge". `style` = path | dim | plain.
function renderRow({ sel, name, nameWidth, hits, text = '', style = 'path', right = '', cw }) {
  const nm = chalk.bold(underlineHits(name, hits)) + ' '.repeat(Math.max(0, nameWidth - name.length));
  const room = cw - 2 - Math.max(nameWidth, name.length) - 2 - (right ? vis(right) + 2 : 0);
  const t = clipStart(text, Math.max(0, room));
  const cut = style === 'path' ? Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\')) + 1 : 0;
  const body = sel || style === 'plain' ? t : style === 'dim' ? chalk.dim(t) : chalk.dim(t.slice(0, cut)) + t.slice(cut);
  const left = `${sel ? '›' : ' '} ${nm}  ${body}`;
  const line = sel || right ? left + ' '.repeat(Math.max(right ? 2 : 0, cw - vis(left) - vis(right))) + right : left;
  return `  ${sel ? highlight(line) : line}`;
}

function scrollHint(start, end, total) {
  const parts = [start > 0 && `↑ ${start} more`, end < total && `↓ ${total - end} more`].filter(Boolean);
  return parts.length ? chalk.dim(`    ${parts.join('   ')}`) : null;
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

const VIEWS = { shortcuts: 'Shortcuts', apps: 'Apps', workspaces: 'Workspaces', settings: 'Settings' };
// Tab cycles these; Settings sits outside the cycle on Shift+Tab, so Tab from it goes to Shortcuts.
const CYCLE = ['shortcuts', 'apps', 'workspaces'];
const nextView = (view) => CYCLE[(CYCLE.indexOf(view) + 1) % CYCLE.length];
const LAYOUT_LABELS = { windows: 'Separate windows', tabs: 'Tabs', panes: 'Split panes' };

function layoutNote(layout, wt) {
  if (wt === null) return 'Windows only. Other systems always open separate windows.';
  if (!wt && layout !== 'windows') return 'Windows Terminal (wt) not found, so terminals open as separate windows.';
  return 'How several terminal windows open: separate, or as tabs or panes in your current Windows Terminal window.';
}

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
  layout = 'windows',
  wt = null,
  counts = {},
  width = 80,
}) {
  const isWs = view === 'workspaces';
  const isSettings = view === 'settings';
  const list = isWs ? workspaces : choices;
  const index = isWs ? wsIndex : selectedIndex;
  const currentChoice = list[index];
  const w = Math.min(Math.max(width, 20), MAX_WIDTH);
  const cw = w - 2; // row width after the 2-space indent
  const rule = chalk.dim(`  ${'─'.repeat(cw)}`);
  const terminal = isTerminalApp(appChoices[selectedAppIndex]?.key);

  const lines = [''];

  // Header: name, tabs (active one highlighted), Settings on the right.
  const tab = (key) => {
    const n = counts[key] != null ? ` ${counts[key]}` : '';
    return key === view ? highlight(chalk.bold(` ${VIEWS[key]}${n} `)) : ` ${VIEWS[key]}${chalk.dim(n)} `;
  };
  const headLeft = `  ${chalk.bold('upex')}   ${CYCLE.map(tab).join(' ')}`;
  const headRight = `${tab('settings')} ${chalk.dim('S-Tab')}`;
  lines.push(headLeft + ' '.repeat(Math.max(2, w - vis(headLeft) - vis(headRight))) + headRight);
  lines.push('');

  // Prompt line: filter, or the live action (input / delete confirm).
  if (mode === 'input') {
    lines.push(`  ${chalk.bold('›')} ${PROMPT_LABEL[action](currentChoice?.name || '')} ${inputBuffer}${chalk.dim('▏')}`);
  } else if (mode === 'confirm') {
    lines.push(chalk.yellow(`  ? delete ${isWs ? 'workspace ' : ''}"${currentChoice?.name}"?`) + chalk.dim('  y / n'));
  } else if (!isSettings) {
    lines.push(`  ${chalk.bold('›')} ${query ? `${query}${chalk.dim('▏')}` : chalk.dim('▏type to filter')}`);
  }
  if (flash) lines.push(chalk.yellow(`    ${flash}`));
  lines.push(rule);

  const footer = (rows) => {
    lines.push(rule, ...rows);
    return lines.join('\n');
  };
  const tabKey = ['tab', VIEWS[nextView(view)].toLowerCase()];
  const nav = (open) => keyHint([['↵', open], ['↑↓', 'move'], tabKey, ['esc', 'quit']]);

  if (isSettings) {
    const opts = Object.entries(LAYOUT_LABELS)
      .map(([k, l]) => (k === layout ? chalk.bold(`‹ ${l} ›`) : chalk.dim(l)))
      .join('  ');
    lines.push(`  › ${chalk.bold('Terminals'.padEnd(12))}${opts}`);
    lines.push(chalk.dim(`    ${layoutNote(layout, wt)}`));
    return footer([keyHint([['←→', 'change (saved)'], tabKey, ['S-Tab', 'back'], ['esc', 'quit']])]);
  }

  if (list.length === 0) {
    const empty = {
      workspaces: 'No workspaces yet. Add one: upex ws add <name> <shortcut> [app], or use upex ui',
      apps: 'No app or URL shortcuts yet. Add one: upex add <name> <exe> --app',
      shortcuts: 'No folder shortcuts yet. Add one with ^A (uses the current folder)',
    };
    lines.push(query ? chalk.yellow('    no matches') : chalk.dim(`    ${empty[view]}`));
  } else {
    const nameWidth = Math.min(24, Math.max(12, ...list.map(c => c.name.length)));
    const { start, end } = getVisibleWindow(list, index);
    for (let i = start; i < end; i++) {
      const c = list[i];
      const tags = c.tags?.length ? chalk.dim(`#${c.tags.join(' #')}`) : '';
      const kind = c.isCmd ? 'cmd' : c.isApp ? 'app' : c.isUrl ? 'url' : '';
      const badge = isWs ? '' : !c.exists ? chalk.red('missing') : chalk.dim(kind);
      lines.push(renderRow({
        sel: i === index,
        name: c.name,
        nameWidth,
        hits: c.hits,
        text: isWs || c.isUrl ? c.path : tidyPath(c.path),
        style: isWs ? 'dim' : c.isUrl ? 'plain' : 'path',
        right: [tags, badge].filter(Boolean).join('  '),
        cw,
      }));
    }
    const more = scrollHint(start, end, list.length);
    if (more) lines.push(more);
  }

  if (isWs) return footer([nav('open all'), keyHint([['^d', 'delete']])]);

  if (view === 'apps') {
    return footer([
      nav(currentChoice?.isUrl ? 'open in browser' : 'launch app'),
      keyHint([['^r', 'rename'], ['^d', 'delete']]),
    ]);
  }

  const openers = appChoices
    .map((choice, i) => {
      const label = `${choice.label}${isTerminalApp(choice.key) && cmdCount > 1 ? ` ×${cmdCount}` : ''}`;
      return i === selectedAppIndex ? chalk.bold(`‹ ${label} ›`) : chalk.dim(label);
    })
    .join('  ');
  return footer([
    `  ${chalk.dim('open with')}  ${openers}`,
    '',
    keyHint([['↵', 'open'], ['↑↓', 'move'], ['←→', 'opener'], terminal && ['S-↑↓', 'windows'], tabKey, ['esc', 'quit']]),
    keyHint([['^a', 'add'], ['^e', 'edit path'], ['^r', 'rename'], ['^d', 'delete']]),
  ]);
}

export async function runInteractiveMode({ preferredApp, stdin = process.stdin, stdout = process.stdout } = {}) {
  let allChoices = buildChoices();
  const appChoices = getInteractiveAppChoices();
  // A default opener outside the usual row (e.g. "open") still needs a slot to preselect.
  const appMap = getAppMap();
  for (const key of new Set(allChoices.map(c => c.opener))) {
    if (key && Object.hasOwn(appMap, key) && !appChoices.some(c => c.key === key)) {
      appChoices.push({ key, label: appMap[key].displayName });
    }
  }

  if (allChoices.length === 0) {
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
    let view = 'shortcuts'; // Tab cycles 'shortcuts' | 'apps' | 'workspaces'
    let choices = allChoices.filter(inView(view));
    let filteredChoices = choices;
    let selectedIndex = 0;
    let wsChoices = buildWorkspaceChoices();
    let filteredWs = wsChoices;
    let wsIndex = 0;
    let cmdCount = 1;
    let renderedLineCount = 0;
    let mode = 'browse';   // 'browse' | 'input' | 'confirm'
    let action = null;     // 'edit' | 'rename' | 'add'
    let inputBuffer = '';
    let flash = '';
    let backView = 'shortcuts'; // where Shift+Tab returns from Settings
    let layout = 'windows';
    let wt = null;
    const appIndex = (key) => appChoices.findIndex(choice => choice.key === key);
    let selectedAppIndex = Math.max(0, appIndex(preferredApp || DEFAULT_APP_KEY));
    // Until Left/Right (or --app) picks one, the opener follows the shortcut's default opener.
    let appPicked = !!preferredApp;

    const clearRendered = () => {
      if (renderedLineCount > 0) {
        readline.moveCursor(stdout, 0, -renderedLineCount);
        readline.clearScreenDown(stdout);
        renderedLineCount = 0;
      }
    };

    const redraw = () => {
      if (!appPicked && view === 'shortcuts') {
        const own = appIndex(filteredChoices[selectedIndex]?.opener);
        selectedAppIndex = own >= 0 ? own : Math.max(0, appIndex(DEFAULT_APP_KEY));
      }
      // Clip to terminal width: a wrapped line occupies 2+ rows, which would
      // desync renderedLineCount and leave stale rows behind on redraw.
      const width = Math.max(1, (stdout.columns || 80) - 1);
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
        layout,
        wt,
        counts: { shortcuts: allChoices.filter(inView('shortcuts')).length, apps: allChoices.filter(inView('apps')).length, workspaces: wsChoices.length },
        width,
      });
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
      allChoices = buildChoices();
      choices = allChoices.filter(inView(view));
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
        const bad = nameError(buf);
        if (bad) { flash = bad.toLowerCase().replace(/\.$/, ''); return false; }
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
        const bad = nameError(buf);
        if (bad) { flash = bad.toLowerCase().replace(/\.$/, ''); return false; }
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
        const to = !key.shift ? nextView(view) : view === 'settings' ? backView : 'settings';
        if (to === 'settings') {
          backView = view;
          layout = terminalLayout();
          wt = hasWindowsTerminal();
        }
        view = to;
        query = '';
        choices = allChoices.filter(inView(view));
        selectedIndex = 0;
        updateFilter();
        redraw();
        return;
      }

      // Settings: Left/Right changes and saves the layout; everything else is ignored.
      if (view === 'settings') {
        if (key.name === 'left' || key.name === 'right') {
          const n = TERMINAL_LAYOUTS.length;
          layout = TERMINAL_LAYOUTS[(TERMINAL_LAYOUTS.indexOf(layout) + (key.name === 'left' ? n - 1 : 1)) % n];
          saveConfig({ ...loadConfig(), terminalLayout: layout });
          redraw();
        }
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
      // ^A adds the cwd as a folder shortcut, so it belongs to the Shortcuts tab.
      if (key.ctrl && key.name === 'a') {
        if (view === 'shortcuts') { startAction('add'); redraw(); }
        return;
      }
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

        // App and URL shortcuts launch directly, ignore the opener selector
        if (selected.isApp || selected.isUrl) {
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

      // Shift/Ctrl+Up/Down sets the terminal count; otherwise Up/Down (and Shift) navigates.
      const countKey = (key.shift || key.ctrl) && view === 'shortcuts' && isTerminalApp(appChoices[selectedAppIndex]?.key);

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

      // Opener picking only exists on the Shortcuts tab.
      if ((key.name === 'left' || key.name === 'right') && view !== 'shortcuts') return;

      if (key.name === 'left') {
        appPicked = true;
        selectedAppIndex = selectedAppIndex === 0 ? appChoices.length - 1 : selectedAppIndex - 1;
        redraw();
        return;
      }

      if (key.name === 'right') {
        appPicked = true;
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
