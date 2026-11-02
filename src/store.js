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

export function loadLinks() {
  const normalized = {};
  for (const [name, value] of Object.entries(readJson(LINKS_FILE))) {
    const entry = normalizeEntry(value);
    if (entry) normalized[name] = entry;
  }
  return normalized;
}

export function saveLinks(links) {
  writeJson(LINKS_FILE, links);
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
  if (Object.hasOwn(links, newName)) return { ok: false, reason: 'exists' };
  links[newName] = links[oldName];
  delete links[oldName];
  saveLinks(links);
  return { ok: true };
}

export function linkExists(name) {
  return Object.hasOwn(loadLinks(), name);
}

// Why a new shortcut or workspace name is invalid, or null when it's fine.
export function nameError(name) {
  if (!name) return 'Name is required.';
  if (name === '__proto__') return 'That name is reserved.';
  if (/\s/.test(name)) return 'Names cannot contain spaces.';
  return null;
}

/**
 * Bump usage stats for a shortcut (drives frecency sorting).
 */
export function recordUse(name) {
  const links = loadLinks();
  if (!Object.hasOwn(links, name)) return;
  const entry = links[name];
  entry.uses = (entry.uses || 0) + 1;
  entry.lastUsed = Date.now();
  saveLinks(links);
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
    if (entry.path && !exists(entry.path)) {
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
    if (entry.lastUsed && entry.lastUsed > bestTime) {
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
