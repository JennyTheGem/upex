/**
 * store.js -- Persistent storage for upex shortcuts and config
 * Reads/writes ~/.upex/links.json and ~/.upex/config.json
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const UPEX_DIR = path.join(os.homedir(), '.upex');
const LINKS_FILE = path.join(UPEX_DIR, 'links.json');
const CONFIG_FILE = path.join(UPEX_DIR, 'config.json');
const BACKUP_DIR = path.join(UPEX_DIR, 'backups');
const HISTORY_FILE = path.join(UPEX_DIR, 'history.jsonl');
const KEEP_BACKUPS = 10;
const VISITS_FILE = path.join(UPEX_DIR, 'visits.json');
const KEEP_VISITS = 300;
// Visits before a learned folder is offered as a shortcut.
export const SUGGEST_AFTER = 3;

// --dry-run: launches print instead of running (launcher.js) and nothing is saved or counted as used.
export let dryRun = false;
export const setDryRun = (on = true) => { dryRun = on; };

function ensureStore() {
  if (!fs.existsSync(UPEX_DIR)) {
    fs.mkdirSync(UPEX_DIR, { recursive: true });
  }
  if (!fs.existsSync(LINKS_FILE)) {
    fs.writeFileSync(LINKS_FILE, JSON.stringify({}, null, 2), 'utf-8');
  }
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({}, null, 2), 'utf-8');
  }
}

// Thrown when a store file can't be parsed; bin/upex.js prints it instead of a stack.
export class StoreError extends Error {}

// Parse a store file. Never falls back to {}: a later save would wipe the real data.
function readJson(file) {
  ensureStore();
  let parsed;
  try {
    // Strip a BOM (PowerShell/Notepad edits add one).
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new StoreError(`Cannot read ${file}: ${err.message}\n  Fix or delete the file, nothing was changed.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StoreError(`${file} must hold a JSON object.\n  Fix or delete the file, nothing was changed.`);
  }
  return parsed;
}

// Temp file + rename, so a crash mid-write can't leave a truncated store.
function writeJson(file, data) {
  if (dryRun) return;
  ensureStore();
  // Write through a symlinked store instead of replacing the link.
  const target = fs.realpathSync(file);
  // Per-process name: a shared tmp lets two concurrent writers interleave into it.
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  // Windows can't replace a file another process has open; retry briefly.
  for (let tries = 0; ; tries++) {
    try {
      fs.renameSync(tmp, target);
      return;
    } catch (err) {
      if (tries >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

// Per field: the value, coerced when it can be, or undefined when it can't.
const isStr = v => typeof v === 'string';
const str = v => (isStr(v) ? v : Number.isFinite(v) ? String(v) : undefined);
const num = v => (Number.isFinite(v) ? v : isStr(v) && v.trim() && Number.isFinite(+v) ? +v : undefined);
const bool = v => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined);
const list = v => (isStr(v) ? [v] : !Array.isArray(v) ? undefined : v.every(isStr) ? v : v.filter(isStr));
const FIELDS = {
  path: str, app: str, url: str, opener: str, note: str, color: str,
  tags: list, aliases: list,
  uses: num, lastUsed: num, added: num, expires: num, pinOrder: num,
  archived: bool, pinned: bool, terminal: bool,
};

/**
 * A raw links.json value (legacy path string or entry object) -> { entry, issues }.
 * Wrong-typed fields are coerced or dropped; entry is null without a path, app or url.
 */
