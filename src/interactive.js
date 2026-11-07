/**
 * interactive.js -- Interactive shortcut selector for `upex` with no arguments.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import chalk from 'chalk';
import Fuse from 'fuse.js';
import { getInteractiveAppChoices, getAppMap, isTerminalApp, hasWindowsTerminal, defaultOpener, readSettings, setting, startTab, shownTabs, isHex, copyToClipboard, launchUrl, SETTINGS } from './launcher.js';
import { gitOf, stopGit } from './git.js';
import { loadLinks, activeLinks, aliasesOf, takenError, checkAliases, frecency, removeLinks, saveLinks, setLink, renameLink, loadWorkspaces, saveWorkspaces, removeWorkspace, nameError, loadConfig, saveConfig, withPinned, setPinOrder } from './store.js';
import { describeEntry } from './commands/workspace.js';
import { handleOpen } from './commands/open.js';
import { startServer } from './commands/web.js';
import { readScripts, detectPm } from './commands/run.js';
import * as ui from './ui.js';

const MAX_VISIBLE_CHOICES = 8;
// Full screen in a terminal at least this wide: detail pane right of the list.
const PANE_MIN = 140;
// Narrower: only once opened (Shift+Right, or Narrow screens Always), and never under this.
const PANE_FLOOR = 60;
// Is the detail pane shown? `open` = opened on a narrow screen.
export const paneShown = (columns, full, open) => !!full && (columns >= PANE_MIN || (!!open && columns >= PANE_FLOOR));
// Can Shift+Right open it and Shift+Left close it here?
export const paneToggles = (columns, full, s = {}) => !!full && columns < PANE_MIN && columns >= PANE_FLOOR && s.narrowPane !== 'always';
const ALT_ON = '\x1b[?1049h';
const ALT_OFF = '\x1b[?1049l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
// SGR mouse reports, only while on the alt screen.
const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?1006l\x1b[?1000l';

function buildChoices() {
  return Object.entries(activeLinks(loadLinks()))
    .map(([name, entry]) => ({
      name,
      path: entry.path || entry.app || entry.url || '',
      app: entry.app || null,
      isApp: !!entry.app,
      isCmd: !!(entry.app && entry.terminal),
      isUrl: !!entry.url,
      tags: entry.tags || [],
      pinned: !!entry.pinned,
      pinOrder: entry.pinned && Number.isFinite(entry.pinOrder) ? entry.pinOrder : undefined,
      opener: entry.opener ? String(entry.opener).toLowerCase() : null,
      exists: entry.path ? fs.existsSync(entry.path) : !!(entry.app || entry.url),
      searchText: `${name} ${aliasesOf(entry).join(' ')} ${entry.path || ''} ${entry.app || ''} ${entry.url || ''} ${(entry.tags || []).join(' ')}`,
      score: frecency(entry),
      lastUsed: entry.lastUsed || 0,
      added: entry.added || 0,
      uses: entry.uses || 0,
      expires: entry.expires || 0,
      aliases: aliasesOf(entry),
    }))
    .sort(byOrder(setting('sort')));
}

// Pinned first, in their pin order (unordered ones after); then highest first by the sort's field
// (most used, last opened, recently added), ties and 'name' A to Z.
const SORT_FIELD = { recent: 'score', opened: 'lastUsed', added: 'added' };
const pinRank = c => c.pinOrder ?? Infinity;
export const byOrder = (sort) => (a, b) => {
  const f = SORT_FIELD[sort];
  return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || Math.sign(pinRank(a) - pinRank(b)) || (f ? (b[f] || 0) - (a[f] || 0) : 0) || a.name.localeCompare(b.name);
};

// Pin order (names) after moving `name` one step (dir -1 / 1) past the next pin `same` accepts; null at an end.
export function movePinned(pins, name, dir, same = () => true) {
  const i = pins.findIndex(p => p.name === name);
  let j = i + dir;
  while (j >= 0 && j < pins.length && !same(pins[j])) j += dir;
  if (i < 0 || j < 0 || j >= pins.length) return null;
  const names = pins.map(p => p.name);
  [names[i], names[j]] = [names[j], names[i]];
  return names;
}

// Recent strip: the last `n` opened again on top, marked `recent`. Not for a list that short.
export function withRecent(list, n = 3) {
  const recent = list.filter(c => c.lastUsed).sort((a, b) => b.lastUsed - a.lastUsed).slice(0, n);
  return list.length > n && recent.length ? [...recent.map(c => ({ ...c, recent: true })), ...list] : list;
}

// Max rows setting -> list rows. Auto: fill in full screen, else 8.
export const maxListOf = (v, full = false) => (full && !Number(v) ? Infinity : Number(v) || MAX_VISIBLE_CHOICES);

// Folder shortcuts on the Shortcuts tab, app + URL shortcuts on the Apps tab.
export const inView = (view) => (c) => (view === 'apps') === !!(c.isApp || c.isUrl);

// Workspaces in the same { name, path, searchText } shape so filterChoices works on them.
function buildWorkspaceChoices() {
  return Object.entries(loadWorkspaces()).map(([name, entries]) => {
    const summary = (entries || []).map(describeEntry).join('  ');
    return { name, path: summary, entries: entries || [], searchText: `${name} ${summary}` };
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

// ~ or ~/x -> home dir.
export const expandHome = p => p.replace(/^~(?=$|[/\\])/, () => HOME);

const vis = ui.width;
// Selection highlight: dark gray bar (bright black on 16-color terminals).
const highlight = s => (chalk.level >= 2 ? chalk.bgAnsi256(238) : chalk.bgBlackBright)(s);
// Accent setting: colors the › pointers and the picked option.
const ACCENT = {
  green: s => chalk.green(s),
  blue: s => chalk.blueBright(s),
  purple: s => chalk.magentaBright(s),
  orange: s => (chalk.level >= 2 ? chalk.ansi256(208) : chalk.yellow)(s),
};
// Default: no color, the look before the setting existed. A hex is truecolor; chalk falls back to the nearest ansi256 / 16.
export const accentOf = key => ACCENT[key] || (isHex(key) ? s => chalk.hex(key)(s) : s => s);
// Paths setting for a target row (style path or url): dim parents (default), full (plain) or hidden.
export function pathLook(r, paths) {
  const style = r.style || 'path';
  if (style !== 'path' && style !== 'url') return r;
  if (paths === 'hidden') return { ...r, text: '' };
  return paths === 'full' ? { ...r, style: 'plain' } : r;
}
// Pinned badge.
export const PIN = '★';
// Badge words joined; a trailing ★ gets a space so it doesn't touch the edge.
export const badgeText = parts => { const t = parts.filter(Boolean).join(' '); return t.endsWith(PIN) ? `${t} ` : t; };
// Row details setting: does `what` ('tags' | 'badges') show? Unset = both.
export const showsDetail = (rowDetails = 'both', what) => rowDetails === 'both' || rowDetails === what;
// Glyphs setting ascii: hint keys spelled out (set per render), the rest of the frame goes through ui.toAscii.
let asciiHints = false;
const ASCII_KEYS = [['↑↓', 'up/down'], ['←→', 'left/right'], ['→', 'right'], ['←', 'left'], ['↵', 'enter'], ['⌫', 'bs']];
const hintKey = k => (asciiHints ? ASCII_KEYS.reduce((s, [a, b]) => s.replace(a, b), k) : k);
const keyHint = pairs => '  ' + pairs.filter(Boolean).map(([k, label]) => `${hintKey(k)} ${chalk.dim(label)}`).join('  ');
// One hint row of at most w columns: from the first pair that doesn't fit on, pairs are left out.
const fitHint = (pairs, w) => keyHint(pairs.filter(Boolean).filter((p, i, a) => vis(keyHint(a.slice(0, i + 1))) <= w));
// Fuse hit ranges are UTF-16 offsets, inclusive.
export const underlineHits = (s, hits = []) => ui.graphemes(s)
  .map(({ segment: g, index: i }) => (hits.some(([a, b]) => a < i + g.length && b >= i) ? chalk.underline(g) : g)).join('');

// Keeps the end of a too-long string, where the folder name is.
const clipStart = (s, n) => (vis(s) <= n ? s : n <= 1 ? '…'.slice(0, n) : `…${ui.fit(s, n - 1, true)}`);

// Word stops for ^←/^→ and word delete: path separators count, so ^⌫ drops one path segment.
const SEP = /[\s/\\._-]/;
const wordLeft = (t, i) => { while (i > 0 && SEP.test(t[i - 1])) i--; while (i > 0 && !SEP.test(t[i - 1])) i--; return i; };
const wordRight = (t, i) => { while (i < t.length && SEP.test(t[i])) i++; while (i < t.length && !SEP.test(t[i])) i++; return i; };
const stops = t => ui.graphemes(t).map(g => g.index).concat(t.length);
const prevStop = (t, i) => stops(t).filter(s => s < i).pop() ?? 0;
const nextStop = (t, i) => stops(t).find(s => s > i) ?? t.length;
// Ctrl+Backspace has no ctrl flag: terminals send 0x7f for Backspace and 0x08 for Ctrl+Backspace.
// Windows Node before 22.17 / 24.2 (no VT input) has the two swapped.
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
const swapped = os.platform() === 'win32' && (nodeMajor < 22 || nodeMajor === 23 || (nodeMajor === 22 && nodeMinor < 17) || (nodeMajor === 24 && nodeMinor < 2));
const CTRL_BACKSPACE = swapped ? '\x7f' : '\b';
const isWordBackspace = key => (key.ctrl && key.name === 'w') || (key.name === 'backspace' && (key.ctrl || key.meta || key.sequence === CTRL_BACKSPACE));
// Alt: a modifier code (\x1b[1;3A), or an Esc prefix (\x1b\x1b[A, older Windows Node and some terminals) readline leaves unflagged.
export const isAlt = key => !!key.meta || (key.sequence || '').startsWith('\x1b\x1b');

// Line editing for a text field at cursor `cur`: returns the new { text, cur }, or null when `key` isn't an edit key.
export function editLine({ text, cur }, str, key = {}) {
  const cut = (from, to) => ({ text: text.slice(0, from) + text.slice(to), cur: from });
  if (isWordBackspace(key)) return cut(wordLeft(text, cur), cur);
  if (key.name === 'backspace') return cut(prevStop(text, cur), cur);
  if (key.name === 'delete') return cut(cur, (key.ctrl || key.meta ? wordRight : nextStop)(text, cur));
  if (key.ctrl && key.name === 'u') return { text: '', cur: 0 };
  if (key.name === 'left') return { text, cur: (key.ctrl || key.meta ? wordLeft : prevStop)(text, cur) };
  if (key.name === 'right') return { text, cur: (key.ctrl || key.meta ? wordRight : nextStop)(text, cur) };
  if (key.name === 'home') return { text, cur: 0 };
  if (key.name === 'end') return { text, cur: text.length };
  if (!key.ctrl && !key.meta && str && str >= ' ' && str.charCodeAt(0) !== 127) {
    return { text: text.slice(0, cur) + str + text.slice(cur), cur: cur + str.length };
  }
  return null;
}

// A text field in `n` columns with the cursor drawn in; the text left of the cursor stays in view.
export function inputLine(text, cur, n) {
  const before = text.slice(0, cur);
  const after = text.slice(cur);
  const a = clipStart(before, Math.max(1, n - 1 - Math.min(vis(after), Math.floor(n / 3))));
  if (!after) return a + chalk.dim('▏');
  const room = Math.max(1, n - vis(a));
  const b = vis(after) <= room ? after : `${ui.fit(after, room - 1)}…`;
  const g = ui.graphemes(b)[0].segment;
  return a + chalk.inverse(g) + b.slice(g.length);
}

// Name clipped to `width` columns with …; highlight ranges past the cut are dropped.
export function clipName(name, width, hits = []) {
  if (vis(name) <= width) return { text: name, hits };
  const cut = ui.fit(name, Math.max(0, width - 1)).length;
  return { text: `${name.slice(0, cut)}…`, hits: hits.map(([a, b]) => [a, Math.min(b, cut - 1)]).filter(([a, b]) => a <= b) };
}

// One list row: "› name  path ..... #tags  badge". `style` = path | url | dim | plain (url looks plain).
function renderRow({ sel, mark, name, nameWidth, hits, text = '', style = 'path', right = '', cw, pick = s => s }) {
  const n = clipName(name, nameWidth, hits);
  const nm = chalk.bold(underlineHits(n.text, n.hits)) + ' '.repeat(Math.max(0, nameWidth - vis(n.text)));
  const room = cw - 2 - nameWidth - 2 - (right ? vis(right) + 2 : 0);
  const t = clipStart(text, Math.max(0, room));
  const body = sel || style === 'plain' || style === 'url' ? t : style === 'dim' ? chalk.dim(t) : ui.dimParent(t);
  const left = `${mark ? pick('●') : sel ? pick('›') : ' '} ${nm}  ${body}`;
  const line = sel || right ? left + ' '.repeat(Math.max(right ? 2 : 0, cw - vis(left) - vis(right))) + right : left;
  return `  ${sel ? highlight(line) : line}`;
}

// Name column width for a list of { name }.
const nameCol = list => Math.min(24, Math.max(12, ...list.map(c => vis(c.name))));

// Selector-style rows for the plain commands (ls, stale, stats, ...): { name, text?, style?, right? }.
// Piped (agents, grep): nothing clips, rows grow to fit instead.
export function printRows(items) {
  const piped = !process.stdout.isTTY;
  const nameWidth = piped ? Math.max(12, ...items.map(c => vis(c.name))) : nameCol(items);
  const fit = r => nameWidth + 4 + vis(r.text || '') + (r.right ? vis(r.right) + 2 : 0);
  const cw = Math.max(ui.cols(), ...(piped ? items.map(fit) : []));
  // Piped output keeps every path, agents read it.
  const paths = piped ? 'dim' : setting('paths');
  for (const r of items) console.log(renderRow({ nameWidth, cw, ...pathLook(r, paths) }));
}

// "‹ sel ›" bold, others dim; scrolls around the selection with ‹… / …› edges when the row is wider than `width`.
// `spans` (optional) gets { from, to, index } per visible part; an edge marker points at the hidden neighbour.
export function optionRow(all, sel, width, spans, pick = s => s) {
  // Clipped so even the selected one fits with its ‹ › and both edge markers.
  const labels = all.map(l => clipName(l, Math.max(1, width - 12)).text);
  const n = labels.length;
  const at = Math.max(0, sel);
  const size = (lo, hi) => labels.slice(lo, hi + 1).reduce((t, l, i) => t + vis(l) + (lo + i === sel ? 4 : 0), 0)
    + 2 * (hi - lo) + (lo > 0 ? 4 : 0) + (hi < n - 1 ? 4 : 0);
  let lo = at;
  let hi = at;
  for (let grew = true; grew;) {
    grew = false;
    if (hi < n - 1 && size(lo, hi + 1) <= width) { hi++; grew = true; }
    if (lo > 0 && size(lo - 1, hi) <= width) { lo--; grew = true; }
  }
  const parts = [
    lo > 0 && [lo - 1, chalk.dim('‹…')],
    ...labels.slice(lo, hi + 1).map((l, i) => [lo + i, lo + i === sel ? chalk.bold(pick(`‹ ${l} ›`)) : chalk.dim(l)]),
    hi < n - 1 && [hi + 1, chalk.dim('…›')],
  ].filter(Boolean);
  let col = 0;
  for (const [index, p] of parts) {
    spans?.push({ from: col, to: col + vis(p), index });
    col += vis(p) + 2;
  }
  return parts.map(([, p]) => p).join('  ');
}

// First target under a 1-based mouse cell; the full-screen frame starts at row 1.
export const hitTest = (targets, x, y) => targets.find(t => t.line === y - 1 && x - 1 >= t.from && x - 1 < t.to);

// Row click: 'open' | 'select' | 'skip'. The selected row opens; so does a quick second click on the same line
// (the list may have scrolled), unless the first one already opened. `last` = { y, at, opened } of the previous one.
export function rowClick(last, y, now, onSelected) {
  if (y === last.y && now - last.at < 400) return last.opened ? 'skip' : 'open';
  return onSelected ? 'open' : 'select';
}

// "b;x;yM" press / "b;x;ym" release. click = left button released, wheel = -1 up / 1 down.
function parseSgr(s) {
  const m = /^(\d+);(\d+);(\d+)([Mm])$/.exec(s);
  if (!m) return null;
  const b = Number(m[1]);
  const wheel = m[4] === 'M' && (b & 0xc2) === 64 ? (b & 1 ? 1 : -1) : 0;
  return { x: Number(m[2]), y: Number(m[3]), wheel, click: m[4] === 'm' && (b & 0xe3) === 0 };
}

// readline splits a mouse report into keypresses: '\x1b[<' then one per char of "b;x;yM" (SGR), or '\x1b[M' + 3 (X10).
// Feed every keypress through this: `pass` = a real key to handle, `event` = a finished report.
// An Esc just before a report arrives glued to it ('\x1b\x1b[<').
export function readMouse(state, key = {}) {
  const seq = key.sequence || '';
  if (seq.endsWith('\x1b[<')) return { state: '' };
  if (seq.endsWith('\x1b[M')) return { state: 3 };
  if (typeof state === 'number') return { state: state > 1 ? state - 1 : null };
  if (typeof state !== 'string') return { state: null, pass: true };
  if (/^[\d;]$/.test(seq) && state.length < 16) return { state: state + seq };
  if (seq === 'M' || seq === 'm') return { state: null, event: parseSgr(state + seq) };
  return { state: null, pass: true };
}

// Why a deleted { name, entry, ws? } (or a list of them) can't come back, or null: its name or an alias was taken since.
export function undoError(u, links, workspaces) {
  if (Array.isArray(u)) return u.map(x => undoError(x, links, workspaces)).find(Boolean) || null;
  const { name, entry, ws } = u;
  if (ws) return Object.hasOwn(workspaces, name) ? `workspace "${name}" already exists.` : null;
  return takenError(links, name) || checkAliases(links, name, aliasesOf(entry)).error || null;
}

function scrollHint(start, end, total) {
  const parts = [start > 0 && `↑ ${start} more`, end < total && `↓ ${total - end} more`].filter(Boolean);
  return parts.length ? chalk.dim(`    ${parts.join('   ')}`) : null;
}

// List rows that fit in `room` lines; one goes to the "↓ n more" hint when they don't all fit.
export const listRows = (total, room) => (total <= room ? total : Math.max(3, room - 1));

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
  edit: name => `path for "${name}" (empty = cwd):`,
  rename: name => `rename "${name}" to:`,
  add: () => 'new shortcut name (path = cwd):',
};

// Input a prompt starts with: the current path (^e) or name (^r), so Enter on it changes nothing.
export const prefill = (action, choice) => (action === 'edit' ? choice?.path : action === 'rename' ? choice?.name : '') || '';

// Terminal tabs open next to upex in Windows Terminal, so the selector stays open. `wt` is lazy.
export const staysOpen = (appKey, layout, wt) => isTerminalApp(appKey) && layout === 'tabs' && !!wt();

// Why Enter can't open this folder shortcut, or null. Checks the disk again: the list can be stale.
export const missingFlash = (c, exists = fs.existsSync) => (c.isApp || c.isUrl || exists(c.path) ? null : 'path missing, ^e to fix');

const VIEWS = { shortcuts: 'Shortcuts', apps: 'Apps', workspaces: 'Workspaces', settings: 'Settings' };
// Tab cycles the tabs the views setting shows; Settings sits outside the cycle on Shift+Tab, so Tab from it goes to Shortcuts.
export const nextView = (view, views) => { const c = shownTabs(views); return c[(c.indexOf(view) + 1) % c.length]; };
// Shift+Tab back from Settings: a tab hidden meanwhile goes to Shortcuts.
export const backTo = (view, views) => (shownTabs(views).includes(view) ? view : 'shortcuts');
const SETTING_ROWS = [
  { section: 'General', key: 'startView', label: 'Start view', names: { shortcuts: 'Shortcuts', apps: 'Apps', workspaces: 'Workspaces', last: 'Last used' } },
  { section: 'General', key: 'sort', label: 'Sort', names: { recent: 'Most used', name: 'A to Z', opened: 'Last opened', added: 'Recently added' } },
  { section: 'General', key: 'recentStrip', label: 'Recent on top', names: { off: 'Off', on: 'On' } },
  { section: 'General', key: 'views', label: 'Tabs', names: { all: 'All', 'no-workspaces': 'No Workspaces', 'no-apps': 'No Apps', shortcuts: 'Shortcuts only' } },
  { section: 'General', key: 'enter', label: 'Enter', names: { quit: 'Open and quit', stay: 'Open and stay' } },
  { section: 'Terminals', key: 'terminalLayout', label: 'Layout', names: { windows: 'Separate windows', tabs: 'Tabs', panes: 'Split panes' } },
  { section: 'Terminals', key: 'paneSplit', label: 'Pane split', names: { auto: 'Auto', vertical: 'Side by side', horizontal: 'Stacked' } },
  { section: 'Terminals', key: 'terminalShell', label: 'Shell', names: { cmd: 'cmd', powershell: 'PowerShell', pwsh: 'PowerShell 7', profile: 'WT profile' } },
  { section: 'Opening', key: 'defaultOpener', label: 'Default opener' },
  { section: 'Appearance', key: 'fullScreen', label: 'Full screen', names: { on: 'On', off: 'Off' } },
  { section: 'Appearance', key: 'keyHints', label: 'Key hints', names: { full: 'Full', short: 'Short', off: 'Off' } },
  { section: 'Appearance', key: 'maxRows', label: 'Max rows', names: { auto: 'Auto', 8: '8', 12: '12', 16: '16' } },
  { section: 'Appearance', key: 'accent', label: 'Accent', names: { default: 'Default', green: 'Green', blue: 'Blue', purple: 'Purple', orange: 'Orange' } },
  { section: 'Appearance', key: 'density', label: 'Density', names: { comfortable: 'Comfortable', compact: 'Compact' } },
  { section: 'Appearance', key: 'paths', label: 'Paths', names: { dim: 'Dim folders', full: 'Full', hidden: 'Hidden' } },
  { section: 'Appearance', key: 'rowDetails', label: 'Row details', names: { both: 'Both', tags: 'Tags', badges: 'Badges', none: 'None' } },
  { section: 'Appearance', key: 'pinned', label: 'Pinned', names: { top: 'On top', section: 'Own section' } },
  { section: 'Appearance', key: 'glyphs', label: 'Glyphs', names: { unicode: 'Unicode', ascii: 'ASCII' } },
  { section: 'Appearance', key: 'theme', label: 'Web theme', names: { system: 'System', dark: 'Dark', light: 'Light' } },
  { section: 'Detail pane', key: 'narrowPane', label: 'Narrow screens', names: { toggle: 'Shift+→ / ←', always: 'Always' } },
  { section: 'Detail pane', key: 'goals', label: 'Open goals', names: { off: 'Off', 3: '3', 5: '5', 10: '10' } },
  { section: 'Detail pane', key: 'git', label: 'Git status', names: { off: 'Off', on: 'On' } },
];
// Pane split only matters for split panes.
const visibleRows = s => SETTING_ROWS.filter(r => r.key !== 'paneSplit' || s.terminalLayout === 'panes');
// Inline, Max rows Auto is 8: one "8" option that keeps auto, so going full screen still fills.
const inlineRows = (row, s) => row.key === 'maxRows' && s.fullScreen === 'off';
// [key, label] options of a settings row, in SETTINGS order (object keys put "8" before "auto"); copy is no way
// to open a folder. A hex accent shows as its own option.
export const rowOptions = (row, appChoices, s = {}) => (inlineRows(row, s) ? [['auto', '8'], ['12', '12'], ['16', '16']]
  : row.names ? [...SETTINGS[row.key].map(k => [k, row.names[k] ?? k]), ...(row.key === 'accent' && isHex(s.accent) ? [[s.accent, s.accent]] : [])]
    : appChoices.filter(c => c.key !== 'copy').map(c => [c.key, c.label]));
// The option a row shows as picked.
export const pickedOf = (row, s) => (inlineRows(row, s) && s.maxRows === '8' ? 'auto' : s[row.key]);

function settingNote(key, s, wt) {
  if (key === 'startView') return 'The tab upex and upex ui open on. Last used: where you left off, opener included.';
  if (key === 'sort') return 'Shortcut order here and in upex ui.';
  if (key === 'recentStrip') return 'The last 3 opened again above the list, under a Recent heading, whatever the sort.';
  if (key === 'views') return 'Which tabs show and Tab cycles through, here and in upex ui.';
  if (key === 'enter') return 'Selector only. Open and stay keeps upex open after Enter, to open more.';
  if (key === 'maxRows') return s.fullScreen === 'off' ? 'List rows here.' : 'List rows here. Auto: as many as the screen fits.';
  if (key === 'defaultOpener') return 'Opens folder shortcuts that have no opener of their own.';
  if (key === 'fullScreen') return 'Whole terminal plus mouse, restored on exit. Off: inline, no mouse.';
  if (key === 'accent') return 'Color of the › pointer and the picked option, here and in upex ui. Any color: upex config set accent ff66aa';
  if (key === 'density') return 'Compact drops the spacer lines, here and in upex ui.';
  if (key === 'paths') return 'Paths in the lists here, in upex ls / stale and in upex ui.';
  if (key === 'rowDetails') return 'Right side of a row: #tags, badges (pinned, app, missing), both or none. Here, in upex ls and upex ui.';
  if (key === 'pinned') return 'Pinned shortcuts first, or first under their own Pinned heading. Here and in upex ui. ^p pins, Alt+↑↓ moves one.';
  if (key === 'narrowPane') return 'Under 140 columns (full screen): Shift+→ opens the pane, Shift+← or Esc closes it, or it always shows. Not under 60.';
  if (key === 'goals') return 'Pane right of the list (full screen): open upgo goals of a folder, up to this many. S-→ picks one to copy, a click copies it.';
  if (key === 'git') return 'Pane right of the list (full screen): branch, ahead/behind, changes and last commit of a folder in git. ^g opens its web page.';
  if (key === 'keyHints') return 'Key rows under the list. Short: one row of the main keys. Off: more room for the list. Settings keeps its keys.';
  if (key === 'glyphs') return 'Selector only. ASCII swaps arrows, pointers, lines and the ellipsis for plain characters, for fonts that show boxes.';
  if (key === 'theme') return 'upex ui only. The terminal keeps its own colors.';
  if (wt === null) return 'Windows only. Other systems use their own terminal.';
  if (key === 'terminalLayout') {
    return !wt && s.terminalLayout !== 'windows'
      ? 'Windows Terminal (wt) not found, so terminals open as separate windows.'
      : 'How several terminals open: separate windows, or tabs or panes in your current Windows Terminal window.';
  }
  if (key === 'paneSplit') return 'Where each new pane goes.';
  if (s.terminalShell !== 'profile') return 'The shell terminal openers start.';
  return wt ? 'Your Windows Terminal default profile. A start command (like claude) runs in cmd.' : 'Windows Terminal (wt) not found, so cmd opens instead.';
}

// "● upex ui running  http://host/?t=…": host bright, scheme and token dim, the whole link stays clickable.
function webStatus(url, w) {
  const { protocol, host } = new URL(url);
  const scheme = `${protocol}//`;
  const rest = url.slice(scheme.length + host.length);
  const left = `  ${chalk.green('●')} ${chalk.bold('upex ui')} ${chalk.dim('running')}  ${chalk.dim(scheme)}${host}${chalk.dim(rest)}`;
  const note = chalk.dim('stops when you quit');
  const gap = w - vis(left) - vis(note);
  return gap >= 2 ? left + ' '.repeat(gap) + note : left;
}

// upgo goals.json: open items (planned, partial), soonest phase first, then file order.
const PHASE_ORDER = ['now', 'next', 'later', 'wayLater', 'maybe'];
export function goalSummary(file) {
  if (!Array.isArray(file?.items)) return null;
  const open = file.items.filter(i => ['planned', 'partial'].includes(i?.status));
  const rank = i => (PHASE_ORDER.indexOf(i.phase) + PHASE_ORDER.length + 1) % (PHASE_ORDER.length + 1);
  return { open: open.length, next: [...open].sort((a, b) => rank(a) - rank(b)) };
}
// Per goals.json, read again only when it changes. Missing or broken: null.
const goalCache = new Map();
export function goalsOf(dir) {
  const file = path.join(dir, 'goals.json');
  let mtime;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return null; }
  if (goalCache.get(file)?.mtime !== mtime) {
    let goals = null;
    try { goals = goalSummary(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* not a goals file */ }
    goalCache.set(file, { mtime, goals });
  }
  return goalCache.get(file).goals;
}
const isFolder = c => !!(c && !c.entries && !c.isApp && !c.isUrl && c.path && c.exists !== false);
// Goals the detail pane shows for a row, `max` from the goals setting ('off' = none): folder shortcuts only.
function folderGoals(c, max) {
  const g = Number(max) > 0 && isFolder(c) && goalsOf(c.path);
  return g ? { open: g.open, next: g.next.slice(0, Number(max)) } : null;
}
// Git status the pane shows for a row (git setting on, folder shortcuts only); `gitFor(dir)` never blocks.
const folderGit = (c, on, gitFor) => (on === 'on' && isFolder(c) ? gitFor(c.path) : null);
// Short name of a repo's web host for the ^g hint: github, gitlab, ... (a one-label host as is).
const hostName = url => new URL(url).hostname.split('.').slice(-2)[0];
// What Enter copies in the goal picker: "id: title" and the body below.
export const goalText = g => [[g.id, g.title].filter(Boolean).join(': '), g.body].filter(Boolean).join('\n');
// goals.json is not ours: one line, control characters (escapes included) dropped.
// eslint-disable-next-line no-control-regex
export const oneLine = v => String(v ?? '').replace(/[\s\x00-\x1f\x7f-\x9f]+/g, ' ').trim();

