/**
 * rows.js -- Selector-style rows and text helpers shared by the selector and the plain commands, without loading the selector.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import { setting } from './launcher.js';
import * as ui from './ui.js';

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
export const highlight = s => (chalk.level >= 2 ? chalk.bgAnsi256(238) : chalk.bgBlackBright)(s);
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
// Fuse hit ranges are UTF-16 offsets, inclusive.
export const underlineHits = (s, hits = []) => ui.graphemes(s)
  .map(({ segment: g, index: i }) => (hits.some(([a, b]) => a < i + g.length && b >= i) ? chalk.underline(g) : g)).join('');

// Keeps the end of a too-long string, where the folder name is.
export const clipStart = (s, n) => (vis(s) <= n ? s : n <= 1 ? '…'.slice(0, n) : `…${ui.fit(s, n - 1, true)}`);
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

// Name clipped to `width` columns with …; highlight ranges past the cut are dropped.
export function clipName(name, width, hits = []) {
  if (vis(name) <= width) return { text: name, hits };
  const cut = ui.fit(name, Math.max(0, width - 1)).length;
  return { text: `${name.slice(0, cut)}…`, hits: hits.map(([a, b]) => [a, Math.min(b, cut - 1)]).filter(([a, b]) => a <= b) };
}

// One list row (`num`: a dim 1 to 9 in the pointer column): "› ● name  path ..... #tags  badge  3d ago". `style` = path | url | dim | plain (url looks plain).
// `weight` styles the name (bold; the suggested row is plain).
// `dot` (color label) sits in a `dotWidth` column before the name, 0 = no column. `usage` goes last, dropped when it doesn't fit.
export function renderRow({ sel, mark, name, nameWidth, hits, text = '', style = 'path', middle = false, right = '', cw, pick = s => s, dot = '', dotWidth = 0, usage = '', num = '', weight = chalk.bold }) {
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
export const nameCol = list => Math.min(24, Math.max(12, ...list.map(c => vis(c.name))));

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

// goals.json is not ours: one line, control characters (escapes included) dropped.
// eslint-disable-next-line no-control-regex
export const oneLine = v => String(v ?? '').replace(/[\s\x00-\x1f\x7f-\x9f]+/g, ' ').trim();