export function checkEntry(value) {
  if (isStr(value)) return { entry: { path: value }, issues: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { entry: null, issues: ['not an object'] };
  const entry = { ...value };
  const issues = [];
  for (const [field, fix] of Object.entries(FIELDS)) {
    if (!(field in entry)) continue;
    const v = entry[field];
    // null is just a cleared field.
    const fixed = v === null ? undefined : fix(v);
    if (fixed === undefined) delete entry[field];
    else entry[field] = fixed;
    if (v !== null && fixed !== v) issues.push(`${field} ${fixed === undefined ? 'dropped' : 'fixed'}`);
  }
  if (!entry.path && !entry.app && !entry.url) return { entry: null, issues: [...issues, 'no path, app or url'] };
  return { entry, issues };
}

// Field holding a shortcut's target. An app shortcut that also has a path edits the path.
export const targetField = (e) => (e.url ? 'url' : e.app && !e.path ? 'app' : 'path');

// -> { links, skipped, issues, fixed }: skipped holds the raw unusable entries, issues "name: problem" lines,
// fixed is true when a kept entry was coerced.
export function checkLinks(raw) {
  const links = {};
  const skipped = {};
  const issues = [];
  let fixed = false;
  for (const [name, value] of Object.entries(raw)) {
    const r = checkEntry(value);
    if (r.entry) links[name] = r.entry;
    else skipped[name] = value;
    if (r.issues.length) issues.push(`${name}: ${r.issues.join(', ')}${r.entry ? '' : ' (skipped)'}`);
    if (r.entry && r.issues.length) fixed = true;
  }
  return { links, skipped, issues, fixed };
}

// From the last loadLinks: skipped entries go back on save, so a bad hand edit is never lost.
let lastCheck = { skipped: {}, issues: [], fixed: false };
export const linkIssues = () => lastCheck.issues;
// `links` plus the skipped entries whose name holds no real entry in it.
const withSkipped = links => ({ ...links, ...Object.fromEntries(Object.entries(lastCheck.skipped).filter(([n]) => !Object.hasOwn(links, n))) });
let loaded = false;

export function loadLinks() {
  const first = !loaded;
  loaded = true;
  lastCheck = checkLinks(readJson(LINKS_FILE));
  // Only the first load warns (a later one may run under the selector), on stderr, and not for the hidden commands behind cd and completion.
  if (first && lastCheck.issues.length && !process.argv[2]?.startsWith('__')) {
    const n = lastCheck.issues.length;
    process.stderr.write(`upex: ${n} bad ${n === 1 ? 'entry' : 'entries'} in ${LINKS_FILE}, see upex doctor\n`);
  }
  return lastCheck.links;
}

// Only our own names, so a hand-saved file in backups/ is never touched.
const BACKUP_RE = /^links-[\dTZ-]+\.json$/;
const backupFiles = () => (fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter(f => BACKUP_RE.test(f)).sort() : []);
export const hasBackups = () => backupFiles().length > 0;

// Copy the current links.json to backups/ and keep only the newest KEEP_BACKUPS.
function backupLinks(next) {
  if (!fs.existsSync(LINKS_FILE)) return;
  const current = fs.readFileSync(LINKS_FILE);
  // A no-op save would only push real edits out.
  if (current.toString('utf-8') === JSON.stringify(next, null, 2)) return;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // wx: a concurrent save in the same ms takes the next index instead of overwriting.
  for (let i = 0; ; i++) {
    try {
      fs.writeFileSync(path.join(BACKUP_DIR, `links-${stamp}-${i}.json`), current, { flag: 'wx' });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  const old = backupFiles().slice(0, -KEEP_BACKUPS);
  for (const f of old) {
    // A locked old backup must not block the save.
    try { fs.rmSync(path.join(BACKUP_DIR, f), { force: true }); } catch {}
  }
}

// Usage bumps skip the backup, or a few opens would push real edits out of the last 10,
// unless the save rewrites coerced fields: the hand edit gets one backup first.
// `skipped` false drops the unusable entries (import --replace); the backup still has them.
export function saveLinks(links, { backup = true, skipped = true } = {}) {
  const next = skipped ? withSkipped(links) : links;
  if ((backup || lastCheck.fixed) && !dryRun) backupLinks(next);
  writeJson(LINKS_FILE, next);
}

// Names added, removed and changed going from `before` to `after`.
export function diffLinks(before, after) {
  const added = Object.keys(after).filter(n => !Object.hasOwn(before, n));
  const removed = Object.keys(before).filter(n => !Object.hasOwn(after, n));
  const changed = Object.keys(after).filter(n => Object.hasOwn(before, n) && JSON.stringify(before[n]) !== JSON.stringify(after[n]));
  return { added, removed, changed };
}

// `restored` with usage stats taken from `current`: opens make no backup, so undo must not reset them.
export function keepUsage(restored, current) {
  const out = {};
  for (const [name, e] of Object.entries(restored)) {
    const c = current[name];
    out[name] = c && (c.uses || c.lastUsed) ? { ...e, uses: c.uses, lastUsed: c.lastUsed } : e;
  }
  return out;
}

/**
 * Roll links.json back to the newest backup that changes something, deleting the backups used,
 * so the next undo steps further back. Returns { added, removed, changed, at, left } or null.
 */
export function undoLast() {
  const current = loadLinks();
  for (const f of backupFiles().reverse()) {
    const file = path.join(BACKUP_DIR, f);
    const at = fs.statSync(file).mtimeMs;
    const old = checkLinks(readJson(file));
    const restored = keepUsage(old.links, current);
    const diff = diffLinks(current, restored);
    const changes = diff.added.length || diff.removed.length || diff.changed.length;
    // Unusable entries go back too: the backup's, and current ones (a newer hand edit wins) it has no real entry for.
    if (changes) writeJson(LINKS_FILE, { ...old.skipped, ...withSkipped(restored) });
    // A locked backup must not fail an undo already written; the next undo skips it as a no-op.
    if (!dryRun) try { fs.rmSync(file, { force: true }); } catch {}
    if (changes) return { ...diff, at, left: backupFiles().length };
  }
  return null;
}

export function getLink(name) {
  const links = loadLinks();
  return links[name] ?? null;
}

/**
 * Save a shortcut entry.
 * @param {string} name
 * @param {string|object} pathOrEntry - folder path string OR full entry object { path?, app? }
 */
export function setLink(name, pathOrEntry) {
  const links = loadLinks();
  if (typeof pathOrEntry === 'string') {
    links[name] = { path: pathOrEntry };
  } else {
    links[name] = pathOrEntry;
  }
  saveLinks(links);
}

// Entry with pinned set or dropped (never stored as false); unpinning also drops its place in the pin order.
export function withPinned(entry, on) {
  const { pinned: _p, pinOrder: _o, ...rest } = entry;
  return on ? { ...entry, pinned: true } : rest;
}

// Pinned shortcuts in this order (Alt+Up/Down in the selector), one save.
export function setPinOrder(names) {
  const links = loadLinks();
  names.forEach((n, i) => { if (links[n]?.pinned) links[n].pinOrder = i; });
  saveLinks(links);
}

// Deletes these in one save, so upex undo brings them all back at once. Returns the removed { name: entry }.
export function removeLinks(names) {
  const links = loadLinks();
  const gone = Object.fromEntries(names.filter(n => Object.hasOwn(links, n)).map(n => [n, links[n]]));
  for (const n of Object.keys(gone)) delete links[n];
  if (Object.keys(gone).length) saveLinks(links);
  return gone;
}

export const removeLink = name => Object.keys(removeLinks([name])).length > 0;

export function renameLink(oldName, newName) {
  const links = loadLinks();
  if (!Object.hasOwn(links, oldName)) return { ok: false, reason: 'not_found' };
  const taken = takenError(links, newName, oldName);
  if (taken) return { ok: false, reason: 'exists', message: taken };
  // Rebuild so the shortcut keeps its position; renaming to an own alias drops that alias.
  const out = {};
  for (const [k, v] of Object.entries(links)) {
    if (k !== oldName) { out[k] = v; continue; }
    const aliases = aliasesOf(v).filter(a => a !== newName);
    const { aliases: _old, ...rest } = v;
    out[newName] = aliases.length ? { ...rest, aliases } : rest;
  }
  saveLinks(out);
  return { ok: true };
}

export const aliasesOf = (e) => (Array.isArray(e?.aliases) ? e.aliases.filter(a => typeof a === 'string') : []);

// Color label of a shortcut: a palette name, #rrggbb or one emoji.
export const COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'];
let segmenter;
// Typed color -> { color } ('' = none, a bare rrggbb gets its #) or { error }.
export function parseColor(v) {
  const s = String(v ?? '').trim();
  const low = s.toLowerCase();
  if (!s || low === 'none') return { color: '' };
  if (COLORS.includes(low)) return { color: low };
  if (/^#?[0-9a-f]{6}$/.test(low)) return { color: `#${low.replace('#', '')}` };
  const one = [...(segmenter ??= new Intl.Segmenter()).segment(s)].length === 1;
  if (one && /^(\p{Extended_Pictographic}|\p{Regional_Indicator})/u.test(s)) return { color: s };
  return { error: `Color: ${COLORS.join(', ')}, #rrggbb, one emoji or none.` };
}
// A shortcut's color label, normalized; '' for none or hand-edited junk.
export const colorOf = e => (typeof e?.color === 'string' && parseColor(e.color).color) || '';

// Shortcut that owns `name` as its name or an alias, or null. Archived ones count.
export function nameOwner(links, name) {
  if (Object.hasOwn(links, name)) return name;
  return Object.keys(links).find(k => aliasesOf(links[k]).includes(name)) ?? null;
}

// Why `name` is taken by a shortcut other than `self`, or null.
export function takenError(links, name, self) {
  const owner = nameOwner(links, name);
  if (!owner || owner === self) return null;
  if (owner !== name) return `"${name}" is an alias of ${owner}.`;
  return links[owner].archived ? `"${name}" is archived. Restore it with: upex restore ${name}` : `"${name}" already exists.`;
}

// Cleaned alias list for `owner` (called `name` after a rename), or { error }.
export function checkAliases(links, owner, list, name = owner) {
  const aliases = [];
  for (const a of list) {
    if (a === name || aliases.includes(a)) continue;
    const bad = nameError(a) || takenError(links, a, owner);
    if (bad) return { error: bad };
    aliases.push(a);
  }
  return { aliases };
}

// Names claimed twice, e.g. after an import: ["vd: velora, vibe"].
export function aliasClashes(links) {
  const owners = new Map();
  for (const [n, e] of Object.entries(links)) {
    for (const a of aliasesOf(e)) {
      if (!owners.has(a)) owners.set(a, Object.hasOwn(links, a) ? [a] : []);
      if (!owners.get(a).includes(n)) owners.get(a).push(n);
    }
  }
  return [...owners].filter(([, o]) => o.length > 1).map(([a, o]) => `${a}: ${o.join(', ')}`);
}

// Everything except archived shortcuts (or only those, with archived = true).
export const activeLinks = (links, archived = false) =>
  Object.fromEntries(Object.entries(links).filter(([, e]) => !!e.archived === archived));
// Active names and aliases, one per line, for `upex __names` (completion).
export const completionNames = () => Object.entries(activeLinks(loadLinks())).flatMap(([n, e]) => [n, ...aliasesOf(e)]).join('\n');
// A restored entry: dropping expires keeps it from being re-archived right away.
export const unarchived = ({ archived: _a, expires: _e, ...entry }) => entry;

// Active shortcuts not opened in `days`: [{ name, entry, since }], never-opened first, then oldest.
// `since` is lastUsed, else added, else null.
export function staleLinks(links, days, now = Date.now()) {
  const cutoff = now - days * 86400000;
  return Object.entries(activeLinks(links))
    .map(([name, entry]) => ({ name, entry, since: entry.lastUsed || entry.added || null }))
    .filter(s => !s.since || s.since <= cutoff)
    .sort((a, b) => (a.entry.lastUsed ? 1 : 0) - (b.entry.lastUsed ? 1 : 0) || (a.since || 0) - (b.since || 0));
}

// Archive active shortcuts whose `expires` has passed. Returns { links, archived: [names] }.
export function sweepExpired(links, now = Date.now()) {
  const out = { ...links };
  const archived = [];
  for (const [name, e] of Object.entries(links)) {
    if (!e.archived && e.expires && e.expires <= now) {
      out[name] = { ...e, archived: true };
      archived.push(name);
    }
  }
  return { links: out, archived };
}

// Why a new shortcut or workspace name is invalid, or null when it's fine.
export function nameError(name) {
  if (!name) return 'Name is required.';
  if (name === '__proto__') return 'That name is reserved.';
  if (/\s/.test(name)) return 'Names cannot contain spaces.';
  return null;
}

/**
 * Bump usage stats for a shortcut (drives frecency sorting) and log the open for `upex stats`.
 */
export function recordUse(name, opener) {
  if (dryRun) return;
  const links = loadLinks();
  if (!Object.hasOwn(links, name)) return;
  const entry = links[name];
  entry.uses = (entry.uses || 0) + 1;
  entry.lastUsed = Date.now();
  saveLinks(links, { backup: false });
  // Stats only: a failed append must never break opening.
  try { fs.appendFileSync(HISTORY_FILE, JSON.stringify({ ts: entry.lastUsed, name, opener }) + '\n', 'utf-8'); } catch {}
}

// Open log from history.jsonl; malformed lines are skipped, a missing file is [].
export function loadHistory(file = HISTORY_FILE) {
  let text;
  try { text = fs.readFileSync(file, 'utf-8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    try {
      const h = JSON.parse(line);
      if (h && typeof h.name === 'string' && Number.isFinite(h.ts)) out.push(h);
    } catch {}
  }
  return out;
}

const WEEK = 7 * 86400000;

// Opens since `since` ranked by shortcut and opener, plus opens per week over the last `weeks` weeks.
export function statsFrom(history, { since = 0, now = Date.now(), weeks = 8 } = {}) {
  const rank = (key) => {
    const counts = new Map();
    for (const h of history) {
      if (h.ts < since || h.ts > now || typeof h[key] !== 'string') continue;
      counts.set(h[key], (counts.get(h[key]) || 0) + 1);
    }
    return [...counts].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
  };
  const perWeek = Array(weeks).fill(0);
  for (const h of history) {
    const ago = Math.floor((now - h.ts) / WEEK);
    if (ago >= 0 && ago < weeks) perWeek[weeks - 1 - ago]++;
  }
  const shortcuts = rank('name');
  return { total: shortcuts.reduce((n, [, c]) => n + c, 0), shortcuts, openers: rank('opener'), perWeek };
}

/**
 * Frecency score: usage count plus a recency bonus that decays over days.
 */
export function frecency(entry) {
  const uses = entry.uses || 0;
  const last = entry.lastUsed || 0;
  if (!last) return uses;
  const days = (Date.now() - last) / 86400000;
  return uses + 4 / (1 + days);
}

// Folder path as a compare key: resolved, no trailing slash, case-insensitive on Windows.
export const pathKey = (p) => {
  const r = path.resolve(p).replace(/(.)[\\/]+$/, '$1');
  return os.platform() === 'win32' ? r.toLowerCase() : r;
};

// Folders visited through `upex cd`: { path: { uses, lastUsed, hidden? } }. Disposable, so unreadable = empty.
export function loadVisits(file = VISITS_FILE) {
  try {
    return Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, ''))).filter(([, v]) => v && typeof v === 'object'));
  } catch { return {}; }
}