// Pane lines of a git status from gitOf; the web line is { text, web } so a click opens it.
export function gitLines(g, pw, now = Date.now()) {
  const row = (k, v) => `${chalk.dim(k.padEnd(10))}${v}`;
  const ab = [g.ahead && `↑${g.ahead}`, g.behind && `↓${g.behind}`].filter(Boolean).join(' ');
  const lines = [g.added && chalk.green(`+${g.added}`), g.deleted && chalk.red(`-${g.deleted}`)].filter(Boolean).join(' ');
  const out = ['', row('git', `${oneLine(g.branch) || '?'}${ab ? `  ${ab}` : ''}`),
    row('changes', g.changed ? `${g.changed} file${g.changed > 1 ? 's' : ''}${lines ? `  ${lines}` : ''}` : chalk.dim('clean'))];
  // Age first, so a long subject clips and the age stays.
  if (g.last) out.push(row('commit', `${chalk.dim(`${ui.span(now - g.last.time)} ago`)}  ${oneLine(g.last.subject)}`));
  if (g.web) out.push({ text: ui.truncate(row('web', `${g.web.replace(/^https:\/\//, '')}  ${chalk.dim('^g')}`), pw), web: true });
  return out;
}

// Detail pane lines for the selected row, each at most `pw` wide; clickable ones are { text, web | copy, msg }.
// `goals` from goalSummary, `sel` the picked one.
export function detailLines(c, pw, appChoices = [], now = Date.now(), { goals = null, sel = -1, pick = chalk.bold, git = null } = {}) {
  if (!c) return [];
  const row = (k, v) => (v ? `${chalk.dim(k.padEnd(10))}${String(v)}` : null);
  const badge = c.entries ? '' : c.exists === false ? chalk.red('missing') : c.pinned ? `${PIN} pinned` : '';
  const head = clipName(c.name, Math.max(1, pw - vis(badge) - 2)).text;
  const out = [chalk.bold(head) + (badge ? ' '.repeat(pw - vis(head) - vis(badge)) + badge : '')];
  if (c.entries) return [...out, '', ...c.entries.map(describeEntry)].map(l => ui.truncate(l, pw));
  // The full target, wrapped instead of clipped (4 lines at most).
  // A click on it copies it, like ^y.
  for (let p = c.path || '', n = 0; p && n < 4; n++) {
    const part = ui.fit(p, pw) || p[0];
    out.push({ text: c.isUrl || c.isApp ? part : ui.dimParent(part), copy: c.path, msg: `copied ${c.path}` });
    p = p.slice(part.length);
  }
  const opener = c.opener && (appChoices.find(a => a.key === c.opener)?.label || c.opener);
  // Local day; a hand-edited bad value is left out (toISOString would throw).
  const added = new Date(c.added || NaN);
  out.push('',
    row('type', c.isCmd ? 'command' : c.isApp ? 'app' : c.isUrl ? 'url' : 'folder'),
    row('opens in', opener),
    row('aliases', c.aliases?.join(' ')),
    row('tags', c.tags?.length && `#${c.tags.join(' #')}`),
    row('opened', c.uses ? `${c.uses}×${c.lastUsed ? `, last ${ui.span(now - c.lastUsed)} ago` : ''}` : 'never'),
    row('added', !isNaN(added) && added.toLocaleDateString('sv-SE')),
    row('expires', c.expires && `in ${ui.span(c.expires - now, Math.ceil)}`));
  if (git) out.push(...gitLines(git, pw, now));
  // Title clipped, so its phase stays in view. A click copies it, like Enter in the picker.
  if (goals) {
    out.push('', row('goals', `${goals.open} open`), ...goals.next.map((g, i) => {
      const phase = chalk.dim(` ${oneLine(g.phase)}`);
      const title = ui.truncate(oneLine(g.title ?? g.id), Math.max(1, pw - 10 - vis(phase)));
      const text = (i === sel ? `${' '.repeat(8)}${pick('›')} ${chalk.bold(title)}` : ' '.repeat(10) + title) + phase;
      return { text, copy: goalText(g), msg: `copied "${oneLine(g.id ?? g.title)}"` };
    }));
  }
  return out.filter(l => l !== null).map(l => (l.text != null ? { ...l, text: ui.truncate(l.text, pw) } : ui.truncate(l, pw)));
}

