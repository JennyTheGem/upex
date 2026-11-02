/**
 * web.js -- `upex ui`: a local web page to manage shortcuts and workspaces.
 * Binds to 127.0.0.1 only; every API call needs the per-run token baked into the page.
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadLinks, saveLinks, loadWorkspaces, saveWorkspaces, pruneBroken, targetField, nameError, frecency } from '../store.js';
import { getInteractiveAppChoices, launchUrl, openerKey, isTerminalApp } from '../launcher.js';
import { handleOpen } from './open.js';
import { openEntries } from './workspace.js';
import { parseTags } from './add.js';
import * as ui from '../ui.js';

const PAGE = new URL('../web/index.html', import.meta.url);
const DEFAULT_PORT = 4545;

/**
 * Add (old undefined) or edit/rename (old = current name) one shortcut.
 * Pure: returns { links } with the new set, or { error }.
 */
export function applyShortcut(links, old, { kind, name, target, tags, opener } = {}, exists = fs.existsSync) {
  name = String(name ?? '').trim();
  target = String(target ?? '').trim();
  // Old CLI names may hold spaces; only new names are checked so those stay editable.
  const bad = name !== old && nameError(name);
  if (bad) return { error: bad };
  if (old !== undefined && !Object.hasOwn(links, old)) return { error: `Shortcut not found: ${old}` };
  if (name !== old && Object.hasOwn(links, name)) return { error: `"${name}" already exists.` };

  const prev = old === undefined ? {} : links[old];
  const field = old === undefined ? { folder: 'path', app: 'app', cmd: 'app', url: 'url' }[kind] : targetField(prev);
  if (!field) return { error: 'Pick folder, app, command or URL.' };
  if (old === undefined && kind === 'cmd') prev.terminal = true;
  if (!target) return { error: 'Target is required.' };
  if (field === 'path') {
    target = path.resolve(target);
    // Unchanged paths skip the check, so a broken shortcut can still be renamed.
    if (!(prev.path && path.resolve(prev.path) === target) && !exists(target)) return { error: `Path does not exist: ${target}` };
  }

  const entry = { ...prev, [field]: target };
  const t = parseTags(Array.isArray(tags) ? tags.join(',') : String(tags ?? ''));
  if (t) entry.tags = t; else delete entry.tags;
  // undefined leaves the opener alone, '' clears it.
  if (opener) {
    if (field !== 'path') return { error: 'A default opener only applies to folder shortcuts.' };
    const key = openerKey(opener);
    if (!key) return { error: `Unknown opener "${opener}".` };
    entry.opener = key;
  } else if (opener !== undefined) delete entry.opener;

  // Rebuild so a renamed shortcut keeps its position.
  const out = {};
  for (const [k, v] of Object.entries(links)) {
    if (k === old) out[name] = entry; else out[k] = v;
  }
  if (old === undefined) out[name] = entry;
  return { links: out };
}

/**
 * Validate workspace entries from the page. Returns the cleaned list or null.
 */
export function cleanEntries(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') return null;
    const shortcut = typeof e.shortcut === 'string' ? e.shortcut.trim() : '';
    const count = e.count === undefined || e.count === '' ? 1 : Number(e.count);
    // No upper bound: `upex ws add` stores any count and the launcher caps it.
    if (!shortcut || !Number.isInteger(count) || count < 1) return null;
    const app = typeof e.app === 'string' ? e.app.trim() : '';
    const start = typeof e.start === 'string' ? e.start.trim() : '';
    out.push({ shortcut, ...(app && { app }), ...(count > 1 && { count }), ...(start && { start }) });
  }
  return out;
}

function state() {
  const links = loadLinks();
  return {
    links: Object.entries(links).map(([name, e]) => {
      const field = targetField(e);
      return {
        name,
        kind: field === 'path' ? 'folder' : e.terminal ? 'cmd' : field,
        // Same split as the terminal selector: anything that launches directly lives on Apps.
        tab: e.app || e.url ? 'apps' : 'links',
        target: e[field] ?? '',
        tags: e.tags || [],
        opener: e.opener || '',
        lastUsed: e.lastUsed || 0,
        score: frecency(e),
        broken: Boolean(e.path) && !fs.existsSync(e.path),
      };
    }),
    workspaces: loadWorkspaces(),
    apps: getInteractiveAppChoices().map(a => ({ ...a, terminal: isTerminalApp(a.key) })),
    home: os.homedir(),
    sep: path.sep,
  };
}