// `visits` with `change` merged into the entry for `dir`.
const withVisit = (visits, dir, change) => {
  const key = Object.keys(visits).find(k => pathKey(k) === pathKey(dir)) || dir;
  return { ...visits, [key]: { ...visits[key], ...change(visits[key] || {}) } };
};

// One more visit to `dir`; past KEEP_VISITS the least recently visited go (by use count, a new folder could never stay).
export function bumpVisit(visits, dir, now = Date.now()) {
  const next = withVisit(visits, dir, v => ({ uses: (v.uses || 0) + 1, lastUsed: now }));
  return Object.fromEntries(Object.entries(next).sort((a, b) => (b[1].lastUsed || 0) - (a[1].lastUsed || 0)).slice(0, KEEP_VISITS));
}

// A failed write must never break the cd.
function saveVisits(visits) {
  try {
    ensureStore();
    if (!fs.existsSync(VISITS_FILE)) fs.writeFileSync(VISITS_FILE, '{}', 'utf-8');
    writeJson(VISITS_FILE, visits);
  } catch {}
}

// Count a visit from `upex cd`. Home and drive roots are skipped: everyone passes through them.
export function recordVisit(dir) {
  if (!path.basename(dir) || pathKey(dir) === pathKey(os.homedir())) return;
  saveVisits(bumpVisit(loadVisits(), dir));
}