// Script picker in the pane, `rows` tall: a heading, then the scripts around `sel` as { text, i }.
// No 3-row floor like listRows: the pane cuts overflow, which could hide the picked one.
export function scriptLines({ list }, sel, pw, rows, pick = chalk.bold) {
  const room = Math.max(1, rows - 2);
  const { start, end } = getVisibleWindow(list, sel, list.length <= room ? room : Math.max(1, room - 1));
  const nw = Math.min(nameCol(list), Math.floor(pw / 2));
  const out = [`${chalk.bold('scripts')}${chalk.dim(` ${list.length}`)}`, ''];
  for (let i = start; i < end; i++) {
    const name = clipName(list[i].name, nw).text;
    const lead = i === sel ? `${pick('›')} ${chalk.bold(name)}` : `  ${name}`;
    out.push({ text: ui.truncate(`${lead}${' '.repeat(nw - vis(name) + 2)}${chalk.dim(list[i].path)}`, pw), i });
  }
  const more = scrollHint(start, end, list.length);
  return more ? [...out, ui.truncate(more, pw)] : out;
}

// Pane with marks, `rows` tall: each marked row and what Enter opens it in, then what ^d does.
// `marked` [{ c, app, count }] as Enter would open them.
export function markLines(marked, pw, rows, appChoices = [], pick = chalk.bold) {
  const n = marked.length;
  const nw = Math.min(nameCol(marked.map(m => m.c)), Math.floor(pw / 2));
  // Head, blank, Enter line, blank and ^d line take 5; a cut list ends in "↓ n more".
  const room = Math.max(1, rows - 5);
  const shown = n <= room ? marked : marked.slice(0, Math.max(1, room - 1));
  const how = ({ c, app, count }) => (c.exists === false ? chalk.red('missing') : c.isUrl ? 'browser' : c.isApp ? 'launches'
    : `${appChoices.find(a => a.key === app)?.label || app}${count > 1 ? ` ×${count}` : ''}`);
  const out = [`${pick('●')} ${chalk.bold(`${n} marked`)}`, '', `${hintKey('↵')} ${chalk.dim('opens')}`,
    ...shown.map((m) => {
      const name = clipName(m.c.name, nw).text;
      return `  ${name}${' '.repeat(nw - vis(name) + 2)}${how(m)}`;
    })];
  if (shown.length < n) out.push(chalk.dim(`  ↓ ${n - shown.length} more`));
  out.push('', `${hintKey('^d')} ${chalk.dim(`deletes ${n > 1 ? `all ${n}` : 'it'}, ^z undo`)}`);
  return out.map(l => ui.truncate(l, pw));
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
  inputCursor = inputBuffer.length,
  flash = '',
  undo = false,
  settings = {},
  settingIndex = 0,
  wt = null,
  counts = {},
  webUrl = '', // upex ui started with ^u
  scripts = null, // script picker (mode 'scripts'): { pm, list: [{ name, path: command }] }
  scriptIndex = 0,
  marks = new Set(), // marked shortcut names (Space)
  marked = [], // the marked rows as Enter opens them: [{ c, app, count }]
  goalIndex = 0, // goal picker (mode 'goals', S-→ into the pane)
  gitFor = gitOf, // dir -> cached git status or null, never blocks
  width = 80,
  height = 24,
  maxList = Infinity,
  full = false, // full screen: footer at the bottom, detail pane when wide
  paneOpen = false, // detail pane opened with Shift+Right on a narrow screen
  targets = null, // optional out: clickable { line, from, to, tab | row | opener | web | copy + msg | setting [+ option] }
}) {
  asciiHints = settings.glyphs === 'ascii';
  const isWs = view === 'workspaces';
  const isSettings = view === 'settings';
  const isScripts = mode === 'scripts' && !!scripts;
  const currentChoice = (isWs ? workspaces : choices)[isWs ? wsIndex : selectedIndex];
  // `width` leaves the terminal's last column free.
  const pane = !isSettings && paneShown(width + 1, full, paneOpen || settings.narrowPane === 'always');
  const toggles = !isSettings && paneToggles(width + 1, full, settings);
  // Scripts go in the pane when there is one, else they replace the list.
  const listScripts = isScripts && !pane;
  const list = listScripts ? scripts.list : isWs ? workspaces : choices;
  const index = listScripts ? scriptIndex : isWs ? wsIndex : selectedIndex;
  // Workspace and script rows: plain text, no badges.
  const plain = isWs || listScripts;
  // With marks, the pane lists them instead of the selected row.
  const marking = pane && !isWs && !isScripts && marked.length > 0;
  const goals = pane && !isWs && !marking ? folderGoals(currentChoice, settings.goals) : null;
  const isGoals = mode === 'goals' && !!goals?.next.length;
  const git = pane && !isWs && !isScripts && !marking ? folderGit(currentChoice, settings.git, gitFor) : null;
  const w = Math.max(width, 20);
  const pw = pane ? Math.min(72, Math.floor(w * 0.38)) : 0; // pane width
  const lw = pane ? w - pw - 3 : w; // list width, " │ " between
  const cw = lw - 2; // row width after the 2-space indent
  // With the pane, the rules join its │ with ┬ (top) and ┴ (bottom).
  const ruleText = j => (pane ? `  ${'─'.repeat(lw - 1)}${j}${'─'.repeat(pw + 1)}` : `  ${'─'.repeat(w - 2)}`);
  const ruleOf = j => chalk.dim(ruleText(j));
  // A plain string is a warning; { text, ok: true } a success. One line, right end of the bottom rule, so nothing moves.
  const flashText = flash ? ui.truncate(` ${String(flash.text ?? flash).replace(/\s*\n\s*/g, ' ')} `, w - 6) : '';
  const flashOn = (flash.ok ? chalk.green : chalk.yellow)(flashText);
  const at = w - vis(flashText) - 2;
  const rule = flash ? chalk.dim(ruleText('┴').slice(0, at)) + flashOn + chalk.dim(ruleText('┴').slice(at + vis(flashText))) : ruleOf('┴');
  const terminal = isTerminalApp(appChoices[selectedAppIndex]?.key);
  const pick = accentOf(settings.accent);
  // Compact: no spacer lines.
  const gap = settings.density === 'compact' ? [] : [''];

  const lines = [...gap];
  const hit = (line, from, to, t) => { targets?.push({ line, from, to, ...t }); return to; };

  // Header: name, tabs (active one highlighted), Settings on the right.
  const tab = (key) => {
    const n = counts[key] != null ? ` ${counts[key]}` : '';
    return key === view ? highlight(chalk.bold(` ${VIEWS[key]}${n} `)) : ` ${VIEWS[key]}${chalk.dim(n)} `;
  };
  const headLead = `  ${chalk.bold('upex')}   `;
  const cycle = shownTabs(settings.views);
  const headLeft = headLead + cycle.map(tab).join(' ');
  const headRight = `${tab('settings')} ${chalk.dim('S-Tab')}`;
  const head = headLeft + ' '.repeat(Math.max(2, w - vis(headLeft) - vis(headRight))) + headRight;
  let col = vis(headLead);
  const headLine = lines.length;
  for (const key of cycle) col = hit(headLine, col, col + vis(tab(key)), { tab: key }) + 1;
  hit(headLine, vis(head) - vis(headRight), vis(head) - vis(headRight) + vis(tab('settings')), { tab: 'settings' });
  lines.push(head, ...gap);

  // Prompt line: filter, or the live action (input / delete confirm).
  if (mode === 'input') {
    const label = PROMPT_LABEL[action](clipName(currentChoice?.name || '', 24).text);
    // Keep the end of a long value in view, where the cursor is.
    lines.push(`  ${chalk.bold(pick('›'))} ${label} ${inputLine(inputBuffer, inputCursor, Math.max(1, w - vis(label) - 5))}`);
  } else if (mode === 'confirm') {
    const what = `  ? delete ${isWs ? 'workspace ' : ''}`;
    // Clip the name, not the line, so "y / n" stays visible.
    const name = clipName(currentChoice?.name || '', Math.max(1, w - vis(what) - 10)).text;
    lines.push(chalk.yellow(!isWs && marks.size ? `${what}${marks.size} marked?` : `${what}"${name}"?`) + chalk.dim('  y / n'));
  } else if (isScripts) {
    const name = clipName(currentChoice?.name || '', 24).text;
    lines.push(`  ${chalk.bold(pick('›'))} ${chalk.dim('run a script of')} ${chalk.bold(name)} ${chalk.dim(`(${scripts.pm})`)}`);
  } else if (isGoals) {
    lines.push(`  ${chalk.bold(pick('›'))} ${chalk.dim('copy a goal of')} ${chalk.bold(clipName(currentChoice.name, 24).text)}`);
  } else if (!isSettings) {
    const left = `  ${chalk.bold(pick('›'))} ${query ? `${query}${chalk.dim('▏')}` : chalk.dim('▏type to filter')}`;
    const right = !isWs && marks.size ? pick(`● ${marks.size} marked`) : '';
    lines.push(right ? left + ' '.repeat(Math.max(2, w - vis(left) - vis(right))) + right : left);
  }
  lines.push(isSettings ? ruleOf('┴') : ruleOf('┬'));
  const bodyStart = lines.length;

  // Rows under the body: footer rows and their rule, or just a flash row.
  const footRows = rows => (rows.length ? rows.length + 1 : flash ? 1 : 0);
  // Full screen: blank rows push the footer (its rule included) to the bottom.
  const pin = (rows) => { if (full) while (lines.length + footRows(rows) < height) lines.push(''); };
  // No rows (key hints off): no rule either, the flash gets its own row.
  const footer = (rows) => {
    pin(rows);
    if (rows.length) lines.push(rule, ...rows);
    else if (flash) lines.push(' '.repeat(Math.max(0, w - vis(flashText))) + flashOn);
    return lines.join('\n');
  };
  const next = nextView(view, settings.views);
  // Only Shortcuts shown: Tab there does nothing.
  const tabKey = next !== view && ['tab', VIEWS[next].toLowerCase()];
  const many = !isWs && !isSettings && marks.size;
  const escKey = ['esc', isScripts ? 'back' : mode !== 'browse' ? 'cancel' : query ? 'clear' : many ? 'unmark' : toggles && pane ? 'hide details' : 'quit'];
  const undoKey = undo && ['^z', 'undo'];
  const uiKey = ['^u', webUrl ? 'stop web ui' : 'web ui'];
  // Blank row first, so the link sits apart from the key hints.
  const webRows = webUrl ? [...gap, webStatus(webUrl, w)] : [];

  if (isSettings) {
    const rows = visibleRows(settings);
    // Body lines { text, hits, i }: a bold heading where the section changes, then its rows.
    const body = [];
    rows.forEach((row, i) => {
      if (row.section !== rows[i - 1]?.section) {
        if (i) body.push(...gap.map(text => ({ text })));
        body.push({ text: `  ${chalk.bold(row.section)}` });
      }
      const opts = rowOptions(row, appChoices, settings);
      const sel = i === settingIndex;
      const spans = [];
      const picker = optionRow(opts.map(([, l]) => l), opts.findIndex(([k]) => k === pickedOf(row, settings)), w - 20, spans, pick);
      const hits = [...spans.map(s => [20 + s.from, 20 + s.to, { setting: i, option: s.index }]), [0, w, { setting: i }]];
      body.push({ text: `  ${sel ? pick('›') : ' '} ${(sel ? chalk.bold : chalk.dim)(row.label.padEnd(16))}${picker}`, hits, i });
    });
    // Too tall for the terminal: scroll so the picked row stays in view (note + footer take the rest).
    const room = height - lines.length - gap.length - 3 - webRows.length;
    const { start, end } = getVisibleWindow(body, body.findIndex(b => b.i === settingIndex), Math.max(1, room));
    for (const b of body.slice(start, end)) {
      for (const [from, to, t] of b.hits || []) hit(lines.length, from, to, t);
      lines.push(b.text);
    }
    lines.push(...gap, chalk.dim(`    ${settingNote(rows[settingIndex].key, settings, wt)}`));
    return footer([keyHint([['↑↓', 'setting'], ['←→', 'change (saved)'], tabKey, ['S-Tab', 'back'], ['esc', 'quit'], uiKey]), ...webRows]);
  }

  const openerSpans = [];
  const openers = optionRow(appChoices.map(c => `${c.label}${isTerminalApp(c.key) && cmdCount > 1 ? ` ×${cmdCount}` : ''}`), selectedAppIndex, w - 13, openerSpans, pick);
  const isShortcuts = view === 'shortcuts';
  const openKey = ['↵', many ? `open ${many} marked` : isShortcuts ? 'open' : isWs ? 'open all' : currentChoice?.isUrl ? 'open in browser' : 'launch app'];
  const markKey = !isWs && list.length > 0 && ['space', 'mark'];
  const opener = isShortcuts && ['←→', 'opener'];
  const windows = isShortcuts && terminal && ['S-↑↓', 'windows'];
  const scriptsKey = isShortcuts && ['^s', 'scripts'];
  const movePin = !isWs && !query?.trim() && currentChoice?.pinned && ['A-↑↓', 'move pin'];
  const goalsKey = goals?.next.length && ['S-→', 'goals'];
  const webKey = git?.web && ['^g', hostName(git.web)];
  const paneKey = toggles && (pane ? ['S-←', 'hide details'] : ['S-→', 'details']);
  // Esc already says "hide details": no second hint, so goals and ^g still fit on narrow screens.
  const navRow = [openKey, scriptsKey, ['↑↓', 'move'], opener, windows, tabKey, escKey, escKey[1] !== paneKey[1] && paneKey, movePin, markKey, goalsKey, webKey];
  const actRow = [isShortcuts && ['^a', 'add'], isShortcuts && ['^e', 'edit path'], !isWs && ['^r', 'rename'],
    !isWs && list.length > 0 && ['^p', currentChoice?.pinned ? 'unpin' : 'pin'], ['^d', many ? `delete ${many} marked` : 'delete'], undoKey];
  // Last in their rows, so a narrow terminal drops them first.
  const copyKey = !isWs && list.length > 0 && ['^y', 'copy'];
  const inputRow = keyHint([['↵', 'save'], ['←→', 'cursor'], ['^⌫', 'word'], ['^u', 'clear'], ['esc', 'cancel']]);
  // Key hints setting. Full: two rows (typing: input keys, same height so the list stays put). Short: one row
  // without the keys you learn first (↑↓, tab, esc), cut to the width. Off: none.
  const hints = settings.keyHints === 'off' ? []
    : settings.keyHints === 'short' ? [mode === 'input' ? inputRow : fitHint([openKey, opener, windows, ...actRow, markKey, scriptsKey, goalsKey, webKey, paneKey, uiKey, copyKey, movePin], w)]
      : mode === 'input' ? [inputRow, ''] : [fitHint(navRow, w), fitHint([...actRow, uiKey, copyKey], w)];
  const foot = isScripts ? (hints.length ? [keyHint([['↵', 'run in a terminal'], ['↑↓', 'move'], escKey])] : [])
    : isGoals ? (hints.length ? [keyHint([['↵', 'copy'], ['↑↓', 'move'], ['esc', 'back']])] : [])
    : [...(isShortcuts ? [`  ${chalk.dim('open with')}  ${openers}`, ...(hints.length ? gap : [])] : []), ...hints];
  // No footer rows above it: no blank row under the rule.
  foot.push(...(foot.length ? webRows : webRows.slice(-1)));

  if (list.length === 0) {
    const empty = {
      workspaces: 'No workspaces yet. Add one: upex ws add <name> <shortcut> [app], or use upex ui',
      apps: 'No app or URL shortcuts yet. Add one: upex add <name> <exe> --app',
      shortcuts: 'No folder shortcuts yet. Add one with ^A (uses the current folder)',
    };
    lines.push(query ? chalk.yellow('    no matches') : chalk.dim(`    ${empty[view]}`));
  } else {
    const nameWidth = nameCol(list);
    // Rows left after the header and the footer (its rule included).
    const room = height - lines.length - footRows(foot);
    // Pinned setting 'section': Pinned / All headings, unless a search reorders the list.
    // Recent strip rows (withRecent) go under their own Recent heading.
    const heads = settings.pinned === 'section' && !plain && !query?.trim() && list.find(c => !c.recent)?.pinned;
    const group = c => (c.recent ? 'Recent' : heads && c.pinned ? 'Pinned' : 'All');
    const items = list.flatMap((c, i) => [
      ...((heads || list[0]?.recent) && (i === 0 || group(c) !== group(list[i - 1])) ? [{ head: group(c) }] : []),
      { i },
    ]);
    const { start, end } = getVisibleWindow(items, items.findIndex(x => x.i === index), Math.min(maxList, listRows(items.length, room)));
    const tagsOn = !plain && showsDetail(settings.rowDetails, 'tags');
    const badgesOn = !plain && showsDetail(settings.rowDetails, 'badges');
    for (const { head, i } of items.slice(start, end)) {
      if (head) { lines.push(chalk.dim(`    ${head}`)); continue; }
      const c = list[i];
      const tags = tagsOn && c.tags?.length ? chalk.dim(`#${c.tags.join(' #')}`) : '';
      const kind = c.isCmd ? 'cmd' : c.isApp ? 'app' : c.isUrl ? 'url' : '';
      const badge = !badgesOn ? '' : !c.exists ? chalk.red('missing') : chalk.dim(badgeText([c.pinned && group(c) !== 'Pinned' && PIN, kind]));
      // Picking in the pane: its rows are the clickable ones.
      if (!isScripts || listScripts) hit(lines.length, 0, lw, { row: i });
      lines.push(renderRow(pathLook({
        sel: i === index,
        mark: !plain && marks.has(c.name),
        name: c.name,
        nameWidth,
        hits: c.hits,
        text: plain || c.isUrl ? c.path : tidyPath(c.path),
        style: plain ? 'dim' : c.isUrl ? 'url' : 'path',
        right: [tags, badge].filter(Boolean).join('  '),
        cw,
        pick,
      }, settings.paths)));
    }
    // Counts rows, not headings.
    const rowsIn = a => a.filter(x => !x.head).length;
    const more = scrollHint(rowsIn(items.slice(0, start)), list.length - rowsIn(items.slice(end)), list.length);
    if (more) lines.push(more);
  }

  // Before the opener hit below and the pane, which runs down to the footer.
  pin(foot);
  // Detail pane: the selected row's details right of the list, top-aligned.
  if (pane) {
    const sel = isGoals ? Math.min(goalIndex, goals.next.length - 1) : -1;
    const detail = isScripts ? scriptLines(scripts, scriptIndex, pw, lines.length - bodyStart, pick)
      : marking ? markLines(marked, pw, lines.length - bodyStart, appChoices, pick)
      : detailLines(currentChoice, pw, appChoices, Date.now(), { goals, sel, pick, git });
    // Picking and taller than the pane: scroll to its end (the goals), the picked one in view.
    const skip = isGoals ? Math.max(0, Math.min(detail.length - (lines.length - bodyStart), detail.length - goals.next.length + sel)) : 0;
    for (let i = bodyStart; i < lines.length; i++) {
      const d = detail[i - bodyStart + skip];
      // A script row { text, i } is clickable right of the │.
      if (d?.i != null) hit(i, lw + 3, w, { row: d.i });
      if (d?.web) hit(i, lw + 3, w, { web: true });
      if (d?.copy) hit(i, lw + 3, w, { copy: d.copy, msg: d.msg });
      const l = ui.truncate(lines[i], lw);
      lines[i] = `${l}${' '.repeat(Math.max(0, lw - vis(l)))}${chalk.dim(' │ ')}${d?.text ?? d ?? ''}`;
    }
  }
  // The opener row is the first footer row, after its rule; "  open with  " is 13 wide.
  if (isShortcuts && !isScripts && !isGoals) for (const s of openerSpans) hit(lines.length + 1, 13 + s.from, 13 + s.to, { opener: s.index });
  return footer(foot);
}

