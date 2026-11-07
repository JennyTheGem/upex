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

/**
 * Normalize a raw link value to { path?, app? }.
 * Supports legacy string format and new object format.
 */
function normalizeEntry(value) {
  if (typeof value === 'string') return { path: value };
  if (value && typeof value === 'object') return value;
  return null;
}

// Field holding a shortcut's target. An app shortcut that also has a path edits the path.
export const targetField = (e) => (e.url ? 'url' : e.app && !e.path ? 'app' : 'path');

function normalizeLinks(raw) {
  const normalized = {};
  for (const [name, value] of Object.entries(raw)) {
    const entry = normalizeEntry(value);
    if (entry) normalized[name] = entry;
  }
  return normalized;
}

export const loadLinks = () => normalizeLinks(readJson(LINKS_FILE));

// Only our own names, so a hand-saved file in backups/ is never touched.
const BACKUP_RE = /^links-[\dTZ-]+\.json$/;
const backupFiles = () => (fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter(f => BACKUP_RE.test(f)).sort() : []);

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

// Usage bumps skip the backup, or a few opens would push real edits out of the last 10.
export function saveLinks(links, { backup = true } = {}) {
  if (backup) backupLinks(links);
  writeJson(LINKS_FILE, links);
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
    const restored = keepUsage(normalizeLinks(readJson(file)), current);
    const diff = diffLinks(current, restored);
    const changes = diff.added.length || diff.removed.length || diff.changed.length;
    if (changes) writeJson(LINKS_FILE, restored);
    // A locked backup must not fail an undo already written; the next undo skips it as a no-op.
    try { fs.rmSync(file, { force: true }); } catch {}
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

// Entry with pinned set or dropped (never stored as false).
export function withPinned(entry, on) {
  const { pinned: _old, ...rest } = entry;
  return on ? { ...rest, pinned: true } : rest;
}

export function removeLink(name) {
  const links = loadLinks();
  if (!Object.hasOwn(links, name)) return false;
  delete links[name];
  saveLinks(links);
  return true;
}

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

export { LINKS_FILE, CONFIG_FILE };