// Stop (or with `on` false, resume) suggesting a learned folder; `upex cd <name>` still jumps to it.
export function hideVisit(dir, on = true) {
  const visits = loadVisits();
  if (Object.keys(visits).some(k => pathKey(k) === pathKey(dir))) saveVisits(withVisit(visits, dir, () => ({ hidden: on || undefined })));
}
export const clearVisits = () => saveVisits({});

/**
 * Learned folders, best first: visited ones that still exist and no shortcut in `links` points at.
 * `query` keeps folder names containing it, an exact name first. `suggest` keeps the ones worth offering
 * as a shortcut: visited SUGGEST_AFTER times, not dismissed. `exists` is injectable for testing.
 */
export function learnedFolders(visits, links = {}, { query = '', suggest = false, exists = p => fs.existsSync(p) } = {}) {
  const taken = new Set(Object.values(links).filter(e => e.path).map(e => pathKey(e.path)));
  const q = query.toLowerCase();
  const exact = v => (v.name.toLowerCase() === q ? 1 : 0);
  return Object.entries(visits)
    .map(([p, v]) => ({ ...v, path: p, name: path.basename(p) }))
    .filter(v => v.name.toLowerCase().includes(q) && (!suggest || (v.uses >= SUGGEST_AFTER && !v.hidden)))
    .filter(v => !taken.has(pathKey(v.path)) && exists(v.path))
    .sort((a, b) => exact(b) - exact(a) || frecency(b) - frecency(a));
}

