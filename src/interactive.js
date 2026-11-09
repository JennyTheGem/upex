/**
 * interactive.js -- Interactive shortcut selector for `upex` with no arguments.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import chalk from 'chalk';
import Fuse from 'fuse.js';
import { getInteractiveAppChoices, getAppMap, isTerminalApp, hasWindowsTerminal, defaultOpener, readSettings, setting, startTab, shownTabs, isHex, copyToClipboard, readClipboard, launchUrl, configApps, SETTINGS, settingValues, settingShown } from './launcher.js';
import { gitOf, stopGit } from './git.js';
import { fuseOpts } from './fuzzy.js';
import { loadLinks, activeLinks, unarchived, aliasesOf, takenError, checkAliases, frecency, removeLinks, saveLinks, setLink, renameLink, loadWorkspaces, saveWorkspaces, removeWorkspace, nameError, loadConfig, saveConfig, withPinned, setPinOrder, StoreError, undoLast, hasBackups, pruneBroken, staleLinks, loadHistory, statsFrom, parseColor, colorOf, COLORS, pathKey, topSuggestion, hideVisit, LINKS_FILE, CONFIG_FILE } from './store.js';
import { describeEntry } from './commands/workspace.js';
import { handleOpen } from './commands/open.js';
import { startServer, applyOpener } from './commands/web.js';
import { readScripts, detectPm } from './commands/run.js';
import { parseDuration, defaultName } from './commands/add.js';
import { runChecks } from './commands/doctor.js';
import { sparkline } from './commands/stats.js';
import { bundleOf, importBundle } from './commands/transfer.js';
import * as ui from './ui.js';
import { VERSION, cachedLatest, fetchLatest, isNewer, updateText } from './update.js';

// Terminal width from which the version shows outside Settings.
const VERSION_WIDTH = 100;

const MAX_VISIBLE_CHOICES = 8;
// Full screen in a terminal at least this wide: detail pane right of the list.
const PANE_MIN = 140;
// Narrower: only once opened (Shift+Right, or Pane on narrow Always), and never under this.
const PANE_FLOOR = 60;
// Is the detail pane shown? `open` = opened on a narrow screen.
export const paneShown = (columns, full, open) => !!full && (columns >= PANE_MIN || (!!open && columns >= PANE_FLOOR));
// Can Shift+Right open it and Shift+Left close it here?
// Pane width per the paneWidth setting: [share of the screen, max columns].
const PANE_WIDTHS = { narrow: [0.28, 56], normal: [0.38, 72], wide: [0.5, 110] };
export const paneWidthOf = (w, size) => { const [f, max] = PANE_WIDTHS[size] || PANE_WIDTHS.normal; return Math.min(max, Math.floor(w * f)); };
export const paneToggles = (columns, full, s = {}) => !!full && columns < PANE_MIN && columns >= PANE_FLOOR && s.narrowPane !== 'always';
const ALT_ON = '\x1b[?1049h';
const ALT_OFF = '\x1b[?1049l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
// SGR mouse reports, only while on the alt screen.
const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?1006l\x1b[?1000l';

// Each folder shortcut's `same`: other shortcut names on the same path.
export function withSamePath(list) {
  const by = new Map();
  for (const c of list) if (c.isDir) by.set(pathKey(c.path), [...(by.get(pathKey(c.path)) || []), c.name]);
  return list.map(c => (c.isDir ? { ...c, same: by.get(pathKey(c.path)).filter(n => n !== c.name) } : c));
}

function buildChoices() {
  return withSamePath(Object.entries(activeLinks(loadLinks()))
    .map(([name, entry]) => ({
      name,
      path: entry.path || entry.app || entry.url || '',
      app: entry.app || null,
      isApp: !!entry.app,
      isCmd: !!(entry.app && entry.terminal),
      isUrl: !!entry.url,
      isDir: !!entry.path,
      tags: entry.tags || [],
      note: entry.note,
      color: colorOf(entry),
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
    })))
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
// Groups setting: the pins a row's Alt+Up/Down passes, those in its #tag or untagged group (any elsewhere).
export const sameGroup = ({ group }) => x => (group?.startsWith('#') ? !!x.tags?.includes(group.slice(1)) : group !== 'untagged' || !x.tags?.length);

// Recent strip: the last `n` opened again on top of `rest` (the shown list), marked `recent`. Not for a list that short.
export function withRecent(list, n = 3, rest = list) {
  const recent = list.filter(c => c.lastUsed).sort((a, b) => b.lastUsed - a.lastUsed).slice(0, n);
  return list.length > n && recent.length ? [...recent.map(c => ({ ...c, recent: true })), ...rest] : rest;
}

// Groups setting on a sorted list: pinned ones under Pinned on top, then a copy per tag under `group` "#tag",
// untagged ones last. Groups follow the list order (the sort), A to Z when `byName`.
export function withGroups(list, byName = false) {
  if (!list.some(c => c.tags?.length)) return list;
  const tags = [...new Set(list.flatMap(c => c.tags || []))];
  if (byName) tags.sort((a, b) => a.localeCompare(b));
  const as = (cs, group) => cs.map(c => ({ ...c, group }));
  return [...as(list.filter(c => c.pinned), 'Pinned'),
    ...tags.flatMap(t => as(list.filter(c => c.tags?.includes(t)), `#${t}`)),
    ...as(list.filter(c => !c.tags?.length), 'untagged')];
}

// Max rows setting -> list rows. Auto: fill in full screen, else 8.
export const maxListOf = (v, full = false) => (full && !Number(v) ? Infinity : Number(v) || MAX_VISIBLE_CHOICES);

// PgUp/PgDn move `page` rows (no wrap), Home/End go to the first/last; null for other keys or an empty list.
export const jumpIndex = (name, i, n, page) => (n < 1 ? null
  : name === 'home' ? 0 : name === 'end' ? n - 1
    : name === 'pageup' ? Math.max(0, i - Math.max(1, page)) : name === 'pagedown' ? Math.min(n - 1, i + Math.max(1, page)) : null);

// Folder shortcuts on the Shortcuts tab, app + URL shortcuts on the Apps tab.
export const inView = (view) => (c) => (view === 'apps') === !!(c.isApp || c.isUrl);

// Archived shortcuts for Settings, A to Z.
export const archivedList = links => Object.entries(activeLinks(links, true))
  .map(([name, e]) => ({ name, path: e.path || e.app || e.url || '' })).sort((a, b) => a.name.localeCompare(b.name));

// Workspaces in the same { name, path, searchText } shape so filterChoices works on them.
function buildWorkspaceChoices() {
  return Object.entries(loadWorkspaces()).map(([name, entries]) => {
    const summary = (entries || []).map(describeEntry).join('  ');
    return { name, path: summary, entries: entries || [], searchText: `${name} ${summary}` };
  });
}

// is: tokens; upex ui has its own copy in index.html. Workspaces have no lastUsed, so never stale.
const IS = {
  pinned: c => c.pinned,
  missing: c => c.exists === false,
  stale: (c, days) => c.lastUsed !== undefined && Date.now() - (c.lastUsed || c.added || 0) >= days * 86400000,
  app: c => c.isApp,
  new: c => Date.now() - (c.added || 0) < 7 * 86400000,
  temp: c => !!c.expires,
};
const TOKEN = /^(#|@|is:)(.*)$/i;
// Test for a #tag, @opener or is:x word, prefix match, any case; null for a bare #, @ or is:. Unknown is:x matches none.
function tokenTest(w, staleDays) {
  const [, kind, v] = w.toLowerCase().match(TOKEN);
  if (!v) return null;
  if (kind === '#') return c => !!c.tags?.some(t => t.toLowerCase().startsWith(v));
  if (kind === '@') return c => !!c.opener?.toLowerCase().startsWith(v);
  const key = Object.keys(IS).find(k => k.startsWith(v));
  return key ? c => IS[key](c, staleDays) : () => false;
}

// `fuzzy`, `searchIn` and `staleAfter` are the settings of the same name.
export function filterChoices(choices, query, { fuzzy, searchIn, staleAfter = '60' } = {}) {
  // Token words (#tag, @opener, is:pinned|missing|stale|app|new|temp) narrow the list; the other words search fuzzy.
  // Also split before each token: Space marks, so "#we#ui" or "apiis:pinned".
  const words = query.trim().split(/\s+|(?=[#@])|(?=is:)/i);
  const isToken = w => TOKEN.test(w);
  const tests = words.filter(isToken).map(w => tokenTest(w, Number(staleAfter))).filter(Boolean);
  const pool = tests.length ? choices.filter(c => tests.every(t => t(c))) : choices;
  const trimmed = words.filter(w => !isToken(w)).join(' ');
  if (!trimmed) return pool;

  const fuse = new Fuse(pool, {
    keys: searchIn === 'names' ? ['name', 'aliases'] : ['name', 'aliases', 'path', 'searchText'],
    includeMatches: true,
    ...fuseOpts(fuzzy, 0.35),
  });

  // `hits` = matched char ranges in the name, for highlighting; `via` = the alias that matched instead of the name.
  const t = trimmed.toLowerCase();
  const has = s => s.toLowerCase().includes(t);
  return fuse.search(trimmed).map(({ item, matches = [] }) => {
    const name = matches.find(m => m.key === 'name');
    const aliases = matches.filter(m => m.key === 'aliases');
    const alias = aliases.find(m => has(m.value)) || aliases[0];
    const via = alias && (!name || (!has(item.name) && has(alias.value))) ? alias.value : undefined;
    return { ...item, hits: name?.indices, via };
  });
}

// No matches for the typed filter: what Enter offers. Add it as a folder shortcut on the cwd (Shortcuts tab,
// no #@is: tokens), or the archived ones whose name or path has the text, in Settings.
export function noMatchOffers(query, view, archived = [], cwd = process.cwd()) {
  const q = query.trim();
  if (!q || (view !== 'shortcuts' && view !== 'apps')) return [];
  const n = archived.filter(a => `${a.name} ${a.path}`.toLowerCase().includes(q.toLowerCase())).length;
  return [
    view === 'shortcuts' && !/[#@]|is:/i.test(q) && { kind: 'add', name: q, label: `add "${q}" here`, text: tidyPath(cwd), key: 'add here' },
    n > 0 && { kind: 'archived', label: 'search archived', text: `${n} match`, key: 'search archived' },
  ].filter(Boolean);
}

// Badge text for a shortcut from add --ttl: "2d left", '' without one or once past.
export const expiryText = (expires, now = Date.now()) => (expires > now ? `${ui.span(expires - now, Math.ceil)} left` : '');

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
  return paths === 'full' ? { ...r, style: 'plain', middle: style === 'path' } : r;
}
// Pinned badge.
export const PIN = '★';
// Badge words joined; a trailing ★ gets a space so it doesn't touch the edge.
export const badgeText = parts => { const t = parts.filter(Boolean).join(' '); return t.endsWith(PIN) ? `${t} ` : t; };
// Row details setting: does `what` ('tags' | 'badges') show? Unset = both.
export const showsDetail = (rowDetails = 'both', what) => rowDetails === 'both' || rowDetails === what;
// Usage setting: a row's last opened ("3d ago") or open count, '' when off or for a workspace (no lastUsed).
export function usageText(c, usage = 'ago', now = Date.now()) {
  if (usage === 'off' || c.lastUsed === undefined) return '';
  if (usage === 'opens') return `${c.uses || 0} open${c.uses === 1 ? '' : 's'}`;
  return c.lastUsed ? `${ui.span(now - c.lastUsed)} ago` : 'never';
}
// Glyphs setting ascii: hint keys spelled out (set per render), the rest of the frame goes through ui.toAscii.
let asciiHints = false;
const ASCII_KEYS = [['↑↓', 'up/down'], ['←→', 'left/right'], ['→', 'right'], ['←', 'left'], ['↵', 'enter'], ['⌫', 'bs']];
const hintKey = k => (asciiHints ? ASCII_KEYS.reduce((s, [a, b]) => s.replace(a, b), k) : k);
// HINT_SEP in a pair list: a dim | between key groups, dropped at a row's start or end.
const HINT_SEP = '|';
const keyHint = (pairs) => {
  const ps = pairs.filter(Boolean);
  while (ps[0] === HINT_SEP) ps.shift();
  while (ps.at(-1) === HINT_SEP) ps.pop();
  return '  ' + ps.map(p => (p === HINT_SEP ? chalk.dim(HINT_SEP) : `${hintKey(p[0])} ${chalk.dim(p[1])}`)).join('  ');
};
// One hint row of at most w columns: from the first pair that doesn't fit on, pairs are left out.
const fitHint = (pairs, w) => keyHint(pairs.filter(Boolean).filter((p, i, a) => vis(keyHint(a.slice(0, i + 1))) <= w));
// Hint rows of at most w columns: a pair that doesn't fit starts the next row.
export const wrapHint = (pairs, w) => pairs.filter(Boolean)
  .reduce((rows, p) => {
    const last = rows.at(-1);
    if (last && vis(keyHint([...last, p])) <= w) last.push(p);
    else rows.push([p]);
    return rows;
  }, [])
  .map(r => ui.truncate(keyHint(r), w))
  .filter(r => r.trim());
// Fuse hit ranges are UTF-16 offsets, inclusive.
export const underlineHits = (s, hits = []) => ui.graphemes(s)
  .map(({ segment: g, index: i }) => (hits.some(([a, b]) => a < i + g.length && b >= i) ? chalk.underline(g) : g)).join('');

// Keeps the end of a too-long string, where the folder name is.
const clipStart = (s, n) => (vis(s) <= n ? s : n <= 1 ? '…'.slice(0, n) : `…${ui.fit(s, n - 1, true)}`);
// A too-long path loses whole middle folders: E:\Downloads\…\Assets\upex. Keeps the first part and the
// last folder; when even those don't fit, the end like clipStart.
export function clipMiddle(s, n) {
  if (vis(s) <= n) return s;
  const parts = s.split(/(?<=[/\\])/);
  if (parts.length < 3) return clipStart(s, n);
  const sep = parts[0].at(-1);
  let i = 1;
  let j = parts.length - 1;
  const join = (a, b) => `${parts.slice(0, a).join('')}…${sep}${parts.slice(b).join('')}`;
  if (vis(join(i, j)) > n) return clipStart(s, n);
  // Grow the end first, then the start, a folder at a time.
  for (let grew = true; grew && i < j;) {
    grew = false;
    if (i < j - 1 && vis(join(i, j - 1)) <= n) { j--; grew = true; }
    if (i < j - 1 && vis(join(i + 1, j)) <= n) { i++; grew = true; }
  }
  return join(i, j);
}

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

// One list row (`num`: a dim 1 to 9 in the pointer column): "› ● name  path ..... #tags  badge  3d ago". `style` = path | url | dim | plain (url looks plain).
// `weight` styles the name (bold; the suggested row is plain).
// `dot` (color label) sits in a `dotWidth` column before the name, 0 = no column. `usage` goes last, dropped when it doesn't fit.
function renderRow({ sel, mark, name, nameWidth, hits, text = '', style = 'path', middle = false, right = '', cw, pick = s => s, dot = '', dotWidth = 0, usage = '', num = '', weight = chalk.bold }) {
  const n = clipName(name, nameWidth, hits);
  const nm = weight(underlineHits(n.text, n.hits)) + ' '.repeat(Math.max(0, nameWidth - vis(n.text)));
  const dc = dotWidth ? dot + ' '.repeat(Math.max(0, dotWidth + 1 - vis(dot))) : '';
  const roomFor = r => cw - 2 - vis(dc) - nameWidth - 2 - (r ? vis(r) + 2 : 0);
  const withUsage = [right, usage].filter(Boolean).join('  ');
  if (usage && roomFor(withUsage) >= 0) right = withUsage;
  const room = roomFor(right);
  const t = (style === 'path' || middle ? clipMiddle : clipStart)(text, Math.max(0, room));
  const body = sel || style === 'plain' || style === 'url' ? t : style === 'dim' ? chalk.dim(t) : ui.dimParent(t);
  const left = `${mark ? pick('●') : sel ? pick('›') : num ? chalk.dim(num) : ' '} ${dc}${nm}  ${body}`;
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

// "b;x;yM" press / "b;x;ym" release. click / right = left / right button released, wheel = -1 up / 1 down.
function parseSgr(s) {
  const m = /^(\d+);(\d+);(\d+)([Mm])$/.exec(s);
  if (!m) return null;
  const b = Number(m[1]);
  const wheel = m[4] === 'M' && (b & 0xc2) === 64 ? (b & 1 ? 1 : -1) : 0;
  const up = m[4] === 'm' && (b & 0xe0) === 0;
  return { x: Number(m[2]), y: Number(m[3]), wheel, click: up && (b & 3) === 0, right: up && (b & 3) === 2 };
}

// `line` with `text` over its columns from `from`; its color codes are re-applied after, so styles carry on.
export function splice(line, from, text) {
  const to = from + vis(text);
  const reset = chalk.level ? '\x1b[0m' : '';
  let col = 0;
  let head = '';
  let tail = '';
  let seen = '';
  // eslint-disable-next-line no-control-regex
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith('\x1b')) {
      if (col >= to) tail += part;
      else { seen += part; if (col < from) head += part; }
      continue;
    }
    for (const g of ui.graphemes(part)) {
      // A wide character cut by an edge leaves a space.
      if (col + g.w <= from) head += g.segment;
      else if (col < from) head += ' '.repeat(from - col);
      else if (col >= to) tail += g.segment;
      else if (col + g.w > to) tail += ' '.repeat(col + g.w - to);
      col += g.w;
    }
  }
  return `${head}${' '.repeat(Math.max(0, from - col))}${reset}${text}${reset}${seen}${tail}`;
}

// Right-click menu { items: [{ label }], index, line, col } over the frame: under the clicked line, above it when
// there's no room, inside the width. Returns the lines and a { line, from, to, menu } target per item.
export function overlayMenu(lines, { items, index, line, col }, width) {
  // Labels clip so the box fits the width.
  const n = Math.max(1, Math.min(width - 5, Math.max(...items.map(i => vis(i.label)))));
  const box = [
    chalk.dim(`╭${'─'.repeat(n + 3)}╮`),
    ...items.map((item, i) => {
      const label = clipName(item.label, n).text;
      const t = `${i === index ? '›' : ' '} ${label}${' '.repeat(n - vis(label))} `;
      return chalk.dim('│') + (i === index ? highlight(chalk.bold(t)) : t) + chalk.dim('│');
    }),
    chalk.dim(`╰${'─'.repeat(n + 3)}╯`),
  ];
  const top = line + 1 + box.length <= lines.length ? line + 1 : Math.max(0, line - box.length);
  const left = Math.max(0, Math.min(col, width - n - 5));
  const out = [...lines];
  box.forEach((b, i) => { if (top + i < out.length) out[top + i] = splice(out[top + i], left, b); });
  return { lines: out, hits: items.map((_, i) => ({ line: top + 1 + i, from: left, to: left + n + 5, menu: i })) };
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

// Flash for a ^z that stepped back one links.json backup (undoLast's result).
export const undoFlash = (r, now = Date.now()) => [`undid the change from ${ui.span(now - r.at)} ago`,
  ...[['brought back', r.added], ['removed', r.removed], ['reverted', r.changed]].filter(([, n]) => n.length).map(([l, n]) => `${l} ${n.join(', ')}`),
  r.left && `${r.left} more`].filter(Boolean).join(' · ');

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
  rename: name => `rename "${name}" to:`,
  add: (_, p) => `new shortcut name (path = ${p ? clipMiddle(tidyPath(p), 30) : 'cwd'}):`,
  wsadd: n => `add the ${n} marked to workspace (new or existing):`,
  opener: name => `command for opener "${name}":`,
  openerName: () => 'new opener name:',
  openerCmd: name => `command for opener "${name}":`,
  export: () => 'export to file:',
  import: () => 'import from file (merge):',
};

// ^a: clipboard text as an existing absolute path (one line, Explorer's "Copy as path" quotes dropped), else null.
export function clipPath(text, exists = fs.existsSync) {
  const t = String(text ?? '').trim().replace(/^"(.*)"$/, '$1');
  const p = expandHome(t);
  return t && !/[\r\n]/.test(t) && path.isAbsolute(p) && exists(p) ? path.resolve(p) : null;
}

// Confirm many setting: does opening `n` windows ask first?
export const asksMany = (n, limit) => Number(limit) > 0 && n > Number(limit);

// Input a prompt starts with: the current name for ^r, so Enter on it changes nothing.
export const prefill = (action, choice) => (action === 'rename' ? choice?.name : '') || '';

// Terminal tabs open next to upex in Windows Terminal, so the selector stays open. `wt` is lazy.
export const staysOpen = (appKey, layout, wt) => isTerminalApp(appKey) && layout === 'tabs' && !!wt();

// Why Enter can't open this folder shortcut, or null. Checks the disk again: the list can be stale.
export const missingFlash = (c, exists = fs.existsSync) => (c.isApp || c.isUrl || exists(c.path) ? null : 'path missing, ^e to fix');

// ── Edit form (^e): one row per field, saved as you go ──
// Shortcut types, named like add --app / --cmd / --url.
const KINDS = ['folder', 'app', 'cmd', 'url'];
const KIND_NAMES = { folder: 'folder', app: 'app', cmd: 'command', url: 'url' };
const KIND_FIELD = { folder: 'path', app: 'app', cmd: 'app', url: 'url' };
export const kindOf = e => (e.url ? 'url' : e.app ? (e.terminal ? 'cmd' : 'app') : 'folder');
const targetOf = e => e[KIND_FIELD[kindOf(e)]] || '';
// The entry as another type with `target` as its path, command or URL; a default opener stays only on a folder.
export function retyped(entry, kind, target) {
  const { path: _p, app: _a, url: _u, terminal: _t, opener, ...rest } = entry;
  return { ...rest, [KIND_FIELD[kind]]: target, ...(kind === 'cmd' && { terminal: true }), ...(kind === 'folder' && opener && { opener }) };
}
// The entry with `key` set, or without it when `value` is empty.
export const setField = (e, key, value) => {
  const { [key]: _old, ...rest } = e;
  return value && (!Array.isArray(value) || value.length) ? { ...rest, [key]: value } : rest;
};
// Words of a tags or aliases field, each once: "#a, b c" -> ['a', 'b', 'c'].
export const fieldWords = s => [...new Set(String(s ?? '').split(/[\s,]+/).map(w => w.replace(/^#+/, '')).filter(Boolean))];
// Tab in the tags field: the last word finished to the first known tag it starts.
export function completeTag(text, known) {
  const w = /[^\s,#]*$/.exec(text)[0];
  const hit = w && known.find(t => t.toLowerCase().startsWith(w.toLowerCase()));
  return hit ? `${text.slice(0, text.length - w.length)}${hit} ` : text;
}
// Expiry options and the picked one: a running expiry shows as "in 5d" in the slot of the first preset it fits
// (past 30d its own slot last), so ←→ step on from there.
const EXPIRES = ['never', '1d', '7d', '30d'];
export function expiryOptions(e, now = Date.now()) {
  const left = e.expires > now ? e.expires - now : 0;
  if (!left) return { labels: EXPIRES, at: 0 };
  const fit = EXPIRES.findIndex((p, i) => i && left <= parseDuration(p));
  const at = fit < 0 ? EXPIRES.length : fit;
  const labels = [...EXPIRES];
  labels[at] = `in ${ui.span(left, Math.ceil)}`;
  return { labels, at };
}
// Form rows: a shortcut's fields (opener only for a folder), or a workspace's name and then its entries by index.
export const formRows = ({ ws, entry }) => (ws ? ['name', ...(entry || []).map((_, i) => i)]
  : ['name', 'target', 'type', ...(kindOf(entry) === 'folder' ? ['opener'] : []), 'tags', 'aliases', 'note', 'color', 'expires']);
export const isTextRow = (f, ws) => (ws ? true : ['name', 'target', 'tags', 'aliases', 'note', 'color'].includes(f));
// Color row ←→: none, then the palette; a typed hex or emoji steps on from none.
export const stepColor = (cur, d) => { const l = ['', ...COLORS]; return l[(Math.max(0, l.indexOf(cur || '')) + d + l.length) % l.length]; };
// Openers a folder or workspace entry can pick: its default first.
const openerOptions = appChoices => [['', 'default'], ...appChoices.filter(c => c.key !== 'copy').map(c => [c.key, c.label])];

function formNote(f, form) {
  if (form.ws) return f === 'name' ? 'Unique, no spaces.' : '←→ picks its opener, ↵ sets a start command (runs in a terminal), ^d removes it.';
  const kind = form.kind || kindOf(form.entry);
  if (f === 'name') return 'Unique, no spaces.';
  if (f === 'target') return { folder: 'Folder path, ~ works, empty = the current folder.', app: 'Program or command to launch.', cmd: 'Command line, runs in a terminal.', url: 'Web address, opens in the browser.' }[kind];
  if (f === 'type') return form.kind ? '↵ asks for its new target, esc keeps the type.' : '←→ picks another type, then ↵ asks for its target.';
  if (f === 'opener') return 'Opens it when no opener is picked. Default: Settings > Default opener.';
  if (f === 'tags') return 'Space between tags, tab completes one you use. Type #tag in the filter to find them.';
  if (f === 'aliases') return 'Other names that open it too, space between.';
  if (f === 'note') return 'Shown at the top of the details.';
  if (f === 'color') return '←→ picks a color, ↵ types one: #rrggbb or an emoji. A dot before the name, here and in upex ui.';
  return 'Archived on its own after this long, like add --ttl.';
}

// Form lines in `w` columns: name and type on top, a row per field (the picked one with its input while editing), then its note.
// `form` = { name, entry (shortcut entry | workspace entries), ws, field, editing, buffer, cursor, kind (type picked, not saved) }.
export function formLines(form, w, appChoices = [], pick = chalk.bold, now = Date.now()) {
  const e = form.entry;
  const rows = formRows(form);
  // "› " plus the 11-column label.
  const vw = Math.max(1, w - 13);
  const none = chalk.dim('none');
  const openers = openerOptions(appChoices);
  const openerAt = key => Math.max(0, openers.findIndex(([k]) => k === (key || '')));
  const value = (f) => {
    if (form.ws) {
      if (f === 'name') return form.name;
      const x = e[f] || {};
      return `${x.app ? openers.find(([k]) => k === x.app)?.[1] || x.app : 'default'}${x.count > 1 ? ` ×${x.count}` : ''}${x.start ? `  ${chalk.dim(x.start)}` : ''}`;
    }
    if (f === 'name') return form.name;
    if (f === 'target') {
      const t = targetOf(e);
      const folder = kindOf(e) === 'folder';
      const missing = folder && !fs.existsSync(t);
      // A long one keeps its end, the folder name.
      const shown = (folder ? clipMiddle : clipStart)(folder ? tidyPath(t) : t, vw - (missing ? 9 : 0));
      return (folder ? ui.dimParent(shown) : shown) + (missing ? `  ${chalk.red('missing')}` : '');
    }
    if (f === 'type') return optionRow(KINDS.map(k => KIND_NAMES[k]), KINDS.indexOf(form.kind || kindOf(e)), vw, null, pick);
    if (f === 'opener') return optionRow(openers.map(([, l]) => l), openerAt(e.opener), vw, null, pick);
    if (f === 'tags') return e.tags?.length ? `#${e.tags.join(' #')}` : none;
    if (f === 'aliases') return aliasesOf(e).join(' ') || none;
    if (f === 'note') return oneLine(e.note) || none;
    if (f === 'color') return ui.colorLabel(colorOf(e)) || none;
    const x = expiryOptions(e, now);
    return optionRow(x.labels, x.at, vw, null, pick);
  };
  const label = f => (form.ws && f !== 'name' ? clipName(String(e[f]?.shortcut ?? '?'), 9).text : f);
  const out = [lr(chalk.bold(form.name), chalk.dim(form.ws ? 'workspace' : KIND_NAMES[kindOf(e)]), w, 10), ''];
  rows.forEach((f, i) => {
    const sel = i === form.field;
    const v = sel && form.editing ? inputLine(form.buffer, form.cursor, vw) : value(f);
    const l = label(f);
    out.push(`${sel ? pick('›') : ' '} ${(sel ? chalk.bold : chalk.dim)(l)}${' '.repeat(Math.max(1, 11 - vis(l)))}${v}`);
  });
  if (form.ws && !e.length) out.push(chalk.dim('  no entries: mark shortcuts with space, then ^a here'));
  out.push('', ...ui.wrap([[formNote(rows[form.field], form), chalk.dim]], Math.max(1, w - 2)).map(l => `  ${l}`));
  return out.map(l => ui.truncate(l, w));
}

// The form's key row; `inputRow` while a field is being typed in.
function formKeys(form, inputRow) {
  if (form.editing) return inputRow;
  const f = formRows(form)[form.field];
  const entry = form.ws && f !== 'name';
  const enter = form.kind ? 'new target' : entry ? 'start command' : isTextRow(f, form.ws) && 'edit';
  const change = entry ? 'opener' : f === 'type' ? 'type' : ['opener', 'color', 'expires'].includes(f) && 'change (saved)';
  return keyHint([enter && ['↵', enter], change && ['←→', change], ['↑↓', 'field'], entry && ['^d', 'remove'],
    form.history?.length && ['^z', 'undo'], ['esc', form.kind ? 'keep type' : 'done']]);
}

const VIEWS = { shortcuts: 'Shortcuts', apps: 'Apps', workspaces: 'Workspaces', settings: 'Settings' };
// Tab cycles the tabs the views setting shows; Settings sits outside the cycle on Shift+Tab, so Tab from it goes to Shortcuts.
export const nextView = (view, views) => { const c = shownTabs(views); return c[(c.indexOf(view) + 1) % c.length]; };
// Shift+Tab back from Settings: a tab hidden meanwhile goes to Shortcuts.
export const backTo = (view, views) => (shownTabs(views).includes(view) ? view : 'shortcuts');
// scope: where a setting applies (tui = this selector, web = upex ui, cli = commands), dim right of its row.
const SETTING_ROWS = [
  { section: 'General', key: 'startView', label: 'Start view', scope: 'tui+web', names: { shortcuts: 'Shortcuts', apps: 'Apps', workspaces: 'Workspaces', last: 'Last used' } },
  { section: 'General', key: 'views', label: 'Tabs', scope: 'tui+web', names: { all: 'All', 'no-workspaces': 'Shortcuts, Apps', 'no-apps': 'Shortcuts, Workspaces', shortcuts: 'Shortcuts only' } },
  { section: 'General', key: 'enter', label: 'After open', scope: 'tui', names: { quit: 'Quit', stay: 'Stay open' } },
  { section: 'General', key: 'numberKeys', label: 'Number keys', scope: 'tui', names: { off: 'Off', on: '1 to 9 open' } },
  { section: 'General', key: 'updateCheck', label: 'Update check', scope: 'cli', names: { on: 'On', off: 'Off' } },
  { section: 'General', key: 'staleAfter', label: 'Stale after', scope: 'all', names: { 30: '30 days', 60: '60 days', 90: '90 days', 180: '180 days' } },
  { section: 'Search', key: 'fuzzy', label: 'Fuzzy', scope: 'tui+cli', names: { normal: 'Normal', exact: 'Exact', loose: 'Loose' } },
  { section: 'Search', key: 'searchIn', label: 'Search in', scope: 'tui+web', names: { all: 'Names, paths, tags', names: 'Names only' } },
  { section: 'Terminals', key: 'terminalLayout', label: 'Layout', scope: 'all', names: { here: 'This window', windows: 'Separate windows', tabs: 'Tabs', panes: 'Split panes' } },
  { section: 'Terminals', key: 'paneSplit', label: 'Pane split', scope: 'all', names: { auto: 'Auto', vertical: 'Side by side', horizontal: 'Stacked' } },
  { section: 'Terminals', key: 'terminalShell', label: 'Shell', scope: 'all', names: { cmd: 'cmd', powershell: 'PowerShell', pwsh: 'PowerShell 7', profile: 'WT profile' } },
  { section: 'Opening', key: 'defaultOpener', label: 'Default opener', scope: 'all' },
  { section: 'Opening', key: 'confirmMany', label: 'Confirm many', scope: 'tui', names: { off: 'Off', 3: 'Over 3', 5: 'Over 5', 10: 'Over 10' } },
  { section: 'List', key: 'sort', label: 'Sort', scope: 'tui+web', names: { recent: 'Most used', name: 'A to Z', opened: 'Last opened', added: 'Recently added' } },
  { section: 'List', key: 'recentStrip', label: 'Recent on top', scope: 'tui', names: { off: 'Off', 3: '3', 5: '5' } },
  { section: 'List', key: 'pinned', label: 'Pinned', scope: 'tui+web', names: { top: 'On top', section: 'Own section' } },
  { section: 'List', key: 'groups', label: 'Groups', scope: 'tui+web', names: { off: 'Off', tags: 'By tag' } },
  { section: 'List', key: 'maxRows', label: 'Max rows', scope: 'tui', names: { auto: 'Auto', 8: '8', 12: '12', 16: '16' } },
  { section: 'List', key: 'density', label: 'Density', scope: 'tui+web', names: { comfortable: 'Comfortable', compact: 'Compact' } },
  { section: 'Rows', key: 'paths', label: 'Paths', scope: 'all', names: { dim: 'Dim folders', full: 'Full', hidden: 'Hidden' } },
  { section: 'Rows', key: 'rowDetails', label: 'Row details', scope: 'all', names: { both: 'Both', tags: 'Tags', badges: 'Badges', none: 'None' } },
  { section: 'Rows', key: 'usage', label: 'Usage', scope: 'tui+web', names: { ago: 'Last opened', opens: 'Opens', off: 'Off' } },
  { section: 'Look', key: 'accent', label: 'Accent', scope: 'tui+web', names: { default: 'Default', green: 'Green', blue: 'Blue', purple: 'Purple', orange: 'Orange' } },
  { section: 'Look', key: 'glyphs', label: 'Glyphs', scope: 'tui', names: { unicode: 'Unicode', ascii: 'ASCII' } },
  { section: 'Look', key: 'theme', label: 'Web theme', scope: 'web', names: { system: 'System', dark: 'Dark', light: 'Light' } },
  { section: 'Look', key: 'keyHints', label: 'Key hints', scope: 'tui', names: { full: 'Full', short: 'Short', off: 'Off' } },
  { section: 'Look', key: 'flash', label: 'Message time', scope: 'tui', names: { 3: '3 s', 6: '6 s', key: 'Until a key' } },
  { section: 'Look', key: 'fullScreen', label: 'Full screen', scope: 'tui', names: { on: 'On', off: 'Off' } },
  { section: 'Look', key: 'mouse', label: 'Mouse', scope: 'tui', names: { on: 'On', off: 'Off' } },
  { section: 'Detail pane', key: 'narrowPane', label: 'Pane on narrow', scope: 'tui', names: { toggle: 'Shift+→ / ←', always: 'Always' } },
  { section: 'Detail pane', key: 'paneWidth', label: 'Width', scope: 'tui', names: { normal: 'Normal', narrow: 'Narrow', wide: 'Wide' } },
  { section: 'Detail pane', key: 'goals', label: 'Open goals', scope: 'tui', names: { off: 'Off', 3: '3', 5: '5', 10: '10' } },
  { section: 'Detail pane', key: 'git', label: 'Git status', scope: 'tui', names: { off: 'Off', on: 'On' } },
];
// Pane split only matters for split panes, mouse for full screen; Windows-only rows hide elsewhere.
const visibleRows = s => SETTING_ROWS.filter(r => settingShown(r.key) && (r.key !== 'paneSplit' || s.terminalLayout === 'panes')
  && (r.key !== 'mouse' || s.fullScreen !== 'off'));
// Settings rows and the openers, maintenance and archived rows under them, narrowed by the typed filter
// (section, label, options and note; extras by name and note, archived by name and path).
export function settingsList(s, q = '', extras = [], archived = [], wt = null) {
  const has = text => text.toLowerCase().includes(q.trim().toLowerCase());
  // The note of every value, so changing a row never hides it.
  const notes = r => (settingValues(r.key) || [s[r.key]]).map(v => settingNote(r.key, { ...s, [r.key]: v }, wt)).join(' ');
  const rows = visibleRows(s).filter(r => has(`${r.section} ${r.label} ${Object.values(r.names || {}).join(' ')} ${notes(r)}`));
  const more = [...extras, ...archived.map(a => ({ section: 'Archived', kind: 'archived', ...a }))]
    .filter(x => has(`${x.section} ${x.name} ${x.kind === 'archived' ? x.path : EXTRA_NOTES[x.kind] ?? ''}`));
  return { rows, more };
}
// Key of a settings item, to keep it picked while the filter changes.
const itemId = x => x && (x.key ?? `${x.kind}:${x.name}`);
// Inline, Max rows Auto is 8: one "8" option that keeps auto, so going full screen still fills.
const inlineRows = (row, s) => row.key === 'maxRows' && s.fullScreen === 'off';
// [key, label] options of a settings row, in SETTINGS order (object keys put "8" before "auto"); copy is no way
// to open a folder. A hex accent shows as its own option.
export const rowOptions = (row, appChoices, s = {}) => (inlineRows(row, s) ? [['auto', '8'], ['12', '12'], ['16', '16']]
  : row.names ? [...settingValues(row.key).map(k => [k, row.names[k] ?? k]), ...(row.key === 'accent' && isHex(s.accent) ? [[s.accent, s.accent]] : [])]
    : appChoices.filter(c => c.key !== 'copy').map(c => [c.key, c.label]));
// The option a row shows as picked.
export const pickedOf = (row, s) => (inlineRows(row, s) && s.maxRows === '8' ? 'auto' : s[row.key]);

function settingNote(key, s, wt) {
  if (key === 'startView') return 'The tab to open on. Last used: where you left off, opener included.';
  if (key === 'sort') return 'Shortcut order. ^o in the list cycles it.';
  if (key === 'confirmMany') return 'Enter on marked rows or a workspace that opens more windows than this asks y / n first. Off: never asks.';
  if (key === 'recentStrip') return 'The last 3 or 5 opened again above the list, under a Recent heading, whatever the sort.';
  if (key === 'staleAfter') return 'Not opened (or added, if never opened) in this long counts as stale: is:stale, Maintenance > Stale and upex stale.';
  if (key === 'mouse') return 'Clicks, right-click menu and the wheel. Off: the terminal selects text as usual.';
  if (key === 'views') return 'Which tabs show and Tab cycles through.';
  if (key === 'numberKeys') return 'Numbers the first 9 visible rows beside the › pointer, a digit opens that row. With a typed filter digits type, Alt+1 to 9 still opens.';
  if (key === 'enter') return 'What Enter does after opening. Stay open keeps upex open, to open more.';
  if (key === 'fuzzy') return 'How close a typed name must be, in this filter and for upex <name> / go. Exact: the letters in a row, no typos. Loose: more typos.';
  if (key === 'searchIn') return 'What the filter looks at. Names only: names and aliases. #tag, @opener and is:pinned, is:missing, is:stale, is:app, is:new, is:temp filter either way.';
  if (key === 'updateCheck') return `Checks npm once a day in the background; after a command, one dim line when a newer upex is out. This is v${VERSION}.`;
  if (key === 'flash') return 'How long a success message (bottom right) stays. Warnings always stay until the next key.';
  if (key === 'maxRows') return s.fullScreen === 'off' ? 'List rows here.' : 'List rows here. Auto: as many as the screen fits.';
  if (key === 'defaultOpener') return 'Opens folder shortcuts that have no opener of their own.';
  if (key === 'fullScreen') return 'Whole terminal, restored on exit. Off: inline, no mouse.';
  if (key === 'accent') return 'Color of the › pointer and the picked option. Any color: upex config set accent ff66aa';
  if (key === 'density') return 'Compact drops the spacer lines.';
  if (key === 'paths') return 'Dim folders dims the parent folders. Hidden drops paths, commands and URLs. Also upex ls / stale.';
  if (key === 'rowDetails') return 'Right side of a row: #tags, badges (pinned, app, missing), both or none. Also upex ls.';
  if (key === 'usage') return 'Right edge of a row: when it was last opened (3d ago), how often (12 opens), or nothing.';
  if (key === 'pinned') return 'Pinned shortcuts first, or first under their own Pinned heading. ^p pins, Alt+↑↓ moves one.';
  if (key === 'groups') return 'By tag: Pinned on top, then a #tag heading per tag in the sort order, like folders; two tags show under both, untagged last. Type #tag to filter.';
  if (key === 'narrowPane') return 'Under 140 columns (full screen): Shift+→ opens the pane, Shift+← or Esc closes it, or it always shows. Not under 60.';
  if (key === 'paneWidth') return 'How much of the screen the pane takes: Narrow leaves the list more room, Wide shows more details.';
  if (key === 'goals') return 'Pane right of the list (full screen): open upgo goals of a folder, up to this many. S-→ picks one to copy, a click copies it.';
  if (key === 'git') return 'Pane right of the list (full screen): branch, ahead/behind, changes and last commit of a folder in git. ^g opens its web page.';
  if (key === 'keyHints') return 'Key rows under the list. Short: one row of the main keys. ? on an empty filter shows every key (Full and Off too). Off: more room for the list. Settings keeps its keys.';
  if (key === 'glyphs') return 'ASCII swaps arrows, pointers, lines and the ellipsis for plain characters, for fonts that show boxes.';
  if (key === 'theme') return 'Colors of upex ui. The terminal keeps its own.';
  if (key === 'terminalLayout') {
    if (s.terminalLayout === 'here') return 'Terminal openers run in this terminal: upex quits (even with Stay open), a shell starts at the folder, exit comes back. Several at once and workspaces get windows.';
    if (wt === null) return 'Several terminals at once each get their own window.';
    return !wt && s.terminalLayout !== 'windows'
      ? 'Windows Terminal (wt) not found, so terminals open as separate windows.'
      : 'How several terminals open: separate windows, or tabs or panes in your current Windows Terminal window.';
  }
  if (key === 'paneSplit') return 'Where each new pane goes.';
  if (s.terminalShell !== 'profile') return 'The shell terminal openers start.';
  return wt ? 'Your Windows Terminal default profile. A start command (like claude) runs in cmd.' : 'Windows Terminal (wt) not found, so cmd opens instead.';
}

// Settings rows after the settings: what Enter does and the note under the list.
const EXTRA_KEYS = { opener: 'edit command', newOpener: 'add', broken: 'prune', stale: 'archive all', stats: 'show', doctor: 'run', update: 'check', export: 'export', import: 'import', archived: 'restore' };
const EXTRA_NOTES = {
  opener: 'A custom opener: upex runs this command with the folder. It shows in the opener row, like upex app.',
  newOpener: 'Adds an opener from a command that opens a folder, like cursor or subl, like upex app <name> <command>.',
  broken: 'Folder shortcuts whose path is gone. Enter removes them (one with an app keeps it), like upex check --prune. ^z undoes.',
  stale: 'Not opened in the Stale after days (General). Enter archives them all, like upex stale --yes. ^z undoes, or restore one under Archived.',
  stats: 'Most opened in the last 30 days. Enter shows more, like upex stats.',
  doctor: 'Checks the store, openers, shell wrapper and completion, like upex doctor.',
  update: 'Asks npm now for a newer upex. When one is out, Enter closes upex and installs it with npm i -g @uplift-beyond/upex@latest.',
  export: 'Shortcuts and settings as one JSON file, like upex export.',
  import: 'Merges a file from Export: new names are added, same names updated, like upex import.',
};

// Lines under Settings > Stats: most opened in the last 30 days, top openers, opens per week.
export function statLines(appMap = {}, history = loadHistory(), now = Date.now()) {
  const s = statsFrom(history, { since: now - 30 * 86400000, now });
  if (!s.total) return [chalk.dim('No opens in the last 30 days.')];
  const top = s.shortcuts.slice(0, 8);
  const nw = nameCol(top.map(([name]) => ({ name })));
  return [...top.map(([n, c]) => { const t = clipName(n, nw).text; return `${t}${' '.repeat(nw - vis(t) + 2)}${c}`; }),
    ...(s.shortcuts.length > top.length ? [chalk.dim(`+ ${s.shortcuts.length - top.length} more, see upex stats`)] : []),
    '',
    `${chalk.dim('openers ')} ${s.openers.slice(0, 4).map(([o, c]) => `${appMap[o]?.displayName || o} ${chalk.dim(c)}`).join(chalk.dim(' · '))}`,
    `${chalk.dim('8 weeks ')} ${sparkline(s.perWeek)}`];
}
// Lines under Settings > Doctor from runChecks rows [status, check, detail].
export const doctorLines = rows => rows.map(([s, name, detail]) => {
  const mark = { ok: chalk.green('ok  '), warn: chalk.yellow('warn'), fail: chalk.red('fail') }[s] || chalk.dim('skip');
  return `${mark}  ${name}${' '.repeat(Math.max(1, 16 - vis(name)))}${chalk.dim(detail)}`;
});

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

// upgo goals.json: open items (planned, partial), soonest phase first, then file order; done and total (dropped left out) for the bar.
const PHASE_ORDER = ['now', 'next', 'later', 'wayLater', 'maybe'];
export function goalSummary(file) {
  if (!Array.isArray(file?.items)) return null;
  const open = file.items.filter(i => ['planned', 'partial'].includes(i?.status));
  const rank = i => (PHASE_ORDER.indexOf(i.phase) + PHASE_ORDER.length + 1) % (PHASE_ORDER.length + 1);
  const done = file.items.filter(i => i?.status === 'done').length;
  return { open: open.length, done, total: done + open.length, next: [...open].sort((a, b) => rank(a) - rank(b)) };
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
  return g ? { ...g, next: g.next.slice(0, Number(max)) } : null;
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

// `left` and a right-aligned `right` in `pw` columns; `left` clips first, but `right` is cut before `left` drops under `keep` columns.
export const lr = (left, right, pw, keep = 1) => {
  const r = ui.truncate(right || '', pw - Math.min(vis(left), keep) - 2);
  const l = ui.truncate(left, Math.max(1, pw - vis(r) - (r ? 2 : 0)));
  return l + (r ? ' '.repeat(Math.max(2, pw - vis(l) - vis(r))) + r : '');
};
// Pane section: two blank lines, a bold header with its summary at the right edge, rows indented under it.
const IND = '  ';
const GAP = ['', ''];
const section = (label, right, pw) => [...GAP, lr(chalk.bold(label), right, pw, label.length)];
// Parts joined by a dim " · ", a new line when the next would pass `pw`.
export const dotLines = (parts, pw) => parts.filter(Boolean).reduce((out, p) => {
  if (out.length && vis(out.at(-1)) + 3 + vis(p) <= pw) out[out.length - 1] += chalk.dim(' · ') + p;
  else out.push(p);
  return out;
}, []);

// Pane lines of a git status from gitOf; the web line is { text, web } so a click opens it.
export function gitLines(g, pw, now = Date.now()) {
  const iw = pw - IND.length;
  const ab = [g.ahead && `↑${g.ahead}`, g.behind && `↓${g.behind}`].filter(Boolean).join(' ');
  const lines = [g.added && chalk.green(`+${g.added}`), g.deleted && chalk.red(`-${g.deleted}`)].filter(Boolean).join(' ');
  const out = [...section('GIT', `${oneLine(g.branch) || '?'}${ab ? `  ${ab}` : ''}`, pw),
    IND + (g.changed ? lr(`${g.changed} file${g.changed > 1 ? 's' : ''} changed`, lines, iw) : chalk.dim('clean'))];
  // The subject clips first, so the age stays.
  if (g.last) out.push(IND + lr(oneLine(g.last.subject), chalk.dim(`${ui.span(now - g.last.time)} ago`), iw));
  if (g.web) out.push({ text: IND + lr(g.web.replace(/^https:\/\//, ''), chalk.dim('^g'), iw), web: true });
  return out;
}

// Detail pane lines for the selected row, each at most `pw` wide; clickable ones are { text, web | copy, msg }.
// `goals` from goalSummary, `sel` the picked one.
export function detailLines(c, pw, appChoices = [], now = Date.now(), { goals = null, sel = -1, pick = chalk.bold, git = null } = {}) {
  if (!c) return [];
  if (c.entries) return [chalk.bold(clipName(c.name, pw).text), '', ...c.entries.map(describeEntry)].map(l => ui.truncate(l, pw));
  const opener = c.opener && (appChoices.find(a => a.key === c.opener)?.label || c.opener);
  const stats = [c.uses ? `${c.uses} open${c.uses > 1 ? 's' : ''}` : 'never opened', c.lastUsed && `${ui.span(now - c.lastUsed)} ago`, opener];
  const star = c.pinned ? `${PIN} ` : '';
  // Stats right-aligned beside the name, cut before the name drops under 10 columns.
  const out = [lr(star + chalk.bold(c.name), [c.exists === false && chalk.red('missing'), chalk.dim(stats.filter(Boolean).join(' · '))].filter(Boolean).join('  '),
    pw, vis(star) + 10)];
  // Local day; a hand-edited bad value is left out (toISOString would throw).
  const added = new Date(c.added || NaN);
  // Not opened (or added, if never opened) in 30+ days, like upex stale.
  const stale = now - (c.lastUsed || c.added || 0) >= 30 * 86400000;
  // The note, wrapped at spaces (3 lines at most, the last one clipped).
  const note = [];
  for (let s = oneLine(c.note), w = Math.max(1, pw - 2); s; s = s.slice(note.at(-1).length).trimStart()) {
    const fit = ui.fit(s, w) || s[0];
    const cut = fit.length < s.length && fit.lastIndexOf(' ') > 0 ? fit.slice(0, fit.lastIndexOf(' ')) : fit;
    note.push(note.length === 2 ? ui.truncate(s, w) : cut);
    if (note.length === 3) break;
  }
  // A dim meta line under the title, then warnings and the note as their own block.
  out.push(...dotLines([c.isCmd ? 'command' : c.isApp ? 'app' : c.isUrl ? 'url' : 'folder',
    c.tags?.length && `#${c.tags.join(' #')}`,
    c.aliases?.length && `aka ${c.aliases.join(' ')}`,
    !isNaN(added) && `added ${added.toLocaleDateString('sv-SE')}`,
    c.expires && `expires in ${ui.span(c.expires - now, Math.ceil)}`], pw).map(l => chalk.dim(l)));
  if (c.same?.length || stale || note.length) out.push(...GAP);
  if (c.same?.length) out.push(chalk.yellow(`same path as ${c.same.join(' ')}`));
  // A click on it archives, like ^x.
  if (stale) out.push({ text: lr(chalk.yellow('stale 30+ days'), chalk.dim('^x archive'), pw), archive: true });
  out.push(...note.map(l => `${chalk.dim('▎')} ${l}`));
  if (git) out.push(...gitLines(git, pw, now));
  // Phase in its own column, once per group. A click copies a goal, like Enter in the picker.
  if (goals) {
    const fill = goals.total ? Math.round((goals.done / goals.total) * 10) : 0;
    const bar = goals.total ? `${chalk.green('▰'.repeat(fill))}${chalk.dim('▱'.repeat(10 - fill))} ` : '';
    out.push(...section('GOALS', `${bar}${goals.done}/${goals.total}`, pw), ...goals.next.map((g, i) => {
      // 8 fits wayLater, plus a space before the › pointer.
      const phase = oneLine(g.phase) !== oneLine(goals.next[i - 1]?.phase) ? oneLine(g.phase).slice(0, 8) : '';
      const title = ui.truncate(oneLine(g.title ?? g.id), Math.max(1, pw - 13));
      const text = IND + chalk.dim(phase.padEnd(9)) + (i === sel ? `${pick('›')} ${chalk.bold(title)}` : `  ${title}`);
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

// Pane with marks, `rows` tall: each marked row and what Enter opens it in, then what ^x does.
// `marked` [{ c, app, count }] as Enter would open them.
export function markLines(marked, pw, rows, appChoices = [], pick = chalk.bold) {
  const n = marked.length;
  const nw = Math.min(nameCol(marked.map(m => m.c)), Math.floor(pw / 2));
  // Head, blank, Enter line, blank and ^x line take 5; a cut list ends in "↓ n more".
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
  out.push('', `${hintKey('^x')} ${chalk.dim(`archives ${n > 1 ? `all ${n}` : 'it'}, ^z undo`)}`);
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
  archived = [], // Settings: archived shortcuts [{ name, path }]
  extras = [], // Settings: rows before Archived [{ section, kind, name, text }] (openers, maintenance)
  expanded = null, // Settings: { kind, lines } shown under that extra row (stats, doctor)
  ask = '', // confirm question, else the delete / archive one
  keysHelp = false, // ? or ^k: every key over the list
  inputName = null, // name in the input prompt, else the selected row's
  form = null, // edit form (mode 'form'), see formLines
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
  picker = false, // upex pick: Enter prints paths
  offers = [], // no matches: noMatchOffers
  offerIndex = 0,
  suggest = null, // learned folder to offer as a shortcut { name, path }, a row under the list
}) {
  asciiHints = settings.glyphs === 'ascii';
  const isWs = view === 'workspaces';
  const isSettings = view === 'settings';
  const isScripts = mode === 'scripts' && !!scripts;
  const isForm = mode === 'form' && !!form;
  const currentChoice = (isWs ? workspaces : choices)[isWs ? wsIndex : selectedIndex];
  // `width` leaves the terminal's last column free.
  const pane = !isSettings && paneShown(width + 1, full, paneOpen || settings.narrowPane === 'always');
  const toggles = !isSettings && paneToggles(width + 1, full, settings);
  // Scripts and the edit form go in the pane when there is one, else they replace the list.
  const listScripts = isScripts && !pane;
  const listForm = isForm && !pane;
  const list = listScripts ? scripts.list : isWs ? workspaces : choices;
  const index = listScripts ? scriptIndex : isWs ? wsIndex : selectedIndex;
  // Workspace and script rows: plain text, no badges.
  const plain = isWs || listScripts;
  const numbered = settings.numberKeys === 'on' && mode === 'browse' && !isScripts;
  // With marks, the pane lists them instead of the selected row.
  const marking = pane && !isWs && !isScripts && !isForm && marked.length > 0;
  const goals = pane && !isWs && !marking && !isForm ? folderGoals(currentChoice, settings.goals) : null;
  const isGoals = mode === 'goals' && !!goals?.next.length;
  const git = pane && !isWs && !isScripts && !marking && !isForm ? folderGit(currentChoice, settings.git, gitFor) : null;
  const w = Math.max(width, 20);
  const pw = pane ? paneWidthOf(w, settings.paneWidth) : 0; // pane width
  const lw = pane ? w - pw - 3 : w; // list width, " │ " between
  const cw = lw - 2; // row width after the 2-space indent
  // With the pane, the rules join its │ with ┬ (top) and ┴ (bottom).
  const ruleText = j => (pane ? `  ${'─'.repeat(lw - 1)}${j}${'─'.repeat(pw + 1)}` : `  ${'─'.repeat(w - 2)}`);
  const ruleOf = j => chalk.dim(ruleText(j));
  // A plain string is a warning; { text, ok: true } a success. One line, right end of the bottom rule, so nothing moves.
  const flashText = flash ? ui.truncate(` ${String(flash.text ?? flash).replace(/\s*\n\s*/g, ' ')} `, w - 6) : '';
  const flashOn = (flash.ok ? chalk.green : chalk.yellow)(flashText);
  // Without a flash, the version sits there (dim): always on Settings, elsewhere only from VERSION_WIDTH columns.
  const tagText = flash ? flashText : isSettings || width + 1 >= VERSION_WIDTH ? ` v${VERSION} ` : '';
  const at = w - vis(tagText) - 2;
  const rule = chalk.dim(ruleText('┴').slice(0, at)) + (flash ? flashOn : chalk.dim(tagText)) + chalk.dim(ruleText('┴').slice(at + vis(tagText)));
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
    const label = PROMPT_LABEL[action](clipName(String(inputName ?? currentChoice?.name ?? ''), 24).text, inputName);
    // Keep the end of a long value in view, where the cursor is.
    lines.push(`  ${chalk.bold(pick('›'))} ${label} ${inputLine(inputBuffer, inputCursor, Math.max(1, w - vis(label) - 5))}`);
  } else if (mode === 'confirm') {
    const what = `  ? ${action?.startsWith('archive') ? 'archive' : 'delete'} ${isWs ? 'workspace ' : ''}`;
    // Clip the name, not the line, so "y / n" stays visible.
    const name = clipName(currentChoice?.name || '', Math.max(1, w - vis(what) - 10)).text;
    const q = ask ? `  ? ${ui.truncate(ask, Math.max(1, w - 12))}` : action === 'archiveMarked' ? `${what}${marks.size} marked?` : `${what}"${name}"?`;
    lines.push(chalk.yellow(q) + chalk.dim('  y / n'));
  } else if (isForm) {
    const left = `  ${chalk.bold(pick('›'))} ${chalk.dim(form.ws ? 'edit workspace' : 'edit')} ${chalk.bold(clipName(form.name, 24).text)}`;
    const right = chalk.dim('saved as you go');
    lines.push(left + (vis(left) + vis(right) + 2 <= w ? ' '.repeat(w - vis(left) - vis(right)) + right : ''));
  } else if (isScripts) {
    const name = clipName(currentChoice?.name || '', 24).text;
    lines.push(`  ${chalk.bold(pick('›'))} ${chalk.dim('run a script of')} ${chalk.bold(name)} ${chalk.dim(`(${scripts.pm})`)}`);
  } else if (isGoals) {
    lines.push(`  ${chalk.bold(pick('›'))} ${chalk.dim('copy a goal of')} ${chalk.bold(clipName(currentChoice.name, 24).text)}`);
  } else {
    const left = `  ${chalk.bold(pick('›'))} ${query ? `${query}${chalk.dim('▏')}` : chalk.dim('▏type to filter')}`;
    const right = !isWs && !isSettings && marks.size ? pick(`● ${marks.size} marked`) : '';
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
  const inputRow = keyHint([['↵', 'save'], isForm && formRows(form)[form.field] === 'tags' && ['tab', 'complete'], ['←→', 'cursor'], ['^⌫', 'word'], ['^u', 'clear'], ['esc', 'cancel']]);
  // Blank row first, so the link sits apart from the key hints.
  const webRows = webUrl ? [...gap, webStatus(webUrl, w)] : [];

  if (isSettings) {
    // Openers and maintenance, then archived shortcuts last, their index after the setting rows; Enter acts on one.
    const { rows, more } = settingsList(settings, query, extras, archived, wt);
    // Body lines { text, hits, i }: a bold heading where the section changes, then its rows.
    const body = [];
    // Scope tags right of the rows, when there is room for them.
    const tagW = w >= 60 ? 9 : 0;
    rows.forEach((row, i) => {
      if (row.section !== rows[i - 1]?.section) {
        if (i) body.push(...gap.map(text => ({ text })));
        body.push({ text: `  ${chalk.bold(row.section)}` });
      }
      const opts = rowOptions(row, appChoices, settings);
      const sel = i === settingIndex;
      const spans = [];
      const picker = optionRow(opts.map(([, l]) => l), opts.findIndex(([k]) => k === pickedOf(row, settings)), w - 20 - tagW, spans, pick);
      const hits = [...spans.map(s => [20 + s.from, 20 + s.to, { setting: i, option: s.index }]), [0, w, { setting: i }]];
      const tag = tagW ? ' '.repeat(Math.max(1, w - 20 - vis(picker) - row.scope.length)) + chalk.dim(row.scope) : '';
      body.push({ text: `  ${sel ? pick('›') : ' '} ${(sel ? chalk.bold : chalk.dim)(row.label.padEnd(16))}${picker}${tag}`, hits, i });
    });
    if (!rows.length && !more.length) body.push({ text: chalk.dim('    No settings match.') });
    more.forEach((x, k) => {
      if (x.section !== more[k - 1]?.section) {
        const n = x.kind === 'archived' ? ` ${chalk.dim(more.filter(m => m.kind === 'archived').length)}` : '';
        body.push(...gap.map(text => ({ text })), { text: `  ${chalk.bold(x.section)}${n}` });
      }
      const i = rows.length + k;
      const sel = i === settingIndex;
      const name = clipName(x.name, 15).text;
      const text = `  ${sel ? pick('›') : ' '} ${(sel ? chalk.bold : chalk.dim)(name)}${' '.repeat(16 - vis(name))}${ui.truncate(x.kind === 'archived' ? chalk.dim(tidyPath(x.path)) : x.text, w - 20)}`;
      body.push({ text, hits: [[0, w, { setting: i }]], i });
      if (expanded?.kind === x.kind) body.push(...expanded.lines.map(l => ({ text: `      ${ui.truncate(l, w - 8)}` })));
    });
    const onExtra = more[settingIndex - rows.length];
    const onArchived = onExtra?.kind === 'archived';
    // Too tall for the terminal: scroll so the picked row stays in view (note + footer take the rest).
    const room = height - lines.length - gap.length - 3 - webRows.length;
    const { start, end } = getVisibleWindow(body, body.findIndex(b => b.i === settingIndex), Math.max(1, room));
    for (const b of body.slice(start, end)) {
      for (const [from, to, t] of b.hits || []) hit(lines.length, from, to, t);
      lines.push(b.text);
    }
    const note = onArchived ? `Enter or a second click brings it back to its tab, like upex restore ${onExtra.name}. ^d deletes it for good.`
      : onExtra ? EXTRA_NOTES[onExtra.kind] : rows[settingIndex] ? settingNote(rows[settingIndex].key, settings, wt) : '';
    lines.push(...gap, chalk.dim(`    ${note}`));
    const enter = onExtra && ['↵', expanded && expanded.kind === onExtra.kind ? 'hide' : onExtra.kind === 'update' && isNewer(cachedLatest(), VERSION) ? 'update' : EXTRA_KEYS[onExtra.kind]];
    const keys = mode === 'input' ? inputRow
      : keyHint([['↑↓', 'setting'], enter || (rows[settingIndex] && ['←→', 'change (saved)']), onExtra?.kind === 'opener' && ['^d', 'remove'], onArchived && ['^d', 'delete'], undoKey, tabKey, ['S-Tab', 'back'], escKey, uiKey]);
    return footer([keys, ...webRows]);
  }

  const openerSpans = [];
  const openers = optionRow(appChoices.map(c => `${c.label}${isTerminalApp(c.key) && cmdCount > 1 ? ` ×${cmdCount}` : ''}`), selectedAppIndex, w - 13, openerSpans, pick);
  const isShortcuts = view === 'shortcuts';
  const offer = list.length === 0 && mode === 'browse' && offers[offerIndex];
  const openKey = ['↵', offer ? offer.key : picker ? (many || isWs ? 'print paths' : 'print path') : many ? `open ${many} marked` : isShortcuts ? 'open' : isWs ? 'open all' : currentChoice?.isUrl ? 'open in browser' : 'launch app'];
  const markKey = !isWs && list.length > 0 && ['space', 'mark'];
  const opener = isShortcuts && ['←→', 'opener'];
  const windows = isShortcuts && terminal && ['S-↑↓', 'windows'];
  const scriptsKey = isShortcuts && !picker && ['^s', 'scripts'];
  const movePin = !isWs && !query?.trim() && currentChoice?.pinned && ['A-↑↓', 'move pin'];
  const goalsKey = goals?.next.length && ['S-→', 'goals'];
  const webKey = git?.web && ['^g', hostName(git.web)];
  const paneKey = toggles && (pane ? ['S-←', 'hide details'] : ['S-→', 'details']);
  const editKeys = [(isShortcuts || isWs) && ['^a', isWs ? 'add marked' : 'add'], list.length > 0 && ['^e', 'edit'], !isWs && ['^r', 'rename']];
  const pinKey = !isWs && list.length > 0 && ['^p', currentChoice?.pinned ? 'unpin' : 'pin'];
  // Shortcuts are archived, not deleted (^d deletes in Settings > Archived); workspaces have no archive.
  const dropKey = isWs ? list.length > 0 && ['^d', 'delete'] : (list.length > 0 || many) && ['^x', many ? `archive ${many} marked` : 'archive'];
  const copyKey = !isWs && list.length > 0 && ['^y', 'copy'];
  const sortKey = !isWs && ['^o', 'sort'];
  // Full: rows of keys, a pair that doesn't fit wraps. Keys that change with the selection, marks, filter or mode
  // count at their widest for the row count, so the list only moves on resize. Esc already saying "hide details" drops the pane key.
  const paneHint = escKey[1] !== paneKey[1] && paneKey;
  const fullRows = ({ open = openKey, win = windows, esc = escKey, pane: pk = paneHint, pin = movePin, goals: gk = goalsKey, p = pinKey, drop = dropKey, z = undoKey, web = webKey } = {}) => [
    ...wrapHint([open, ['↑↓', 'move'], opener, win, tabKey, esc, pk, pin, markKey, gk], w),
    ...wrapHint([...editKeys, p, drop, z, uiKey, copyKey, sortKey, HINT_SEP, scriptsKey, web], w),
  ];
  const most = `${Math.max(many, 9)} marked`;
  const widest = fullRows({
    open: isWs ? openKey : ['↵', isShortcuts ? `open ${most}` : 'open in browser'],
    win: isShortcuts && ['S-↑↓', 'windows'],
    esc: ['esc', 'cancel'],
    pane: paneKey,
    pin: !isWs && ['A-↑↓', 'move pin'],
    goals: isShortcuts && pane && Number(settings.goals) > 0 && ['S-→', 'goals'],
    p: pinKey && ['^p', 'unpin'],
    drop: isWs ? dropKey : ['^x', `archive ${most}`],
    z: ['^z', 'undo'],
    web: isShortcuts && pane && settings.git === 'on' && (webKey || ['^g', 'github']),
  });
  const padTo = (rows, n) => [...rows, ...Array(Math.max(0, n - rows.length)).fill('')];
  // Key hints setting. Full: the rows above (typing: input keys, same height so the list stays put). Short: one row
  // without the keys you learn first (↑↓, tab, esc), cut to the width; ? shows them all. Off: none.
  const hints = settings.keyHints === 'off' ? []
    : settings.keyHints === 'short' ? [mode === 'input' ? inputRow : fitHint([['?', 'keys'], openKey, opener, windows, ...editKeys, pinKey, dropKey, undoKey, markKey, scriptsKey, goalsKey, webKey, paneKey, uiKey, copyKey, sortKey, movePin], w)]
      : padTo(mode === 'input' ? [inputRow] : fullRows(), widest.length);
  const foot = isForm ? (hints.length ? padTo([formKeys(form, inputRow)], settings.keyHints === 'short' ? 1 : widest.length) : [])
    : isScripts ? (hints.length ? [keyHint([['↵', 'run in a terminal'], ['↑↓', 'move'], escKey])] : [])
    : isGoals ? (hints.length ? [keyHint([['↵', 'copy'], ['↑↓', 'move'], ['esc', 'back']])] : [])
    : [...(isShortcuts ? [`  ${chalk.dim('open with')}  ${openers}`, ...(hints.length ? gap : [])] : []), ...hints];
  // No footer rows above it: no blank row under the rule.
  foot.push(...(foot.length ? webRows : webRows.slice(-1)));

  // A learned folder offered as a shortcut: a "+" row on top of the list, where it's seen, a blank row under it.
  // Not when the list would no longer fit: its least is 3 rows and a heading or "more" row, 3 rows with 0 or 1 (offers).
  const tipFits = height - lines.length - footRows(foot) - 2 >= (list.length > 1 ? 4 : 3);
  if (suggest && !keysHelp && !listForm && !listScripts && tipFits) {
    // Lined up with the list's name and color columns.
    const nameWidth = list.length ? nameCol(list) : nameCol([suggest]);
    const dotWidth = Math.max(0, ...list.map(c => vis(ui.colorDot(c.color))));
    const keys = keyHint([['^n', 'add'], ['^l', 'hide']]);
    const why = `${chalk.dim('you cd here often')}${keys}`;
    // The reason goes when it would leave the path under 12 columns.
    const right = cw - 6 - dotWidth - nameWidth - vis(why) >= 12 ? why : keys.trimStart();
    hit(lines.length, 0, lw, { suggest: true });
    lines.push(renderRow({ num: '+', name: suggest.name, text: tidyPath(suggest.path), style: 'dim', middle: true, right, cw, weight: s => s, nameWidth, dotWidth }), '');
  }

  if (keysHelp) {
    // ? or ^k: every key of this tab in groups, over the list.
    const groups = [
      ['Move', [openKey, ['↑↓', 'move'], ['PgUp/Dn Home/End', 'jump'], numbered && ['1-9', 'open row N'], opener, windows, tabKey, escKey, paneHint, markKey, !isWs && ['A-↑↓', 'move pin']]],
      ['Edit', [...editKeys, !isWs && ['F2', 'rename'], pinKey, dropKey, dropKey && ['Del', dropKey[1]], ['^z', 'undo'], copyKey]],
      ['More', [sortKey, suggest && ['^n', 'add suggested folder'], suggest && ['^l', 'hide suggestion'], scriptsKey, isShortcuts && ['S-→', 'goals'], isShortcuts && (webKey || ['^g', 'git web page']), uiKey, full && settings.mouse !== 'off' && ['right-click', 'row menu']]],
    ];
    const help = groups.flatMap(([name, pairs], i) => [...(i ? [''] : []), `    ${chalk.bold(name)}`, ...wrapHint(pairs, cw).map(r => `  ${r}`)]);
    lines.push(...help.slice(0, Math.max(0, height - lines.length - footRows(foot) - 2)), '', chalk.dim('    any key closes'));
  } else if (listForm) {
    lines.push(...formLines(form, cw, appChoices, pick).map(l => `  ${l}`));
  } else if (list.length === 0) {
    const empty = {
      workspaces: 'No workspaces yet. Mark shortcuts with space, then ^a here',
      apps: 'No app or URL shortcuts yet. Add one: upex add <name> <exe> --app',
      shortcuts: 'No folder shortcuts yet. Add one with ^A (uses the current folder)',
    };
    lines.push(query ? chalk.yellow('    no matches') : chalk.dim(`    ${empty[view]}`));
    // What Enter offers instead, as rows; a click runs one. Not while typing a name or confirming.
    const nameWidth = Math.max(...offers.map(o => vis(o.label)));
    if (offer) offers.forEach((o, i) => {
      hit(lines.length, 0, lw, { offer: i });
      lines.push(renderRow({ sel: i === offerIndex, name: o.label, nameWidth, text: o.text, style: o.kind === 'add' ? 'path' : 'dim', cw, pick }));
    });
  } else {
    const nameWidth = nameCol(list);
    // Rows left after the header and the footer (its rule included).
    const room = height - lines.length - footRows(foot);
    // Pinned setting 'section': Pinned / All headings, unless a search reorders the list.
    // Recent strip rows (withRecent) go under their own Recent heading.
    const heads = settings.pinned === 'section' && !plain && !query?.trim() && list.find(c => !c.recent)?.pinned;
    // Groups setting (withGroups): each row's `group` heading, with its count.
    const group = c => (c.recent ? 'Recent' : c.group || (heads && c.pinned ? 'Pinned' : 'All'));
    const grouped = list.some(c => c.group);
    const items = list.flatMap((c, i) => [
      ...((heads || grouped || list[0]?.recent) && (i === 0 || group(c) !== group(list[i - 1]))
        ? [{ head: group(c) + (c.group ? `  ${list.filter(x => !x.recent && x.group === c.group).length}` : '') }] : []),
      { i },
    ]);
    const { start, end } = getVisibleWindow(items, items.findIndex(x => x.i === index), Math.min(maxList, listRows(items.length, room)));
    const tagsOn = !plain && showsDetail(settings.rowDetails, 'tags');
    const badgesOn = !plain && showsDetail(settings.rowDetails, 'badges');
    // Usage padded to one width so it lines up; a color column only when one has a label.
    const now = Date.now();
    const usageW = Math.max(0, ...list.map(c => usageText(c, settings.usage, now).length));
    const dotWidth = Math.max(0, ...list.map(c => vis(ui.colorDot(c.color))));
    let shownRows = 0;
    for (const { head, i } of items.slice(start, end)) {
      if (head) { lines.push(chalk.dim(`    ${head}`)); continue; }
      shownRows++;
      const c = list[i];
      const tags = tagsOn && c.tags?.length ? chalk.dim(`#${c.tags.join(' #')}`) : '';
      const kind = c.isCmd ? 'cmd' : c.isApp ? 'app' : c.isUrl ? 'url' : '';
      const badge = !badgesOn ? '' : !c.exists ? chalk.red('missing') : chalk.dim(badgeText([c.pinned && group(c) !== 'Pinned' && PIN, kind, expiryText(c.expires, now)]));
      const via = c.via ? chalk.dim(`via ${c.via}`) : '';
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
        right: [via, tags, badge].filter(Boolean).join('  '),
        cw,
        pick,
        dot: ui.colorDot(c.color),
        dotWidth,
        usage: usageW ? chalk.dim(usageText(c, settings.usage, now).padStart(usageW)) : '',
        num: numbered && shownRows <= 9 ? String(shownRows) : '',
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
    const detail = isForm ? formLines(form, pw, appChoices, pick) : isScripts ? scriptLines(scripts, scriptIndex, pw, lines.length - bodyStart, pick)
      : marking ? markLines(marked, pw, lines.length - bodyStart, appChoices, pick)
      : detailLines(currentChoice, pw, appChoices, Date.now(), { goals, sel, pick, git });
    // Picking and taller than the pane: scroll to its end (the goals), the picked one in view.
    const skip = isGoals ? Math.max(0, Math.min(detail.length - (lines.length - bodyStart), detail.length - goals.next.length + sel)) : 0;
    for (let i = bodyStart; i < lines.length; i++) {
      const d = detail[i - bodyStart + skip];
      // A script row { text, i } is clickable right of the │.
      if (d?.i != null) hit(i, lw + 3, w, { row: d.i });
      if (d?.web) hit(i, lw + 3, w, { web: true });
      if (d?.archive) hit(i, lw + 3, w, { archive: true });
      if (d?.copy) hit(i, lw + 3, w, { copy: d.copy, msg: d.msg });
      const l = ui.truncate(lines[i], lw);
      lines[i] = `${l}${' '.repeat(Math.max(0, lw - vis(l)))}${chalk.dim(' │ ')}${d?.text ?? d ?? ''}`;
    }
  }
  // The opener row is the first footer row, after its rule; "  open with  " is 13 wide.
  if (isShortcuts && !isScripts && !isGoals && !isForm) for (const s of openerSpans) hit(lines.length + 1, 13 + s.from, 13 + s.to, { opener: s.index });
  return footer(foot);
}