export async function runInteractiveMode({ preferredApp, stdin = process.stdin, stdout = process.stdout } = {}) {
  let allChoices = buildChoices();
  const appChoices = getInteractiveAppChoices();
  // A default opener outside the usual row (e.g. "open") still needs a slot to preselect.
  const appMap = getAppMap();
  let fallback = defaultOpener();
  const config = loadConfig();
  // Start view 'last' also brings back the opener picked last time.
  // Copy left the opener row (^y now): a remembered copy is dropped.
  const lastOpener = !preferredApp && setting('startView', config) === 'last' && config.lastOpener !== 'copy' && Object.hasOwn(appMap, String(config.lastOpener)) ? config.lastOpener : null;
  for (const key of new Set([fallback, lastOpener, ...allChoices.map(c => c.opener)])) {
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
    // Tab cycles 'shortcuts' | 'apps' | 'workspaces'; --app only matters on Shortcuts.
    let view = preferredApp ? 'shortcuts' : startTab(config);
    let choices = allChoices.filter(inView(view));
    let filteredChoices = choices;
    let selectedIndex = 0;
    let wsChoices = buildWorkspaceChoices();
    let filteredWs = wsChoices;
    let wsIndex = 0;
    let cmdCount = 1;
    let frame = [];   // inline mode: lines drawn last time
    let alt = false;  // on the alternate screen
    let mode = 'browse';   // 'browse' | 'input' | 'confirm' | 'scripts' | 'goals'
    let paneOpen = false;  // Shift+Right on a narrow screen
    let goalIndex = 0;     // goal picker
    let scripts = null;    // script picker: { pm, list }
    let scriptIndex = 0;
    let action = null;     // 'edit' | 'rename' | 'add'
    let inputBuffer = '';
    let inputCursor = 0;
    let flash = '';
    let undo = null; // last delete: [{ name, entry, ws? }]
    const marks = new Set(); // Space-marked shortcut names, across filtering and tabs
    let backView = view; // where Shift+Tab returns from Settings
    let settings = readSettings(); // appearance applies on every tab
    let settingIndex = 0;
    let wt = null;
    const appIndex = (key) => appChoices.findIndex(choice => choice.key === key);
    // A folder's own opener, else the default.
    const ownOpener = c => (appIndex(c?.opener) >= 0 ? c.opener : fallback);
    let selectedAppIndex = Math.max(0, appIndex(preferredApp || lastOpener || fallback));
    // Until Left/Right (or --app) picks one, the opener follows the shortcut's default opener.
    let appPicked = !!(preferredApp || lastOpener);
    // Marked rows as Enter opens them: folders in the picked opener, else their own; apps and URLs launch directly.
    const markedPlan = () => {
      const picked = appPicked && (appChoices[selectedAppIndex]?.key || fallback);
      return allChoices.filter(c => marks.has(c.name)).map((c) => {
        const app = c.isApp || c.isUrl ? null : picked || ownOpener(c);
        return { c, app, count: isTerminalApp(app) ? cmdCount : 1 };
      });
    };
    let targets = [];   // clickable areas of the last frame
    let mouse = null;   // readMouse state
    let lastClick = {}; // { y, at } for double-click
    let web = null;     // upex ui from ^u: { server, url, restore }, stopped when the selector closes

    // Counts rows at the current width, so a resize that rewrapped the last frame still clears all of it.
    const clearRendered = () => {
      const cols = stdout.columns || 80;
      const up = frame.reduce((n, l) => n + Math.max(1, Math.ceil(vis(l) / cols)), 0);
      if (up > 0) {
        readline.moveCursor(stdout, 0, -up);
        readline.clearScreenDown(stdout);
      }
      frame = [];
    };

    const setFullScreen = (on) => {
      if (on === alt) return;
      if (on) clearRendered();
      stdout.write(on ? ALT_ON + MOUSE_ON : MOUSE_OFF + ALT_OFF);
      alt = on;
    };

    const redraw = () => {
      if (!appPicked && view === 'shortcuts') {
        selectedAppIndex = Math.max(0, appIndex(ownOpener(filteredChoices[selectedIndex])));
      }
      // Goal picker whose pane or goals went away (resize): back to browse.
      if (mode === 'goals' && !paneGoals()?.next.length) mode = 'browse';
      // Clip to terminal width: a wrapped line takes 2+ rows and would leave stale rows behind.
      const width = Math.max(1, (stdout.columns || 80) - 1);
      // Inline: the trailing newline takes a row, and the list keeps its old compact size.
      const height = Math.max(1, (stdout.rows || 24) - (alt ? 0 : 1));
      targets = [];
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
        inputCursor,
        flash,
        undo: !!undo,
        settings,
        settingIndex,
        wt,
        webUrl: web?.url,
        scripts,
        scriptIndex,
        marks,
        marked: marks.size ? markedPlan() : [],
        goalIndex,
        gitFor,
        counts: { shortcuts: allChoices.filter(inView('shortcuts')).length, apps: allChoices.filter(inView('apps')).length, workspaces: wsChoices.length },
        width,
        height,
        maxList: maxListOf(settings.maxRows, alt),
        full: alt,
        paneOpen,
        targets,
      });
      // Never taller than the screen, or the top scrolls away and frames stack up.
      const clipped = output.split('\n').slice(0, height).map(line => ui.truncate(line, width)).map(settings.glyphs === 'ascii' ? ui.toAscii : l => l);

      if (alt) {
        stdout.write(`\x1b[H${clipped.join('\x1b[K\n')}\x1b[K\x1b[J`);
        return;
      }
      clearRendered();
      stdout.write(clipped.join('\n') + '\n');
      frame = clipped;
    };

    const updateFilter = () => {
      filteredWs = filterChoices(wsChoices, query);
      wsIndex = Math.max(0, Math.min(wsIndex, filteredWs.length - 1));
      filteredChoices = filterChoices(choices, query);
      if (!query.trim() && settings.recentStrip === 'on') filteredChoices = withRecent(filteredChoices);
      if (filteredChoices.length === 0) {
        selectedIndex = 0;
        return;
      }
      if (selectedIndex >= filteredChoices.length) {
        selectedIndex = filteredChoices.length - 1;
      }
    };

    // Select these again when they're still in the filtered lists; `recent` prefers the Recent strip copy.
    const reselect = (name, wsName, recent = false) => {
      const same = filteredChoices.findIndex(c => c.name === name && !!c.recent === recent);
      const i = same >= 0 ? same : filteredChoices.findIndex(c => c.name === name);
      if (i >= 0) selectedIndex = i;
      const j = filteredWs.findIndex(c => c.name === wsName);
      if (j >= 0) wsIndex = j;
    };

    // Reload from disk after a mutation and try to keep `name` / `wsName` selected.
    const rebuild = (name, wsName) => {
      const recent = !!filteredChoices[selectedIndex]?.recent;
      allChoices = buildChoices();
      choices = allChoices.filter(inView(view));
      wsChoices = buildWorkspaceChoices();
      for (const n of marks) if (!allChoices.some(c => c.name === n)) marks.delete(n);
      updateFilter();
      reselect(name, wsName, recent);
    };

    const clearQuery = () => {
      const keep = [filteredChoices[selectedIndex]?.name, filteredWs[wsIndex]?.name];
      query = '';
      updateFilter();
      reselect(...keep);
    };

    // Success messages fade after 3s; warnings stay until the next key.
    let flashTimer = null;
    const done = (text) => {
      const f = flash = { text, ok: true };
      clearTimeout(flashTimer);
      flashTimer = setTimeout(guard(() => { if (flash === f) { flash = ''; redraw(); } }), 3000);
    };
    const howMany = names => (names.length > 1 ? `${names.length} shortcuts` : `"${names[0]}"`);

    // Opens workspace-style entries without leaving the selector, then flashes `msg` and keeps `keep` ([name, wsName]) selected.
    // handleOpen runs synchronously, so console is muted just for the calls; a failure's first line is its reason.
    const openHere = (entries, msg, keep = []) => {
      const { log, error } = console;
      const outs = [];
      let runs;
      try {
        runs = entries.map(({ shortcut, app, count = 1, start = '' }) => {
          const out = [];
          outs.push(out);
          console.log = console.error = (...a) => out.push(ui.stripAnsi(a.join(' ')).trim());
          return handleOpen(shortcut, app || undefined, count, start, { batch: true });
        });
      } finally {
        Object.assign(console, { log, error });
      }
      Promise.all(runs).then(guard((oks) => {
        const fails = oks.flatMap((ok, i) => (ok ? [] : [(outs[i].find(Boolean) || `can't open "${entries[i].shortcut}"`).replace(/\.$/, '')]));
        rebuild(...keep);
        if (!fails.length) done(msg);
        else flash = entries.length > 1 ? `${fails.length} of ${entries.length} failed: ${fails[0]}` : fails[0];
        redraw();
      }), fail);
    };
    const tabsOn = appKey => staysOpen(appKey, setting('terminalLayout'), hasWindowsTerminal);

    // Safety net: a crash must not leave the terminal on the alt screen or without a cursor.
    const onExit = () => {
      const s = (alt ? MOUSE_OFF + ALT_OFF : '') + SHOW_CURSOR;
      try { fs.writeSync(stdout.fd, s); } catch { stdout.write(s); }
    };

    const stopWeb = () => {
      if (!web) return;
      web.restore();
      web.server.close();
      // Open browser tabs keep connections alive, which would keep upex running.
      web.server.closeAllConnections();
      web = null;
    };

    // Runs upex ui inside the selector. Its output would draw over the frame: errors go to the flash, the rest is dropped.
    const startWeb = () => {
      const { log, error } = console;
      const self = { restore: () => Object.assign(console, { log, error }) };
      // A server stopped (or the selector closed) before it got here must not touch the screen.
      const live = fn => guard(x => (web === self ? fn(x) : self.server.close()));
      self.server = startServer({
        onReady: live((url) => { self.url = url; redraw(); }),
        onError: live((err) => { stopWeb(); flash = `can't start upex ui: ${err.message}`; redraw(); }),
      });
      // After startServer, so a throw there can't leave console swallowed.
      web = self;
      console.log = () => {};
      console.error = (...a) => { flash = ui.stripAnsi(a.join(' ')).trim(); guard(redraw)(); };
    };

    const cleanup = () => {
      closed = true;
      stopGit();
      clearTimeout(flashTimer);
      stopWeb();
      stdin.removeListener('keypress', onKeypress);
      stdout.removeListener('resize', onResize);
      process.removeListener('exit', onExit);
      // Mouse off while still raw, so a late report can't land in the shell.
      setFullScreen(false);
      if (stdin.isTTY) {
        stdin.setRawMode(false);
      }
      stdin.pause();
      stdout.write(SHOW_CURSOR);
    };

    // For start view 'last': the tab (Settings counts as the one it was opened from) and a picked opener.
    const remember = () => {
      const c = loadConfig();
      const next = { ...c, lastView: view === 'settings' ? backView : view };
      const opener = appPicked && appChoices[selectedAppIndex]?.key;
      // --app is a one-off: the remembered opener stays.
      if (!preferredApp) { if (opener) next.lastOpener = opener; else delete next.lastOpener; }
      if (next.lastView !== c.lastView || next.lastOpener !== c.lastOpener) saveConfig(next);
    };

    const finish = (result) => {
      if (!alt) clearRendered();
      cleanup();
      // Never blocks quitting or opening.
      try { remember(); } catch { /* unreadable config: skip */ }
      resolve(result);
    };

    const fail = (error) => {
      cleanup();
      reject(error);
    };

    // ^s: the highlighted folder's package.json scripts, or a flash why not.
    const openScripts = () => {
      const c = filteredChoices[selectedIndex];
      if (view !== 'shortcuts' || !c) return;
      flash = missingFlash(c) || '';
      const found = !flash && readScripts(c.path);
      if (flash) return;
      if (!found) { flash = 'no package.json in this folder'; return; }
      // Control chars (a multi-line script, escapes) would break the frame.
      const list = Object.entries(found).map(([name, cmd]) => ({ name, path: String(cmd).replace(/[\x00-\x1f\x7f]+/g, ' ') }));
      if (!list.length) { flash = 'no scripts in package.json'; return; }
      scripts = { pm: detectPm(c.path), list };
      scriptIndex = 0;
      mode = 'scripts';
    };

    // Same as upex run: "<pm> run <script>" in a terminal at the folder.
    const runScript = () => {
      const c = filteredChoices[selectedIndex];
      const start = `${scripts.pm} run ${scripts.list[scriptIndex].name}`;
      mode = 'browse';
      const tab = tabsOn('cmd');
      if (tab || settings.enter === 'stay') { openHere([{ shortcut: c.name, app: 'cmd', start }], `running "${start}"${tab ? ' in a new tab' : ''}`, [c.name]); return; }
      finish({ status: 'selected', name: c.name, app: 'cmd', count: 1, start });
    };

    // Goals the pane shows now (same checks as the render), else null.
    const paneOn = () => view === 'shortcuts' && paneShown(stdout.columns || 80, alt, paneOpen || settings.narrowPane === 'always');
    const toggles = () => view !== 'settings' && paneToggles(stdout.columns || 80, alt, settings);
    const paneGoals = () => (paneOn() && !marks.size ? folderGoals(filteredChoices[selectedIndex], settings.goals) : null);
    // A git lookup landing redraws, which shows it (and looks up the row selected meanwhile).
    let closed = false;
    const gitFor = dir => gitOf(dir, guard(() => { if (!closed) redraw(); }));
    // ^g / a click on the pane's web line: the selected repo's web page.
    const openWeb = () => {
      const url = paneOn() && folderGit(filteredChoices[selectedIndex], settings.git, gitFor)?.web;
      if (!url) return;
      const r = launchUrl(url);
      if (r.ok) done(`opened ${url}`);
      else flash = r.message.split('\n')[0];
    };

    const copy = (text, msg) => {
      try {
        copyToClipboard(text);
        done(msg);
      } catch (err) {
        flash = `can't copy: ${err.message.split('\n')[0]}`;
      }
    };

    const startAction = (name) => {
      action = name;
      inputBuffer = prefill(name, filteredChoices[selectedIndex]);
      inputCursor = inputBuffer.length;
      mode = 'input';
    };

    // Commit the pending input action; returns false + sets flash on validation error.
    const commitInput = (target) => {
      const buf = inputBuffer.trim();

      if (action === 'add') {
        const bad = nameError(buf);
        if (bad) { flash = bad.toLowerCase().replace(/\.$/, ''); return false; }
        const taken = takenError(loadLinks(), buf);
        if (taken) { flash = taken.replace(/\.$/, ''); return false; }
        setLink(buf, { path: process.cwd(), added: Date.now() });
        rebuild(buf);
        done(`added "${buf}"`);
        return true;
      }

      if (action === 'edit') {
        const resolved = buf ? path.resolve(expandHome(buf)) : process.cwd();
        if (!fs.existsSync(resolved)) { flash = 'path not found'; return false; }
        const links = loadLinks();
        if (links[target]?.path === resolved) return true;
        setLink(target, { ...(links[target] || {}), path: resolved });
        rebuild(target);
        done(`"${target}" now points to ${tidyPath(resolved)}`);
        return true;
      }

      if (action === 'rename') {
        if (buf === target) return true;
        const bad = nameError(buf);
        if (bad) { flash = bad.toLowerCase().replace(/\.$/, ''); return false; }
        const result = renameLink(target, buf);
        if (!result.ok) {
          flash = result.message?.replace(/\.$/, '') || 'not found';
          return false;
        }
        if (marks.delete(target)) marks.add(buf);
        rebuild(buf);
        done(`renamed "${target}" to "${buf}"`);
        return true;
      }

      return true;
    };

    const switchTo = (to) => {
      if (to === 'settings') {
        backView = view;
        settings = readSettings();
        // The pane split row may have gone since last time (layout changed elsewhere).
        settingIndex = Math.min(settingIndex, visibleRows(settings).length - 1);
        wt = hasWindowsTerminal();
      }
      view = to;
      query = '';
      choices = allChoices.filter(inView(view));
      selectedIndex = 0;
      updateFilter();
    };

    const chooseSetting = (row, next) => {
      settings = { ...settings, [row.key]: next };
      saveConfig({ ...loadConfig(), [row.key]: next });
      if (row.key === 'defaultOpener') fallback = next;
      if (row.key === 'sort') rebuild();
      if (row.key === 'fullScreen') setFullScreen(next === 'on');
    };

    const clamp = (i, n) => Math.max(0, Math.min(i, n - 1));

    // Mouse is only on in full screen; ignored while typing or confirming.
    // Presses are skipped: the second press of a double-click must not wipe the first one's flash.
    const handleMouse = ({ x, y, wheel, click }) => {
      const picking = mode === 'scripts';
      const goalPick = mode === 'goals';
      if (!alt || (mode !== 'browse' && !picking && !goalPick) || !(wheel || click)) return;
      if (wheel) {
        flash = '';
        if (picking) scriptIndex = clamp(scriptIndex + wheel, scripts.list.length);
        else if (goalPick) goalIndex = clamp(goalIndex + wheel, paneGoals()?.next.length || 1);
        else if (view === 'settings') settingIndex = clamp(settingIndex + wheel, visibleRows(settings).length);
        else if (view === 'workspaces') wsIndex = clamp(wsIndex + wheel, filteredWs.length);
        else selectedIndex = clamp(selectedIndex + wheel, filteredChoices.length);
        redraw();
        return;
      }
      const t = hitTest(targets, x, y);
      const ws = view === 'workspaces';
      // The web and copy lines act on any click, so a double-click must not act twice.
      const once = !!(t?.web || t?.copy);
      const act = (t?.row != null || once) && rowClick(lastClick, y, Date.now(), once || t.row === (picking ? scriptIndex : ws ? wsIndex : selectedIndex));
      // Second half of a double-click that already opened: keep its flash.
      if (act === 'skip') return;
      // Any click dismisses the flash, an empty spot included, and leaves the goal picker.
      flash = '';
      if (goalPick) mode = 'browse';
      if (t?.tab) {
        mode = 'browse';
        if (t.tab !== view) switchTo(t.tab);
      } else if (once) {
        if (t.web) openWeb();
        else copy(t.copy, t.msg);
        lastClick = { y, at: Date.now(), opened: true };
      } else if (act) {
        if (act === 'open') handleKey(undefined, { name: 'return' });
        else if (act === 'select' && picking) scriptIndex = t.row;
        else if (act === 'select' && ws) wsIndex = t.row;
        else if (act === 'select') selectedIndex = t.row;
        // Stamped after opening: a tab launch blocks and the second click queues behind it.
        lastClick = { y, at: Date.now(), opened: act === 'open' };
        if (act === 'open') return;
      } else if (t?.opener != null) {
        appPicked = true;
        selectedAppIndex = t.opener;
      } else if (t?.setting != null) {
        settingIndex = t.setting;
        const row = visibleRows(settings)[t.setting];
        if (t.option != null) chooseSetting(row, rowOptions(row, appChoices, settings)[t.option][0]);
      }
      redraw();
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
          const entry = victim && loadWorkspaces()[victim.name];
          if (entry) {
            removeWorkspace(victim.name);
            undo = [{ name: victim.name, entry, ws: true }];
            done(`deleted workspace "${victim.name}" (^z undo)`);
          }
          rebuild();
        } else if (key.name === 'y') {
          // Marked ones all go in one save; otherwise the highlighted one.
          const gone = Object.entries(removeLinks(marks.size ? [...marks] : [filteredChoices[selectedIndex]?.name])).map(([name, entry]) => ({ name, entry }));
          marks.clear();
          if (gone.length) {
            undo = gone;
            done(`deleted ${howMany(gone.map(g => g.name))} (^z undo)`);
          }
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
        const edit = editLine({ text: inputBuffer, cur: inputCursor }, str, key);
        if (edit) {
          ({ text: inputBuffer, cur: inputCursor } = edit);
          redraw();
        }
        return;
      }

      // ── Script picker (the pane when wide, else the list): ↑↓ move, Enter runs, Esc / ← back ──
      if (mode === 'scripts') {
        const n = scripts.list.length;
        if (key.name === 'return') { runScript(); return; }
        if (key.name === 'escape' || key.name === 'left') mode = 'browse';
        else if (key.name === 'up' || key.name === 'down') scriptIndex = (scriptIndex + (key.name === 'up' ? n - 1 : 1)) % n;
        redraw();
        return;
      }

      // ── Goal picker in the pane: ↑↓ move, Enter copies, Esc / ← back. Pane gone (resize): back too. ──
      if (mode === 'goals') {
        const g = paneGoals()?.next || [];
        goalIndex = Math.min(goalIndex, g.length - 1);
        if (!g.length || key.name === 'escape' || key.name === 'left') mode = 'browse';
        else if (key.name === 'return') { copy(goalText(g[goalIndex]), `copied "${oneLine(g[goalIndex].id ?? g[goalIndex].title)}"`); mode = 'browse'; }
        else if (key.name === 'up' || key.name === 'down') goalIndex = (goalIndex + (key.name === 'up' ? g.length - 1 : 1)) % g.length;
        redraw();
        return;
      }

      // ── Browse mode ──
      // Esc clears a typed filter first, then the marks, then closes a Shift+Right pane, then quits.
      if (key.name === 'escape' && query) {
        clearQuery();
        redraw();
        return;
      }
      if (key.name === 'escape' && marks.size && view !== 'workspaces' && view !== 'settings') {
        marks.clear();
        redraw();
        return;
      }
      if (key.name === 'escape' && paneOpen && toggles()) {
        paneOpen = false;
        redraw();
        return;
      }
      if (key.name === 'escape') {
        stdout.write('\n');
        finish({ status: 'cancelled' });
        return;
      }

      // Narrow screen: Shift+Right opens the detail pane, Shift+Left closes it; else they change the opener.
      // Before the Workspaces keys, which drop Left/Right.
      if (key.shift && toggles() && (key.name === 'right' ? !paneOpen : key.name === 'left' && paneOpen)) {
        paneOpen = !paneOpen;
        redraw();
        return;
      }

      if (key.name === 'tab') {
        const to = !key.shift ? nextView(view, settings.views) : view === 'settings' ? backTo(backView, settings.views) : 'settings';
        if (to !== view) { switchTo(to); redraw(); }
        return;
      }

      // ^U starts upex ui (and opens the browser); again stops it.
      if (key.ctrl && key.name === 'u') {
        if (!web) startWeb();
        else { stopWeb(); done('stopped upex ui'); }
        redraw();
        return;
      }

      // Settings: Up/Down picks a row, Left/Right changes and saves it; everything else is ignored.
      if (view === 'settings') {
        const rows = visibleRows(settings);
        if (key.name === 'up' || key.name === 'down') {
          const n = rows.length;
          settingIndex = (settingIndex + (key.name === 'up' ? n - 1 : 1)) % n;
          redraw();
        } else if (key.name === 'left' || key.name === 'right') {
          // Only the layout row changes which rows show, and pane split comes after it, so the index stays put.
          const row = rows[settingIndex];
          const keys = rowOptions(row, appChoices, settings).map(([k]) => k);
          const at = Math.max(0, keys.indexOf(pickedOf(row, settings)));
          chooseSetting(row, keys[(at + (key.name === 'left' ? keys.length - 1 : 1)) % keys.length]);
          redraw();
        }
        return;
      }

      // Undo the last delete (either kind) unless its name was taken since.
      if (key.ctrl && key.name === 'z') {
        if (!undo) return;
        const err = undoError(undo, loadLinks(), loadWorkspaces());
        if (err) {
          flash = `can't undo, ${err.replace(/\.$/, '')}`;
        } else {
          const [{ name, entry, ws }] = undo;
          if (ws) saveWorkspaces({ ...loadWorkspaces(), [name]: entry });
          // All in one save, like the delete.
          else saveLinks({ ...loadLinks(), ...Object.fromEntries(undo.map(u => [u.name, u.entry])) });
          rebuild(ws ? null : name, ws ? name : null);
          done(`restored ${howMany(undo.map(u => u.name))}`);
          undo = null;
        }
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
          const name = filteredWs[wsIndex]?.name;
          if (!name) return;
          if (settings.enter === 'stay') openHere(loadWorkspaces()[name] || [], `opened workspace "${name}"`, [null, name]);
          else finish({ status: 'workspace', name });
          return;
        }
        if ((key.name === 'up' || key.name === 'down') && n > 0) {
          wsIndex = (wsIndex + (key.name === 'up' ? n - 1 : 1)) % n;
          redraw();
          return;
        }
        // Shortcut-only keys (^A/^E/^R, Left/Right) do nothing here.
        if ((key.ctrl && key.name !== 'w') || key.name === 'left' || key.name === 'right' || key.name === 'up' || key.name === 'down') return;
      }

      if (key.ctrl && key.name === 's') {
        openScripts();
        redraw();
        return;
      }

      // Live actions (Ctrl+key so they never clash with search typing).
      // ^A adds the cwd as a folder shortcut, so it belongs to the Shortcuts tab.
      if (key.ctrl && key.name === 'a') {
        if (view === 'shortcuts') { startAction('add'); redraw(); }
        return;
      }
      if (key.ctrl && key.name === 'd') {
        if (filteredChoices.length > 0 || marks.size) { mode = 'confirm'; redraw(); }
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
      if (key.ctrl && key.name === 'p') {
        const c = filteredChoices[selectedIndex];
        const entry = c && loadLinks()[c.name];
        if (!entry) return;
        setLink(c.name, withPinned(entry, !entry.pinned));
        rebuild(c.name);
        done(`${entry.pinned ? 'unpinned' : 'pinned'} "${c.name}"`);
        redraw();
        return;
      }
      if (key.ctrl && key.name === 'g') {
        openWeb();
        redraw();
        return;
      }
      if (key.ctrl && key.name === 'y') {
        const c = filteredChoices[selectedIndex];
        if (!c?.path) return;
        copy(c.path, `copied ${c.path}`);
        redraw();
        return;
      }
      // Alt+Up/Down moves a pinned shortcut among the pinned ones of this tab.
      if (isAlt(key) && (key.name === 'up' || key.name === 'down')) {
        const c = filteredChoices[selectedIndex];
        if (!c) return;
        if (!c.pinned) flash = 'only pinned shortcuts move, ^p pins';
        // A search sorts by match, so the move wouldn't show.
        else if (query.trim()) flash = 'clear the search to move a pin';
        else {
          const order = movePinned(allChoices.filter(x => x.pinned), c.name, key.name === 'up' ? -1 : 1, inView(view));
          if (order) { setPinOrder(order); rebuild(c.name); }
        }
        redraw();
        return;
      }

      // Space toggles a mark and moves down.
      if (key.name === 'space' && !key.ctrl && !key.meta && view !== 'workspaces') {
        const c = filteredChoices[selectedIndex];
        if (!c) return;
        if (!marks.delete(c.name)) marks.add(c.name);
        selectedIndex = Math.min(selectedIndex + 1, filteredChoices.length - 1);
        redraw();
        return;
      }

      if (key.name === 'return' && marks.size) {
        const entries = markedPlan().map(({ c, app, count }) => ({ shortcut: c.name, app, count }));
        marks.clear();
        if (settings.enter === 'stay') { openHere(entries, `opened ${howMany(entries.map(e => e.shortcut))}`, [filteredChoices[selectedIndex]?.name]); return; }
        finish({ status: 'marked', entries });
        return;
      }

      if (key.name === 'return') {
        if (filteredChoices.length === 0) {
          return;
        }

        const selected = filteredChoices[selectedIndex];
        // App and URL shortcuts launch directly, ignore the opener selector.
        const direct = selected.isApp || selected.isUrl;

        // A missing folder would only end in an error after exit: stay and say how to fix it.
        const missing = !direct && missingFlash(selected);
        if (missing) {
          rebuild(selected.name);
          flash = missing;
          redraw();
          return;
        }

        const appKey = direct ? null : appChoices[selectedAppIndex]?.key || fallback;
        const count = isTerminalApp(appKey) ? cmdCount : 1;
        // Terminal tabs open beside the selector, so it stays either way.
        const tab = tabsOn(selected.isCmd ? 'cmd' : appKey);
        if (tab || settings.enter === 'stay') {
          const n = selected.isCmd ? 1 : count;
          const where = tab ? (n > 1 ? `${n} new tabs` : 'a new tab') : appKey && (appMap[appKey]?.displayName || appKey);
          openHere([{ shortcut: selected.name, app: appKey, count: n }], `opened "${selected.name}"${where ? ` in ${where}` : ''}`, [selected.name]);
          return;
        }
        finish({ status: 'selected', name: selected.name, app: appKey, count });
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

      // Shift+Right into the pane's goals; without any it changes the opener like Right.
      if (key.name === 'right' && key.shift && paneGoals()?.next.length) {
        mode = 'goals';
        goalIndex = 0;
        redraw();
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

      // The filter has no cursor (arrows move the list), so it edits at the end only.
      const edit = !['left', 'right', 'home', 'end', 'delete'].includes(key.name) && editLine({ text: query, cur: query.length }, str, key);
      if (edit && edit.text !== query) {
        query = edit.text;
        updateFilter();
        redraw();
      }
    };

    // Store errors in a handler must reject (bin/upex.js prints them), not crash uncaught.
    const guard = fn => (...args) => {
      try {
        fn(...args);
      } catch (error) {
        fail(error);
      }
    };
    const onKeypress = guard((str, key) => {
      const m = readMouse(mouse, key);
      mouse = m.state;
      if (m.event) handleMouse(m.event);
      if (m.pass) handleKey(str, key);
    });
    const onResize = guard(redraw);

    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('keypress', onKeypress);
    stdout.on('resize', onResize);
    process.on('exit', onExit);

    guard(() => {
      setFullScreen(setting('fullScreen') === 'on');
      stdout.write(HIDE_CURSOR);
      updateFilter(); // recent strip
      redraw();
    })();
  });
}