// The learned folder to offer as a shortcut next, or null.
export const topSuggestion = () => learnedFolders(loadVisits(), loadLinks(), { suggest: true })[0] || null;

/**
 * Split links into the ones to keep and the broken folder shortcuts to drop.
 * An entry with both a dead path and an app keeps the app (path cleared).
 * `exists` is injectable for testing.
 */
export function pruneBroken(links, exists = (p) => fs.existsSync(p)) {
  const kept = {};
  const removed = [];
  for (const [name, entry] of Object.entries(links)) {
    // Archived ones stay restorable.
    if (entry.path && !entry.archived && !exists(entry.path)) {
      if (entry.app) {
        const { path: _dead, ...rest } = entry;
        kept[name] = rest;
      } else {
        removed.push(name);
      }
    } else {
      kept[name] = entry;
    }
  }
  return { kept, removed };
}

/**
 * Name of the most recently used shortcut, or null if none has a lastUsed stamp.
 */
export function lastUsedName(links = loadLinks()) {
  let best = null;
  let bestTime = 0;
  for (const [name, entry] of Object.entries(links)) {
    if (!entry.archived && entry.lastUsed && entry.lastUsed > bestTime) {
      bestTime = entry.lastUsed;
      best = name;
    }
  }
  return best;
}

/**
 * Merge incoming shortcuts into current ones (for import).
 * replace=true swaps the whole set; otherwise incoming overwrites on name clash.
 */
export function mergeLinks(current, incoming, { replace = false } = {}) {
  if (replace) {
    return { merged: { ...incoming }, added: Object.keys(incoming), updated: [] };
  }
  const merged = { ...current };
  const added = [];
  const updated = [];
  for (const [name, entry] of Object.entries(incoming)) {
    (Object.hasOwn(merged, name) ? updated : added).push(name);
    merged[name] = entry;
  }
  return { merged, added, updated };
}

/**
 * Workspaces live in config.json under `workspaces`: { dev: [{ shortcut, app }] }.
 */
export function loadWorkspaces() {
  const { workspaces } = loadConfig();
  return workspaces && typeof workspaces === 'object' ? workspaces : {};
}

export function saveWorkspaces(workspaces) {
  const config = loadConfig();
  saveConfig({ ...config, workspaces });
}

export function removeWorkspace(name) {
  const { [name]: _drop, ...rest } = loadWorkspaces();
  saveWorkspaces(rest);
}

export function loadConfig() {
  return readJson(CONFIG_FILE);
}

export function saveConfig(config) {
  writeJson(CONFIG_FILE, config);
}

export { UPEX_DIR, LINKS_FILE, CONFIG_FILE };