// picker (upex pick): Enter always finishes, never opens in place; the caller prints the paths.
export async function runInteractiveMode({ preferredApp, stdin = process.stdin, stdout = process.stdout, picker = false } = {}) {
  let allChoices = buildChoices();
  let appChoices = [];
  let appMap = getAppMap();
  let fallback = defaultOpener();
  const config = loadConfig();
  // Start view 'last' also brings back the opener picked last time.
  // Copy left the opener row (^y now): a remembered copy is dropped.
  const lastOpener = !preferredApp && setting('startView', config) === 'last' && config.lastOpener !== 'copy' && Object.hasOwn(appMap, String(config.lastOpener)) ? config.lastOpener : null;
  // The opener row, again after Settings changes a custom opener.
  // A default opener outside the usual row (e.g. "open") still needs a slot to preselect.
  const loadApps = () => {
    appMap = getAppMap();
    appChoices = getInteractiveAppChoices();
    for (const key of new Set([fallback, lastOpener, ...allChoices.map(c => c.opener)])) {
      if (key && Object.hasOwn(appMap, key) && !appChoices.some(c => c.key === key)) {
        appChoices.push({ key, label: appMap[key].displayName });
      }
    }
  };
  loadApps();

  if (!stdin.isTTY || !stdout.isTTY) {
    if (allChoices.length) return { status: 'noninteractive' };
    ui.blank();
    ui.info('No shortcuts saved. Use: upex add <name> [path]');
    ui.blank();
    return { status: 'empty' };
  }

  return new Promise((resolve, reject) => {
    let query = '';
    // Tab cycles 'shortcuts' | 'apps' | 'workspaces'; --app only matters on Shortcuts.
    // No shortcuts yet: Shortcuts, where ^a adds the first.
    let view = preferredApp || !allChoices.length ? 'shortcuts' : startTab(config);
    let choices = allChoices.filter(inView(view));
    let filteredChoices = choices;
    let selectedIndex = 0;
    let wsChoices = buildWorkspaceChoices();
    let filteredWs = wsChoices;
    let wsIndex = 0;
    let cmdCount = 1;
    let frame = [];   // inline mode: lines drawn last time
    let alt = false;  // on the alternate screen
    let mode = 'browse';   // 'browse' | 'input' | 'confirm' | 'scripts' | 'goals' | 'form'
    let paneOpen = false;  // Shift+Right on a narrow screen
    let goalIndex = 0;     // goal picker
    let scripts = null;    // script picker: { pm, list }
    let scriptIndex = 0;
    let action = null;     // input: a PROMPT_LABEL key, confirm: 'delete' (workspace) | 'archive' | 'archiveMarked' | 'deleteArchived' | 'prune' | 'stale' | 'removeOpener'
    let inputBuffer = '';
    let inputCursor = 0;
    let flash = '';
    const wsUndo = []; // workspaces deleted this session { name, entry }, newest last: not in the links.json backups
    let canUndo = hasBackups();
    const marks = new Set(); // Space-marked shortcut names, across filtering and tabs
    let backView = view; // where Shift+Tab returns from Settings
    let settings = readSettings(); // appearance applies on every tab
    let settingIndex = 0;
    let archived = []; // Settings: archived shortcuts, read when it opens
    let offers = []; // no matches: noMatchOffers for the typed filter
    let offerIndex = 0;
    let extras = []; // Settings: openers and maintenance rows, read when it opens
    let expanded = null; // Settings: { kind, lines } of stats or doctor
    let ask = ''; // confirm question for the Settings actions
    let keysHelp = false; // ? (empty filter) or ^k key overlay, any key closes it
    let inputName = null; // the prompt's name when it isn't the selected row's (an opener, a count)
    let form = null; // edit form: { name, ws, field, editing, buffer, cursor, kind, history }
    let pending = null; // Confirm many: the open waiting for y
    let suggest = picker ? null : topSuggestion(); // learned folder (upex cd) to offer as a shortcut
    const tipShown = () => !!suggest && view === 'shortcuts' && mode === 'browse';
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
    let menu = null;    // right-click menu: { items: [{ label, run }], index, line, col }
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
      stdout.write(on ? ALT_ON + (settings.mouse === 'on' ? MOUSE_ON : '') : MOUSE_OFF + ALT_OFF);
      alt = on;
    };

    const redraw = () => {
      if (!appPicked && view === 'shortcuts') {
        selectedAppIndex = Math.max(0, appIndex(ownOpener(filteredChoices[selectedIndex])));
      }
      // Goal picker whose pane or goals went away (resize): back to browse.
      if (mode === 'goals' && !paneGoals()?.next.length) mode = 'browse';
      // Edit form whose shortcut or workspace went away meanwhile.
      if (mode === 'form' && !formEntry()) { mode = 'browse'; form = null; }
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
        undo: wsUndo.length > 0 || canUndo,
        settings,
        settingIndex,
        archived,
        extras,
        expanded,
        ask,
        keysHelp,
        inputName,
        form: mode === 'form' && form ? { ...form, entry: formEntry() } : null,
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
        picker,
        offers,
        offerIndex,
        suggest: tipShown() ? suggest : null,
      });
      // Never taller than the screen, or the top scrolls away and frames stack up.
      let shown = output.split('\n').slice(0, height).map(line => ui.truncate(line, width));
      if (menu && alt) {
        const m = overlayMenu(shown, menu, width);
        shown = m.lines;
        targets.unshift(...m.hits);
      }
      const clipped = shown.map(settings.glyphs === 'ascii' ? ui.toAscii : l => l);

      if (alt) {
        stdout.write(`\x1b[H${clipped.join('\x1b[K\n')}\x1b[K\x1b[J`);
        return;
      }
      clearRendered();
      stdout.write(clipped.join('\n') + '\n');
      frame = clipped;
    };

    const updateFilter = () => {
      filteredWs = filterChoices(wsChoices, query, settings);
      wsIndex = Math.max(0, Math.min(wsIndex, filteredWs.length - 1));
      filteredChoices = filterChoices(choices, query, settings);
      if (!query.trim()) {
        const base = filteredChoices;
        if (settings.groups === 'tags') filteredChoices = withGroups(base, settings.sort === 'name');
        if (settings.recentStrip !== 'off') filteredChoices = withRecent(base, Number(settings.recentStrip), filteredChoices);
      }
      offers = filteredChoices.length || !query.trim() ? [] : noMatchOffers(query, view, archivedList(loadLinks()));
      offerIndex = 0;
      if (filteredChoices.length === 0) {
        selectedIndex = 0;
        return;
      }
      if (selectedIndex >= filteredChoices.length) {
        selectedIndex = filteredChoices.length - 1;
      }
    };

    // Select these again when they're still in the filtered lists; `like` prefers the copy in the same Recent strip or group.
    const reselect = (name, wsName, like = {}) => {
      const same = filteredChoices.findIndex(c => c.name === name && !!c.recent === !!like.recent && c.group === like.group);
      const i = same >= 0 ? same : filteredChoices.findIndex(c => c.name === name);
      if (i >= 0) selectedIndex = i;
      const j = filteredWs.findIndex(c => c.name === wsName);
      if (j >= 0) wsIndex = j;
    };

    // Reload from disk after a mutation and try to keep `name` / `wsName` selected.
    const rebuild = (name, wsName) => {
      const like = filteredChoices[selectedIndex];
      allChoices = buildChoices();
      choices = allChoices.filter(inView(view));
      wsChoices = buildWorkspaceChoices();
      for (const n of marks) if (!allChoices.some(c => c.name === n)) marks.delete(n);
      updateFilter();
      reselect(name, wsName, like);
      canUndo = hasBackups();
      if (!picker) suggest = topSuggestion();
    };

    const clearQuery = () => {
      const keep = [filteredChoices[selectedIndex]?.name, filteredWs[wsIndex]?.name];
      query = '';
      updateFilter();
      reselect(...keep);
    };

    // Success messages fade after the flash setting (3s, 6s, or never); warnings stay until the next key.
    let flashTimer = null;
    const done = (text) => {
      const f = flash = { text, ok: true };
      clearTimeout(flashTimer);
      const ms = Number(settings.flash) * 1000;
      if (ms) flashTimer = setTimeout(guard(() => { if (flash === f) { flash = ''; redraw(); } }), ms);
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
    const tabsOn = appKey => !picker && staysOpen(appKey, setting('terminalLayout'), hasWindowsTerminal);
    // Layout 'here' hands this terminal over, so the selector has to quit even with Stay open.
    const staying = () => !picker && settings.enter === 'stay';
    const stay = (appKey, n = 1) => staying() && !(isTerminalApp(appKey) && n === 1 && setting('terminalLayout') === 'here');

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
      for (const w of watchers) w.close();
      clearTimeout(reloadTimer);
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
      if (view !== 'shortcuts' || !c || picker) return;
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
      if (tab || stay('cmd')) { openHere([{ shortcut: c.name, app: 'cmd', start }], `running "${start}"${tab ? ' in a new tab' : ''}`, [c.name]); return; }
      finish({ status: 'selected', name: c.name, app: 'cmd', count: 1, start });
    };

    // Goals the pane shows now (same checks as the render), else null.
    const paneOn = () => view === 'shortcuts' && paneShown(stdout.columns || 80, alt, paneOpen || settings.narrowPane === 'always');
    const toggles = () => view !== 'settings' && paneToggles(stdout.columns || 80, alt, settings);
    const paneGoals = () => (paneOn() && !marks.size ? folderGoals(filteredChoices[selectedIndex], settings.goals) : null);
    // A git lookup landing redraws, which shows it (and looks up the row selected meanwhile).
    let closed = false;
    const watchers = [];    // live reload, set up last
    let reloadTimer = null;
    const gitFor = dir => gitOf(dir, guard(() => { if (!closed) redraw(); }));
    // ^g / a click on the pane's web line: the selected repo's web page.
    const openWeb = () => {
      const url = paneOn() && folderGit(filteredChoices[selectedIndex], settings.git, gitFor)?.web;
      if (!url) return;
      const r = launchUrl(url);
      if (r.ok) done(`opened ${url}`);
      else flash = r.message.split('\n')[0];
    };

    // ^x: ask, then archive the marked shortcuts or the selected one; a click on the pane's stale line: only the selected.
    // ^z brings them back.
    const askArchive = (useMarks) => {
      if (view === 'workspaces') return;
      if (useMarks && marks.size) { mode = 'confirm'; action = 'archiveMarked'; }
      else if (filteredChoices[selectedIndex]) { mode = 'confirm'; action = 'archive'; }
    };
    const archive = () => {
      const links = loadLinks();
      const names = (action === 'archiveMarked' ? [...marks] : [filteredChoices[selectedIndex]?.name]).filter(n => links[n] && !links[n].archived);
      if (!names.length) return;
      // All in one save, so one ^z restores them.
      for (const name of names) links[name] = { ...links[name], archived: true };
      saveLinks(links);
      if (action === 'archiveMarked') marks.clear();
      rebuild();
      done(`archived ${howMany(names)} (^z undo)`);
    };

    const copy = (text, msg) => {
      try {
        copyToClipboard(text);
        done(msg);
      } catch (err) {
        flash = `can't copy: ${err.message.split('\n')[0]}`;
      }
    };

    // Right-click menu of the selected row: its keys, one click each. Acts on that row only, never the marks.
    const menuItems = () => {
      const ctrl = name => () => handleKey(undefined, { ctrl: true, name });
      if (view === 'workspaces') return [{ label: picker ? 'print paths' : 'open all', run: () => handleKey(undefined, { name: 'return' }) }, { label: 'edit', run: ctrl('e') }, { label: 'delete', run: ctrl('d') }];
      const c = filteredChoices[selectedIndex];
      const opens = picker ? [{ label: 'print path', run: () => openSelected() }]
        : c.isApp || c.isUrl ? [{ label: c.isUrl ? 'open in browser' : 'launch', run: () => openSelected() }]
        : appChoices.map(a => ({ label: `open in ${a.label}`, run: () => openSelected(a.key) }));
      return [
        ...opens,
        { label: 'edit', run: ctrl('e') },
        { label: c.pinned ? 'unpin' : 'pin', run: ctrl('p') },
        c.path && { label: c.isUrl ? 'copy url' : 'copy path', run: ctrl('y') },
        { label: 'archive', run: () => askArchive(false) },
      ].filter(Boolean);
    };
    const runMenu = (item) => {
      item.run();
      if (!closed) redraw();
    };

    const startAction = (name, buffer = prefill(name, filteredChoices[selectedIndex]), who = null) => {
      action = name;
      inputBuffer = buffer;
      inputCursor = inputBuffer.length;
      inputName = who;
      mode = 'input';
    };

    // ── Edit form (^e) ──
    const formEntry = () => {
      const all = form.ws ? loadWorkspaces() : loadLinks();
      const e = Object.hasOwn(all, form.name) ? all[form.name] : null;
      return form.ws && e ? (Array.isArray(e) ? e : []) : e;
    };
    const fieldNow = () => formRows({ ws: form.ws, entry: formEntry() })[form.field];
    const openForm = (name, ws = false, field = 'name') => {
      form = { name, ws, field: 0, editing: false, buffer: '', cursor: 0, kind: null, history: [] };
      form.field = Math.max(0, formRows({ ws, entry: formEntry() }).indexOf(field));
      mode = 'form';
    };
    const editField = (text) => {
      Object.assign(form, { editing: true, buffer: text, cursor: text.length });
    };
    const closeForm = () => {
      const { name, ws } = form;
      form = null;
      mode = 'browse';
      rebuild(ws ? null : name, ws ? name : null);
      // A new type can move it to the other tab.
      const c = !ws && allChoices.find(x => x.name === name);
      const to = c && (c.isApp || c.isUrl ? 'apps' : 'shortcuts');
      if (c && view !== to && view !== 'workspaces' && shownTabs(settings.views).includes(to)) {
        switchTo(to);
        reselect(name);
      }
    };
    // Saves the form's shortcut as `next`; an unchanged one makes no save (and no backup for ^z).
    const saveShortcut = (next, msg) => {
      const cur = formEntry();
      if (JSON.stringify(next) === JSON.stringify(cur)) return;
      setLink(form.name, next);
      form.history.push(form.name);
      rebuild(form.name);
      done(msg);
    };
    // Saves all workspaces, the form's one now under `name`; ^z puts the old set back.
    const saveWs = (all, name, msg) => {
      const before = loadWorkspaces();
      if (JSON.stringify(all) === JSON.stringify(before)) return;
      form.history.push({ name: form.name, all: before });
      saveWorkspaces(all);
      form.name = name;
      rebuild(null, name);
      done(msg);
    };
    // A store message as a flash: no capital, no full stop.
    const nameFlash = msg => { flash = msg.replace(/\.$/, '').replace(/^./, c => c.toLowerCase()); return false; };

    // Enter while typing in a field: true when saved (or unchanged), false + flash when not.
    const commitField = () => {
      const buf = form.buffer.trim();
      const f = fieldNow();
      if (form.ws) {
        const all = loadWorkspaces();
        if (f === 'name') {
          if (buf === form.name) return true;
          const bad = nameError(buf) || (Object.hasOwn(all, buf) && `Workspace "${buf}" already exists.`);
          if (bad) return nameFlash(bad);
          // Rebuilt so it keeps its place.
          saveWs(Object.fromEntries(Object.entries(all).map(([k, v]) => [k === form.name ? buf : k, v])), buf, `renamed to "${buf}"`);
          return true;
        }
        const list = [...formEntry()];
        list[f] = setField(list[f], 'start', buf);
        saveWs({ ...all, [form.name]: list }, form.name, buf ? `"${list[f].shortcut}" starts ${buf}` : 'start command removed');
        return true;
      }
      const links = loadLinks();
      const cur = formEntry();
      if (f === 'name') {
        if (buf === form.name) return true;
        const bad = nameError(buf);
        if (bad) return nameFlash(bad);
        const r = renameLink(form.name, buf);
        if (!r.ok) return nameFlash(r.message || 'not found');
        if (marks.delete(form.name)) marks.add(buf);
        form.history.push(form.name);
        form.name = buf;
        rebuild(buf);
        done(`renamed to "${buf}"`);
        return true;
      }
      if (f === 'target') {
        const kind = form.kind || kindOf(cur);
        const t = kind === 'folder' ? (buf ? path.resolve(expandHome(buf)) : process.cwd()) : buf;
        if (kind === 'folder' && !fs.existsSync(t)) return nameFlash('path not found');
        if (!t) return nameFlash(`${KIND_NAMES[kind]} can't be empty`);
        const next = form.kind ? retyped(cur, kind, t) : { ...cur, [KIND_FIELD[kind]]: t };
        form.kind = null;
        saveShortcut(next, `target saved${kindOf(cur) !== kind ? `, now ${KIND_NAMES[kind]}` : ''}`);
        return true;
      }
      if (f === 'aliases') {
        const r = checkAliases(links, form.name, fieldWords(buf));
        if (r.error) return nameFlash(r.error);
        saveShortcut(setField(cur, 'aliases', r.aliases), 'aliases saved');
        return true;
      }
      if (f === 'tags') saveShortcut(setField(cur, 'tags', fieldWords(buf)), 'tags saved');
      if (f === 'note') saveShortcut(setField(cur, 'note', oneLine(buf)), 'note saved');
      if (f === 'color') {
        const r = parseColor(buf);
        if (r.error) return nameFlash(r.error);
        saveShortcut(setField(cur, 'color', r.color), r.color ? `color ${r.color}` : 'color removed');
      }
      return true;
    };

    // ←→ on a choice row: type (picked, saved with its target), opener or expiry (saved now).
    const cycleField = (d) => {
      const f = fieldNow();
      const cur = formEntry();
      const step = (list, at) => list[(at + d + list.length) % list.length];
      if (form.ws) {
        if (f === 'name') return;
        const keys = openerOptions(appChoices).map(([k]) => k);
        const list = [...cur];
        const app = step(keys, Math.max(0, keys.indexOf(list[f].app || '')));
        list[f] = setField(list[f], 'app', app);
        saveWs({ ...loadWorkspaces(), [form.name]: list }, form.name, `"${list[f].shortcut}" opens in ${app ? appMap[app]?.displayName || app : 'its default'}`);
      } else if (f === 'type') {
        const k = step(KINDS, KINDS.indexOf(form.kind || kindOf(cur)));
        form.kind = k === kindOf(cur) ? null : k;
      } else if (f === 'opener') {
        const keys = openerOptions(appChoices).map(([k]) => k);
        const key = step(keys, Math.max(0, keys.indexOf(cur.opener || '')));
        saveShortcut(setField(cur, 'opener', key), key ? `opens in ${appMap[key]?.displayName || key}` : 'opens in the default opener');
      } else if (f === 'color') {
        const c = stepColor(colorOf(cur), d);
        saveShortcut(setField(cur, 'color', c), c ? `color ${c}` : 'color removed');
      } else if (f === 'expires') {
        const { labels, at } = expiryOptions(cur);
        const pick = EXPIRES[(at + d + labels.length) % labels.length];
        saveShortcut(setField(cur, 'expires', pick !== 'never' && Date.now() + parseDuration(pick)), pick === 'never' ? 'never expires' : `expires in ${pick}`);
      }
    };

    const handleForm = (str, key) => {
      // Gone (the redraw closes the form) or shorter since the last key: upex ui or another upex changed it.
      if (!formEntry()) return;
      const n = formRows({ ws: form.ws, entry: formEntry() }).length;
      form.field = clamp(form.field, n);
      const f = fieldNow();
      if (form.editing) {
        if (key.name === 'escape') {
          form.editing = false;
          // Esc on the new target keeps the old type.
          if (form.kind) { form.kind = null; form.field = formRows({ entry: formEntry() }).indexOf('type'); }
        } else if (key.name === 'return') {
          if (commitField()) form.editing = false;
        } else if (key.name === 'tab' && f === 'tags') {
          const known = [...new Set(allChoices.flatMap(c => c.tags))];
          editField(completeTag(form.buffer, known));
        } else {
          const edit = editLine({ text: form.buffer, cur: form.cursor }, str, key);
          if (edit) ({ text: form.buffer, cur: form.cursor } = edit);
        }
        return;
      }
      if (key.name === 'escape') {
        if (form.kind) form.kind = null;
        else closeForm();
      } else if (key.name === 'up' || key.name === 'down') {
        form.kind = null;
        form.field = (form.field + (key.name === 'up' ? n - 1 : 1)) % n;
      } else if (key.name === 'left' || key.name === 'right') {
        cycleField(key.name === 'left' ? -1 : 1);
      } else if (key.name === 'return') {
        const cur = formEntry();
        if (form.ws) editField(f === 'name' ? form.name : cur[f].start || '');
        else if (f === 'type' && form.kind) {
          // app <-> command keep the line; a folder path, URL or command won't fit another type.
          const keep = ['app', 'cmd'].includes(form.kind) && ['app', 'cmd'].includes(kindOf(cur));
          form.field = formRows({ entry: cur }).indexOf('target');
          editField(keep ? targetOf(cur) : '');
        } else if (isTextRow(f)) {
          editField(f === 'name' ? form.name : f === 'target' ? targetOf(cur) : f === 'tags' ? (cur.tags || []).join(' ')
            : f === 'aliases' ? aliasesOf(cur).join(' ') : f === 'color' ? colorOf(cur) : oneLine(cur.note));
        }
      } else if (key.ctrl && key.name === 'd' && form.ws && f !== 'name') {
        const list = formEntry().filter((_, i) => i !== f);
        saveWs({ ...loadWorkspaces(), [form.name]: list }, form.name, `removed "${formEntry()[f].shortcut}" (^z undo)`);
        form.field = Math.min(form.field, list.length);
      } else if (key.ctrl && key.name === 'z') {
        const last = form.history.pop();
        if (last === undefined) flash = 'nothing to undo here';
        else if (form.ws) { saveWorkspaces(last.all); form.name = last.name; rebuild(null, last.name); done('undone'); }
        else if (!undoLast()) flash = 'no backup left to undo';
        else { form.name = last; rebuild(last); done('undone'); }
        // Same row again: an undone type change adds or drops the opener row.
        if (formEntry()) form.field = Math.max(0, formRows({ ws: form.ws, entry: formEntry() }).indexOf(f));
      }
    };

    // Commit the pending input action; returns false + sets flash on validation error.
    const commitInput = (target) => {
      const buf = inputBuffer.trim();

      if (action === 'add') {
        const bad = nameError(buf);
        if (bad) { flash = bad.toLowerCase().replace(/\.$/, ''); return false; }
        const taken = takenError(loadLinks(), buf);
        if (taken) { flash = taken.replace(/\.$/, ''); return false; }
        setLink(buf, { path: inputName || process.cwd(), added: Date.now() });
        rebuild(buf);
        done(`added "${buf}"`);
        // Straight on to its type, target, tags and the rest.
        openForm(buf, false, 'target');
        return true;
      }

      if (action === 'wsadd') {
        const all = loadWorkspaces();
        const old = Object.hasOwn(all, buf);
        const bad = !old && nameError(buf);
        if (bad) return nameFlash(bad);
        // A picked opener goes with folders; else each opens in its own when the workspace opens.
        const add = markedPlan().map(({ c, app, count }) => ({ shortcut: c.name, ...(appPicked && app && { app }), ...(count > 1 && { count }) }));
        saveWorkspaces({ ...all, [buf]: [...(old ? all[buf] : []), ...add] });
        marks.clear();
        rebuild(null, buf);
        done(old ? `added ${add.length} to "${buf}"` : `created "${buf}", ^e edits it`);
        return true;
      }

      if (action === 'opener' || action === 'openerCmd') {
        const r = applyOpener(configApps(), { name: inputName, command: buf }, action === 'openerCmd');
        if (r.error) return nameFlash(r.error);
        saveConfig({ ...loadConfig(), apps: r.apps });
        reloadOpeners();
        done(`${action === 'opener' ? 'saved' : 'added'} opener "${inputName}"`);
        return true;
      }

      if (action === 'openerName') {
        // Checks the name alone; the command comes next.
        const r = applyOpener(configApps(), { name: buf, command: '-' }, true);
        if (r.error) return nameFlash(r.error);
        startAction('openerCmd', '', buf);
        return false;
      }

      if (action === 'export' || action === 'import') {
        if (!buf) return nameFlash('type a file path');
        const file = path.resolve(expandHome(buf));
        try {
          if (action === 'export') {
            const bundle = bundleOf();
            fs.writeFileSync(file, JSON.stringify(bundle, null, 2), 'utf-8');
            done(`exported ${Object.keys(bundle.links).length} shortcuts to ${tidyPath(file)}`);
            return true;
          }
          const r = importBundle(JSON.parse(fs.readFileSync(file, 'utf-8')));
          if (r.error) return nameFlash(r.error);
          // The bundle's config can bring other settings too.
          settings = readSettings();
          rebuild();
          reloadOpeners();
          done(`imported: ${r.added.length} added, ${r.updated.length} updated${r.clashes.length ? `, names used twice: ${r.clashes.join('; ')}` : ''}`);
          return true;
        } catch (err) {
          // A store error must not pass as a bad file.
          if (err instanceof StoreError) throw err;
          flash = `can't ${action}: ${err.message.split('\n')[0]}`;
          return false;
        }
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
      // Before refreshSettings, which counts the rows this filter leaves.
      query = '';
      if (to === 'settings') {
        backView = view;
        settings = readSettings();
        expanded = null;
        // The pane split row or archived ones may have gone since last time.
        refreshSettings();
        wt = hasWindowsTerminal();
      }
      view = to;
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
      if (row.key === 'mouse' && alt) stdout.write(next === 'on' ? MOUSE_ON : MOUSE_OFF);
      if (row.key === 'staleAfter') refreshSettings();
      // Without a terminal app (Linux over SSH), only 'here' offers terminal openers.
      if (row.key === 'terminalLayout') reloadOpeners();
    };

    const clamp = (i, n) => Math.max(0, Math.min(i, n - 1));
    // Settings rows plus the openers, maintenance and archived shortcuts under them, as the filter leaves them.
    const settingList = () => settingsList(settings, query, extras, archived, wt);
    const settingItems = () => { const { rows, more } = settingList(); return [...rows, ...more]; };
    const settingCount = () => settingItems().length;
    // The picked row past the settings ({ kind, name }), or null.
    const extraAt = () => settingItems()[settingIndex]?.kind ? settingItems()[settingIndex] : null;
    // A new Settings filter or setting keeps the picked row when it still shows, else picks the first.
    const keepPicked = (change) => {
      const id = itemId(settingItems()[settingIndex]);
      change();
      settingIndex = Math.max(0, settingItems().findIndex(x => itemId(x) === id));
    };
    const filterSettings = (q) => keepPicked(() => { query = q; });
    const staleDays = () => Number(settings.staleAfter);
    // Maintenance rows with their counts now; doctor keeps its last result.
    let doctorSummary = '';
    let checking = false;
    const updateRow = () => {
      if (checking) return chalk.dim('checking npm…');
      const latest = cachedLatest();
      return isNewer(latest, VERSION) ? chalk.yellow(updateText(latest)) : chalk.dim(`v${VERSION}, Enter checks npm`);
    };
    const buildExtras = () => {
      const links = loadLinks();
      const broken = pruneBroken(links).removed;
      const stale = staleLinks(links, staleDays());
      const top = statsFrom(loadHistory(), { since: Date.now() - 30 * 86400000 }).shortcuts.slice(0, 3);
      const row = (section, kind, name, text) => ({ section, kind, name, text });
      return [
        ...Object.entries(configApps()).map(([name, command]) => row('Openers', 'opener', name, chalk.dim(String(command)))),
        row('Openers', 'newOpener', '+ add opener', ''),
        row('Maintenance', 'broken', 'Broken paths', broken.length ? chalk.yellow(`${broken.length} missing: ${broken.join(' ')}`) : chalk.dim('none')),
        row('Maintenance', 'stale', 'Stale', stale.length ? chalk.yellow(`${stale.length} not opened in ${staleDays()}+ days`) : chalk.dim('none')),
        row('Maintenance', 'stats', 'Stats', top.length ? top.map(([n, c]) => `${n} ${chalk.dim(c)}`).join(chalk.dim(' · ')) : chalk.dim('no opens in 30 days')),
        row('Maintenance', 'doctor', 'Doctor', doctorSummary || chalk.dim('store, openers, shell setup')),
        row('Maintenance', 'update', 'Updates', updateRow()),
        row('Maintenance', 'export', 'Export', chalk.dim('shortcuts and settings to a file')),
        row('Maintenance', 'import', 'Import', chalk.dim('from an exported file')),
      ];
    };
    const refreshSettings = () => {
      archived = archivedList(loadLinks());
      extras = buildExtras();
      settingIndex = clamp(settingIndex, settingCount());
    };
    // After a custom opener changed: the opener row and Settings again, the picked opener kept.
    const reloadOpeners = () => {
      const key = appChoices[selectedAppIndex]?.key;
      fallback = defaultOpener();
      loadApps();
      selectedAppIndex = Math.max(0, appIndex(key));
      if (view === 'settings') refreshSettings();
    };
    // Enter / a second click on an archived row in Settings.
    const restore = () => {
      const a = extraAt();
      const entry = a?.kind === 'archived' && loadLinks()[a.name];
      if (!entry?.archived) return;
      setLink(a.name, unarchived(entry));
      rebuild();
      refreshSettings();
      done(`restored "${a.name}"`);
    };
    const confirmAsk = (what, q) => { mode = 'confirm'; action = what; ask = q; };
    // Opens `entries` with `run`, after y / n when they'd open more windows than Confirm many.
    const openMany = (entries, run) => {
      const n = entries.reduce((t, e) => t + (e.count || 1), 0);
      if (picker || !asksMany(n, settings.confirmMany)) { run(); return; }
      pending = run;
      confirmAsk('openMany', `open ${n} windows at once?`);
      redraw();
    };
    // Enter on an opener, maintenance or archived row.
    const runExtra = (x) => {
      const toggle = (lines) => { expanded = expanded?.kind === x.kind ? null : { kind: x.kind, lines }; };
      if (x.kind === 'archived') restore();
      else if (x.kind === 'opener') startAction('opener', String(configApps()[x.name] ?? ''), x.name);
      else if (x.kind === 'newOpener') startAction('openerName', '');
      else if (x.kind === 'export') startAction('export', tidyPath(path.join(HOME, 'upex-export.json')));
      else if (x.kind === 'import') startAction('import', '');
      else if (x.kind === 'update') {
        if (checking) return;
        // A newer one already found: close and install it.
        if (isNewer(cachedLatest(), VERSION)) { finish({ status: 'update' }); return; }
        checking = true;
        extras = buildExtras();
        const end = guard((text, ok) => {
          checking = false;
          if (closed) return;
          if (view === 'settings') extras = buildExtras();
          if (ok) done(text); else flash = text;
          redraw();
        });
        fetchLatest().then(v => end(updateText(v), !isNewer(v, VERSION)), err => end(`can't reach npm: ${err.message}`, false));
      }
      else if (x.kind === 'broken') {
        const n = pruneBroken(loadLinks()).removed.length;
        if (!n) done('no broken paths');
        else confirmAsk('prune', `remove ${n} broken shortcut${n > 1 ? 's' : ''}?`);
      } else if (x.kind === 'stale') {
        const n = staleLinks(loadLinks(), staleDays()).length;
        if (!n) done(`all opened in the last ${staleDays()} days`);
        else confirmAsk('stale', `archive ${n} not opened in ${staleDays()}+ days?`);
      } else if (x.kind === 'stats') toggle(statLines(appMap));
      else if (x.kind === 'doctor') {
        if (expanded?.kind === 'doctor') { expanded = null; return; }
        const rows = runChecks();
        const n = s => rows.filter(r => r[0] === s).length;
        doctorSummary = [chalk.green(`${n('ok')} ok`), n('warn') && chalk.yellow(`${n('warn')} warn`), n('fail') && chalk.red(`${n('fail')} fail`)].filter(Boolean).join(chalk.dim(' · '));
        extras = buildExtras();
        toggle(doctorLines(rows));
      }
    };

    // Enter on the selected row, in the picked opener or `picked` (the right-click menu's "open in").
    const openSelected = (picked = appChoices[selectedAppIndex]?.key) => {
      const selected = filteredChoices[selectedIndex];
      if (!selected) return;
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

      const appKey = direct ? null : picked || fallback;
      const count = isTerminalApp(appKey) ? cmdCount : 1;
      // Terminal tabs open beside the selector, so it stays either way.
      const tab = tabsOn(selected.isCmd ? 'cmd' : appKey);
      const n = selected.isCmd ? 1 : count;
      if (tab || stay(selected.isCmd ? 'cmd' : appKey, n)) {
        const where = tab ? (n > 1 ? `${n} new tabs` : 'a new tab') : appKey && (appMap[appKey]?.displayName || appKey);
        openHere([{ shortcut: selected.name, app: appKey, count: n }], `opened "${selected.name}"${where ? ` in ${where}` : ''}`, [selected.name]);
        return;
      }
      finish({ status: 'selected', name: selected.name, app: appKey, count });
    };

    // Enter or a click on a no-matches offer: add the typed name here, or show matching archived ones in Settings.
    const runOffer = (o) => {
      if (o?.kind === 'add') {
        startAction('add', o.name);
        // A bad name stays in the prompt to fix.
        if (commitInput() && mode === 'input') mode = 'browse';
      } else if (o?.kind === 'archived') {
        const q = query;
        switchTo('settings');
        query = q;
        settingIndex = Math.max(0, settingItems().findIndex(x => x.kind === 'archived'));
      }
      redraw();
    };

    // Mouse is only on in full screen; ignored while typing or confirming.
    // Presses are skipped: the second press of a double-click must not wipe the first one's flash.
    const handleMouse = ({ x, y, wheel, click, right }) => {
      const picking = mode === 'scripts';
      const goalPick = mode === 'goals';
      if (!alt || (mode !== 'browse' && !picking && !goalPick) || !(wheel || click || right)) return;
      // The key overlay: a click closes it, the wheel does nothing.
      if (keysHelp) {
        if (click || right) { keysHelp = false; redraw(); }
        return;
      }
      // Right-click menu: a click on an item runs it, any other click closes it; a right-click elsewhere reopens it there.
      if (menu) {
        if (wheel) return;
        const t = hitTest(targets, x, y);
        const item = click && t?.menu != null && menu.items[t.menu];
        menu = null;
        if (click) {
          flash = '';
          if (item) runMenu(item);
          else redraw();
          // Either way, a double-click's second half must not act on the row under it.
          lastClick = { y, at: Date.now(), opened: true };
          return;
        }
      }
      if (right) {
        const t = hitTest(targets, x, y);
        if (mode !== 'browse' || view === 'settings' || t?.row == null) { redraw(); return; }
        flash = '';
        if (view === 'workspaces') wsIndex = t.row;
        else selectedIndex = t.row;
        menu = { items: menuItems(), index: 0, line: y - 1, col: x - 1 };
        redraw();
        return;
      }
      if (wheel) {
        flash = '';
        if (picking) scriptIndex = clamp(scriptIndex + wheel, scripts.list.length);
        else if (goalPick) goalIndex = clamp(goalIndex + wheel, paneGoals()?.next.length || 1);
        else if (view === 'settings') settingIndex = clamp(settingIndex + wheel, settingCount());
        else if (view === 'workspaces') wsIndex = clamp(wsIndex + wheel, filteredWs.length);
        else selectedIndex = clamp(selectedIndex + wheel, filteredChoices.length);
        redraw();
        return;
      }
      const t = hitTest(targets, x, y);
      const ws = view === 'workspaces';
      // Archived rows in Settings click like list rows.
      const arc = t?.setting >= settingList().rows.length;
      // The web, copy and archive lines act on any click, so a double-click must not act twice.
      const once = !!(t?.web || t?.copy || t?.archive);
      const now = Date.now();
      const act = (t?.row != null || once || arc) && rowClick(lastClick, y, now, once || (arc ? t.setting === settingIndex : t.row === (picking ? scriptIndex : ws ? wsIndex : selectedIndex)));
      // Second half of a double-click that already opened, also when its row went (restored): keep its flash.
      if (rowClick(lastClick, y, now) === 'skip') return;
      // Any click dismisses the flash, an empty spot included, and leaves the goal picker.
      flash = '';
      if (goalPick) mode = 'browse';
      if (t?.tab) {
        mode = 'browse';
        if (t.tab !== view) switchTo(t.tab);
      } else if (t?.offer != null) {
        lastClick = { y, at: now, opened: true };
        runOffer(offers[t.offer]);
        return;
      } else if (t?.suggest) {
        handleKey(undefined, { ctrl: true, name: 'n' });
        return;
      } else if (once) {
        if (t.web) openWeb();
        else if (t.archive) askArchive();
        else copy(t.copy, t.msg);
        lastClick = { y, at: Date.now(), opened: true };
      } else if (act) {
        if (arc) settingIndex = t.setting;
        if (act === 'open') handleKey(undefined, { name: 'return' });
        else if (act === 'select' && picking) scriptIndex = t.row;
        else if (act === 'select' && ws) wsIndex = t.row;
        else if (act === 'select' && !arc) selectedIndex = t.row;
        // Stamped after opening: a tab launch blocks and the second click queues behind it.
        lastClick = { y, at: Date.now(), opened: act === 'open' };
        if (act === 'open') return;
      } else if (t?.opener != null) {
        appPicked = true;
        selectedAppIndex = t.opener;
      } else if (t?.setting != null) {
        settingIndex = t.setting;
        const row = settingList().rows[t.setting];
        if (t.option != null) keepPicked(() => chooseSetting(row, rowOptions(row, appChoices, settings)[t.option][0]));
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
      if (keysHelp) {
        keysHelp = false;
        redraw();
        return;
      }
      // Right-click menu: ↑↓ move, Enter runs, any other key closes it.
      if (menu) {
        const n = menu.items.length;
        if (key.name === 'up' || key.name === 'down') {
          menu.index = (menu.index + (key.name === 'up' ? n - 1 : 1)) % n;
          redraw();
          return;
        }
        const item = key.name === 'return' && menu.items[menu.index];
        menu = null;
        if (item) runMenu(item);
        else redraw();
        return;
      }

      // ── Confirm mode ──
      if (mode === 'confirm') {
        const yes = key.name === 'y';
        if (action === 'openMany') {
          const run = yes && pending;
          pending = null;
          ask = '';
          mode = 'browse';
          if (run) run();
          if (!closed) redraw();
          return;
        }
        if (yes && action === 'prune') {
          const before = loadLinks();
          const { kept, removed } = pruneBroken(before);
          saveLinks(kept);
          rebuild();
          done(removed.length ? `removed ${howMany(removed)} (^z undo)` : 'no broken paths');
        } else if (yes && action === 'stale') {
          const links = loadLinks();
          const gone = staleLinks(links, staleDays()).map(({ name }) => name);
          for (const name of gone) links[name] = { ...links[name], archived: true };
          saveLinks(links);
          rebuild();
          done(gone.length ? `archived ${howMany(gone)} (^z undo)` : 'nothing stale');
        } else if (yes && action === 'deleteArchived') {
          // ^z puts it back, still archived.
          const gone = Object.keys(removeLinks([inputName])).length;
          rebuild();
          done(gone ? `deleted "${inputName}" (^z undo)` : `"${inputName}" is gone already`);
        } else if (yes && action === 'removeOpener') {
          const { [inputName]: _gone, ...apps } = configApps();
          saveConfig({ ...loadConfig(), apps });
          reloadOpeners();
          done(`removed opener "${inputName}"`);
        }
        if (ask) {
          ask = '';
          if (view === 'settings') refreshSettings();
          mode = 'browse';
          redraw();
          return;
        }
        if (yes && action?.startsWith('archive')) {
          archive();
        } else if (yes && view === 'workspaces') {
          const victim = filteredWs[wsIndex];
          const entry = victim && loadWorkspaces()[victim.name];
          if (entry) {
            removeWorkspace(victim.name);
            wsUndo.push({ name: victim.name, entry });
            done(`deleted workspace "${victim.name}" (^z undo)`);
          }
          rebuild();
        }
        mode = 'browse';
        redraw();
        return;
      }

      // ── Inline input mode (add, rename, workspace, opener, export / import) ──
      if (mode === 'input') {
        const target = filteredChoices[selectedIndex]?.name;

        if (key.name === 'escape') {
          mode = 'browse';
          redraw();
          return;
        }
        if (key.name === 'return') {
          // An add goes on to the edit form, an opener name to its command.
          if (commitInput(target) && mode === 'input') mode = 'browse';
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

      // ── Edit form (the pane when wide, else the list) ──
      if (mode === 'form') {
        handleForm(str, key);
        redraw();
        return;
      }

      // ── Browse mode ──
      // F2 and Del: Windows aliases for ^r rename and ^x archive (^d where that deletes).
      if (!key.ctrl && !key.meta && (key.name === 'f2' || key.name === 'delete')) {
        handleKey(str, { ctrl: true, name: key.name === 'f2' ? 'r' : view === 'workspaces' || view === 'settings' ? 'd' : 'x' });
        return;
      }
      // Esc clears a typed filter first, then the marks, then closes a Shift+Right pane, then quits.
      if (key.name === 'escape' && query) {
        if (view === 'settings') filterSettings('');
        else clearQuery();
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

      // ^z: deleted workspaces first, else one step back through the links.json backups, like upex undo.
      if (key.ctrl && key.name === 'z') {
        const ws = wsUndo.pop();
        const r = !ws && undoLast();
        if (ws && Object.hasOwn(loadWorkspaces(), ws.name)) {
          flash = `can't undo, workspace "${ws.name}" exists again`;
        } else if (ws) {
          saveWorkspaces({ ...loadWorkspaces(), [ws.name]: ws.entry });
          rebuild(null, ws.name);
          done(`restored workspace "${ws.name}"`);
        } else if (r) {
          // Archived ones have no row to select.
          const links = loadLinks();
          rebuild([...r.added, ...r.changed].find(n => !links[n]?.archived));
          if (view === 'settings') refreshSettings();
          done(undoFlash(r));
        } else {
          canUndo = false;
          flash = 'nothing to undo';
        }
        redraw();
        return;
      }

      // ? with an empty filter (else it types), or ^k.
      if (((key.ctrl && key.name === 'k') || (str === '?' && !query)) && mode === 'browse' && view !== 'settings') {
        keysHelp = true;
        redraw();
        return;
      }

      // 1 to 9 opens that visible row: with an empty filter (else it types), Alt+digit always.
      if (settings.numberKeys === 'on' && /^[1-9]$/.test(key.name || '') && !key.ctrl && (!query || isAlt(key)) && view !== 'settings') {
        const row = [...new Set(targets.map(t => t.row).filter(x => x != null))][key.name - 1];
        if (row == null) return;
        if (view === 'workspaces') { wsIndex = row; handleKey(undefined, { name: 'return' }); }
        else { selectedIndex = row; openSelected(); }
        return;
      }

      // A page = the rows the last frame showed.
      const jump = (i, n) => jumpIndex(key.name, i, n, new Set(targets.map(t => t.row ?? t.setting).filter(x => x != null)).size);

      // Settings: Up/Down picks a row, Left/Right changes and saves it, Enter acts on an opener, maintenance or archived row,
      // ^d removes a custom opener or deletes an archived shortcut; typing filters the rows.
      if (view === 'settings') {
        const { rows } = settingList();
        const x = extraAt();
        const j = jump(settingIndex, settingCount());
        if (j != null) {
          settingIndex = j;
        } else if ((key.name === 'up' || key.name === 'down') && settingCount()) {
          const n = settingCount();
          settingIndex = (settingIndex + (key.name === 'up' ? n - 1 : 1)) % n;
        } else if (key.name === 'return' && x) {
          runExtra(x);
        } else if (key.ctrl && key.name === 'd' && x?.kind === 'opener') {
          inputName = x.name;
          confirmAsk('removeOpener', `remove opener "${x.name}"?`);
        } else if (key.ctrl && key.name === 'd' && x?.kind === 'archived') {
          inputName = x.name;
          confirmAsk('deleteArchived', `delete "${x.name}" for good?`);
        } else if ((key.name === 'left' || key.name === 'right') && settingIndex < rows.length) {
          // A change can show or hide rows above it (pane split, a filtered note), so the row is kept by key.
          const row = rows[settingIndex];
          const keys = rowOptions(row, appChoices, settings).map(([k]) => k);
          const at = Math.max(0, keys.indexOf(pickedOf(row, settings)));
          keepPicked(() => chooseSetting(row, keys[(at + (key.name === 'left' ? keys.length - 1 : 1)) % keys.length]));
        } else if (!key.ctrl || key.name === 'w' || key.name === 'backspace') {
          const edit = !['left', 'right', 'delete', 'return', 'tab'].includes(key.name) && editLine({ text: query, cur: query.length }, str, key);
          if (edit && edit.text !== query) filterSettings(edit.text);
        }
        redraw();
        return;
      }

      if (view === 'workspaces') {
        const n = filteredWs.length;
        if (key.ctrl && key.name === 'd') {
          if (n > 0) { mode = 'confirm'; action = 'delete'; redraw(); }
          return;
        }
        // ^a: the marked shortcuts into a new or existing workspace; ^e edits the selected one.
        if (key.ctrl && key.name === 'a') {
          if (!marks.size) flash = 'mark shortcuts with space first (Shortcuts or Apps tab)';
          else startAction('wsadd', '', marks.size);
          redraw();
          return;
        }
        if (key.ctrl && key.name === 'e') {
          if (filteredWs[wsIndex]) openForm(filteredWs[wsIndex].name, true);
          redraw();
          return;
        }
        if (key.name === 'return') {
          const name = filteredWs[wsIndex]?.name;
          if (!name) return;
          const entries = loadWorkspaces()[name] || [];
          openMany(entries, () => {
            if (staying()) openHere(entries, `opened workspace "${name}"`, [null, name]);
            else finish({ status: 'workspace', name });
          });
          return;
        }
        const j = jump(wsIndex, n);
        if (j != null || ((key.name === 'up' || key.name === 'down') && n > 0)) {
          wsIndex = j ?? (wsIndex + (key.name === 'up' ? n - 1 : 1)) % n;
          redraw();
          return;
        }
        // Shortcut-only keys (^A/^E/^R, Left/Right) do nothing here, nor moves on an empty list.
        if ((key.ctrl && key.name !== 'w') || ['left', 'right', 'up', 'down', 'pageup', 'pagedown', 'home', 'end'].includes(key.name)) return;
      }

      // ^o: the next sort, saved like Settings > Sort.
      if (key.ctrl && key.name === 'o') {
        const sorts = settingValues('sort');
        const next = sorts[(sorts.indexOf(settings.sort) + 1) % sorts.length];
        const c = filteredChoices[selectedIndex];
        const row = SETTING_ROWS.find(r => r.key === 'sort');
        chooseSetting(row, next);
        reselect(c?.name, null, c);
        done(`sort: ${row.names[next]}`);
        redraw();
        return;
      }

      if (key.ctrl && key.name === 's') {
        openScripts();
        redraw();
        return;
      }

      // The suggested learned folder: ^n adds it (name prefilled, like ^a from the clipboard), ^l stops offering it.
      if (key.ctrl && (key.name === 'n' || key.name === 'l')) {
        if (!tipShown()) return;
        if (key.name === 'n') startAction('add', defaultName(suggest.path), suggest.path);
        else {
          hideVisit(suggest.path);
          done(`won't suggest "${suggest.name}" again (upex learned still lists it)`);
          suggest = topSuggestion();
        }
        redraw();
        return;
      }

      // Live actions (Ctrl+key so they never clash with search typing).
      // ^A adds the cwd as a folder shortcut, so it belongs to the Shortcuts tab.
      if (key.ctrl && key.name === 'a') {
        if (view !== 'shortcuts') return;
        startAction('add');
        redraw();
        // An existing path on the clipboard becomes its path, named after it, unless a name is typed meanwhile.
        readClipboard().then(guard((text) => {
          const p = clipPath(text);
          if (!p || closed || mode !== 'input' || action !== 'add' || inputBuffer) return;
          startAction('add', defaultName(p), p);
          redraw();
        }));
        return;
      }
      if (key.ctrl && key.name === 'e') {
        const target = filteredChoices[selectedIndex];
        // A missing folder opens on its path, to fix it.
        if (target) { openForm(target.name, false, target.exists === false ? 'target' : 'name'); redraw(); }
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
      if (key.ctrl && key.name === 'x') {
        askArchive(true);
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
          const order = movePinned(allChoices.filter(x => x.pinned), c.name, key.name === 'up' ? -1 : 1, x => inView(view)(x) && sameGroup(c)(x));
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

      // No matches: Enter runs the picked offer (its key hint), also with marks.
      if (key.name === 'return' && !filteredChoices.length && offers.length) {
        runOffer(offers[offerIndex]);
        return;
      }
      if (key.name === 'return' && marks.size) {
        const entries = markedPlan().map(({ c, app, count }) => ({ shortcut: c.name, app, count }));
        openMany(entries, () => {
          marks.clear();
          if (staying()) openHere(entries, `opened ${howMany(entries.map(e => e.shortcut))}`, [filteredChoices[selectedIndex]?.name]);
          else finish({ status: 'marked', entries });
        });
        return;
      }

      if (key.name === 'return') {
        openSelected();
        return;
      }
      if ((key.name === 'up' || key.name === 'down') && !key.ctrl && !key.shift && !filteredChoices.length && offers.length > 1) {
        offerIndex = (offerIndex + 1) % offers.length;
        redraw();
        return;
      }

      const j = jump(selectedIndex, filteredChoices.length);
      if (j != null) {
        selectedIndex = j;
        redraw();
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
    // Live reload: links.json or config.json (workspaces) changed, by upex ui, another shell or a save here.
    // Waits for browse mode, so a confirm or form never acts on a row that moved; a broken file keeps the old rows.
    let reloadDue = false;
    const liveReload = () => {
      if (closed) return;
      if (mode !== 'browse' || menu) { reloadDue = true; return; }
      reloadDue = false;
      // The picked offer and Settings row stay picked when rows move.
      const offerKey = offers[offerIndex]?.key;
      const settingId = view === 'settings' && itemId(settingItems()[settingIndex]);
      try {
        rebuild(filteredChoices[selectedIndex]?.name, filteredWs[wsIndex]?.name);
        if (view === 'settings') refreshSettings();
      } catch { return; }
      offerIndex = Math.max(0, offers.findIndex(o => o.key === offerKey));
      const at = settingId ? settingItems().findIndex(x => itemId(x) === settingId) : -1;
      if (at >= 0) settingIndex = at;
      redraw();
    };
    try {
      // A symlinked store saves next to its target, so watch the real folders.
      const files = [LINKS_FILE, CONFIG_FILE].map(f => fs.realpathSync(f));
      const names = files.map(f => path.basename(f));
      for (const dir of new Set(files.map(f => path.dirname(f)))) {
        const w = fs.watch(dir, { persistent: false }, (_, file) => {
          if (file && !names.includes(file)) return;
          clearTimeout(reloadTimer);
          reloadTimer = setTimeout(guard(liveReload), 150);
        });
        w.on('error', () => {});
        watchers.push(w);
      }
    } catch { /* no watching: rows refresh after an edit here, like before */ }

    const onKeypress = guard((str, key) => {
      const m = readMouse(mouse, key);
      mouse = m.state;
      if (m.event) handleMouse(m.event);
      if (m.pass) handleKey(str, key);
      if (reloadDue) liveReload();
    });
    // The menu sits at screen cells, which a resize moves.
    const onResize = guard(() => { menu = null; redraw(); });

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
