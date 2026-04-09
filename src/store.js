/**
 * store.js — Persistent storage for upex shortcuts and config
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

/**
 * Normalize a raw link value to { path?, app? }.
 * Supports legacy string format and new object format.
 */
function normalizeEntry(value) {
  if (typeof value === 'string') return { path: value };
  if (value && typeof value === 'object') return value;
  return null;
}

export function loadLinks() {
  ensureStore();
  try {
    const raw = fs.readFileSync(LINKS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    const normalized = {};
    for (const [name, value] of Object.entries(parsed)) {
      const entry = normalizeEntry(value);
      if (entry) normalized[name] = entry;
    }
    return normalized;
  } catch {
    return {};
  }
}

export function saveLinks(links) {
  ensureStore();
  fs.writeFileSync(LINKS_FILE, JSON.stringify(links, null, 2), 'utf-8');
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
  if (!(name in links)) return false;
  delete links[name];
  saveLinks(links);
  return true;
}

export function renameLink(oldName, newName) {
  const links = loadLinks();
  if (!(oldName in links)) return { ok: false, reason: 'not_found' };
  if (newName in links) return { ok: false, reason: 'exists' };
  links[newName] = links[oldName];
  delete links[oldName];
  saveLinks(links);
  return { ok: true };
}

export function linkExists(name) {
  const links = loadLinks();
  return name in links;
}

export function loadConfig() {
  ensureStore();
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function saveConfig(config) {
  ensureStore();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

export { LINKS_FILE, CONFIG_FILE };