const routes = {
  'GET /api/state': () => state(),

  'POST /api/links': (b) => saveShortcut(undefined, b),
  'PUT /api/links': (b) => saveShortcut(String(b.old ?? ''), b),

  'DELETE /api/links': (b) => {
    const links = loadLinks();
    if (!Object.hasOwn(links, String(b.name))) throw new HttpError(404, `Shortcut not found: ${b.name}`);
    delete links[b.name];
    saveLinks(links);
    return {};
  },

  'POST /api/open': async (b) => {
    const name = String(b.name ?? '');
    // Exact only: a stale name must not fuzzy-open some other shortcut.
    if (!Object.hasOwn(loadLinks(), name)) throw new HttpError(404, `Shortcut not found: ${name}`);
    const [e] = cleanEntries([{ shortcut: name, app: b.app, count: b.count, start: b.start }]) || [];
    if (!e) throw new HttpError(400, 'Window count must be at least 1.');
    const ok = await handleOpen(name, e.app, e.count || 1, e.start || '', { batch: true });
    if (!ok) throw new HttpError(422, `Could not open "${b.name}". Details are in the upex ui terminal.`);
    return {};
  },

  'POST /api/prune': () => {
    const { kept, removed } = pruneBroken(loadLinks());
    saveLinks(kept);
    return { removed };
  },

  // Set one workspace's entries (and optionally rename it); an empty list deletes it.
  // `prev` is the list the page saw (null = new), so a CLI change in between is not overwritten.
  'PUT /api/workspace': (b) => {
    const name = String(b.name ?? '').trim();
    const to = b.newName === undefined ? name : String(b.newName).trim();
    const entries = cleanEntries(b.entries);
    const all = loadWorkspaces();
    const exists = Object.hasOwn(all, name);
    const bad = (!exists && nameError(name)) || (to !== name && nameError(to));
    if (bad) throw new HttpError(400, bad);
    if (to !== name && Object.hasOwn(all, to)) throw new HttpError(409, `"${to}" already exists.`);
    if (!entries) throw new HttpError(400, 'Each entry needs a shortcut and a count of at least 1.');
    if (JSON.stringify(b.prev ?? null) !== JSON.stringify(exists ? all[name] : null)) {
      throw new HttpError(409, `Workspace "${name}" changed elsewhere. Reloaded, try again.`);
    }
    // fromEntries keeps the order, so a renamed workspace stays in place.
    const list = Object.entries(all).map(([k, v]) => (k === name ? [to, entries] : [k, v]));
    if (!exists) list.push([to, entries]);
    saveWorkspaces(Object.fromEntries(list.filter(([k, v]) => k !== to || v.length)));
    return {};
  },

  'POST /api/workspace/open': async (b) => {
    const workspaces = loadWorkspaces();
    const entries = Object.hasOwn(workspaces, String(b.name)) && workspaces[b.name];
    if (!entries) throw new HttpError(404, `No workspace named "${b.name}".`);
    const failed = await openEntries(entries);
    if (failed) throw new HttpError(422, `${failed} of ${entries.length} entries failed. Details are in the upex ui terminal.`);
    return {};
  },
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function saveShortcut(old, body) {
  const { links, error } = applyShortcut(loadLinks(), old, body);
  if (error) throw new HttpError(400, error);
  saveLinks(links);
  return {};
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf-8');
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) { reject(new HttpError(413, 'Request too large.')); req.destroy(); }
    });
    req.on('end', () => {
      try {
        const parsed = data ? JSON.parse(data) : {};
        if (!parsed || typeof parsed !== 'object') throw new Error();
        resolve(parsed);
      } catch { reject(new HttpError(400, 'Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function startServer({ port = DEFAULT_PORT, open = true } = {}) {
  const token = crypto.randomBytes(24).toString('hex');
  const nonce = crypto.randomBytes(16).toString('base64');
  const page = fs.readFileSync(PAGE, 'utf-8').replace('__TOKEN__', token).replaceAll('__NONCE__', nonce);
  let hosts = new Set();

  // One try around everything: a throw here would be an unhandled rejection and kill the server.
  const server = http.createServer(async (req, res) => {
    try {
      // Host check blocks DNS rebinding (an outside site resolving to 127.0.0.1).
      if (!hosts.has(req.headers.host)) return sendJson(res, 403, { error: 'Forbidden host.' });
      const { pathname, searchParams } = new URL(req.url, 'http://x');

      if (req.method === 'GET' && pathname === '/') {
        // The page holds the token, so it needs it too: other local users can reach 127.0.0.1.
        if (searchParams.get('t') !== token) return sendJson(res, 403, { error: 'Open the link printed by upex ui.' });
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
          'x-content-type-options': 'nosniff',
        });
        return res.end(page);
      }

      const handler = routes[`${req.method} ${pathname}`];
      if (!handler) return sendJson(res, 404, { error: 'Not found.' });
      if (req.headers['x-upex-token'] !== token) return sendJson(res, 403, { error: 'Missing or wrong token. Reload the page.' });

      const body = req.method === 'GET' ? {} : await readJsonBody(req);
      sendJson(res, 200, await handler(body));
    } catch (err) {
      sendJson(res, err.status || 500, { error: err.message });
    }
  });

  const ready = () => {
    const actual = server.address().port;
    hosts = new Set([`127.0.0.1:${actual}`, `localhost:${actual}`]);
    const url = `http://127.0.0.1:${actual}/?t=${token}`;
    ui.success(`upex ui running at ${url}`);
    ui.dim('Press Ctrl+C to stop.');
    if (open) launchUrl(url);
  };

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && port !== 0) {
      ui.warn(`Port ${port} is busy, using a free one.`);
      port = 0;
      server.listen(0, '127.0.0.1');
      return;
    }
    ui.error(`Cannot start server: ${err.message}`);
    process.exit(1);
  });
  server.on('listening', ready);
  server.listen(port, '127.0.0.1');
  return server;
}

export function registerWeb(program) {
  program
    .command('ui')
    .description('Open a local web page to add, edit, rename, delete and open shortcuts and workspaces')
    .summary('Manage shortcuts in the browser')
    .option('-p, --port <port>', 'Port to listen on', String(DEFAULT_PORT))
    .option('--no-open', 'Do not open the browser')
    .action((options) => {
      const port = Number(options.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        ui.error(`Invalid port: ${options.port}`);
        process.exit(1);
      }
      startServer({ port, open: options.open });
    });
}
