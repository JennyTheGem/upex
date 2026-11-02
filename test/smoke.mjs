/**
 * smoke.mjs -- Minimal asserts for the non-trivial logic: frecency + prune.
 * Run: npm test
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { frecency, pruneBroken, mergeLinks, lastUsedName } from '../src/store.js';
import { installCmdWrapper } from '../src/commands/setup.js';
import { normalizeUrl } from '../src/launcher.js';
import { parseTags } from '../src/commands/add.js';
import { truncate } from '../src/ui.js';
import { applyShortcut, cleanEntries } from '../src/commands/web.js';
import { renderInteractiveView } from '../src/interactive.js';

// -- frecency: recent + used beats old + unused; unused = 0 --
const now = Date.now();
const recent = frecency({ uses: 1, lastUsed: now });
const old = frecency({ uses: 1, lastUsed: now - 30 * 86400000 });
const never = frecency({});
assert.ok(recent > old, 'recent use should outrank old use');
assert.ok(old > never, 'any use should outrank never-used');
assert.equal(never, 0, 'never-used scores 0');
assert.ok(frecency({ uses: 10, lastUsed: now - 86400000 }) > recent, 'more uses ranks higher');

// -- pruneBroken: drop dead folders, keep good ones, keep app when path dies --
const exists = (p) => p === 'GOOD';
const links = {
  good: { path: 'GOOD' },
  dead: { path: 'MISSING' },
  appOnly: { app: 'chrome.exe' },
  both: { path: 'MISSING', app: 'code' },
};
const { kept, removed } = pruneBroken(links, exists);
assert.deepEqual(removed, ['dead'], 'only the dead pure-folder shortcut is removed');
assert.ok(kept.good && kept.appOnly, 'valid + app-only shortcuts survive');
assert.deepEqual(kept.both, { app: 'code' }, 'app shortcut keeps app, drops dead path');

// -- cmd wrapper: batch file that cds via go/__resolve --
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upex-'));
const bat = installCmdWrapper(dir);
const body = fs.readFileSync(bat, 'utf-8');
assert.ok(body.startsWith('@echo off'), 'wrapper is a batch script');
assert.ok(body.includes('__resolve') && body.includes('cd /d'), 'wrapper cds through resolve');
fs.rmSync(dir, { recursive: true, force: true });

// -- __resolve never shadows a real subcommand --
const cli = fileURLToPath(new URL('../bin/upex.js', import.meta.url));
const r = spawnSync(process.execPath, [cli, '__resolve', 'list'], { encoding: 'utf-8' });
assert.equal(r.status, 1, '__resolve refuses subcommand names');
assert.equal(r.stdout, '', 'no path printed for subcommand names');
// a lone `upex --help` through a wrapper must fall through, not cd into help text
const h = spawnSync(process.execPath, [cli, '__resolve', '--help'], { encoding: 'utf-8' });
assert.equal(h.status, 1, '__resolve refuses --help');
assert.equal(h.stdout, '', 'no help text printed for the wrapper to cd into');

// Run the CLI against a throwaway home holding the given links.json content.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'upex-home-'));
const linksFile = path.join(home, '.upex', 'links.json');
fs.mkdirSync(path.dirname(linksFile), { recursive: true });
const upexIn = (...args) => spawnSync(process.execPath, [cli, ...args], {
  encoding: 'utf-8',
  env: { ...process.env, USERPROFILE: home, HOME: home },
});

// -- go with args: runs the command inside the shortcut folder --
const target = fs.mkdtempSync(path.join(os.tmpdir(), 'upex-target-'));
fs.writeFileSync(linksFile, JSON.stringify({ t: { path: target } }));
const g = upexIn('go', 't', process.platform === 'win32' ? 'cd' : 'pwd');
assert.equal(g.status, 0, 'go with args exits 0');
assert.equal(g.stdout.trim(), target, 'command runs in the shortcut folder');
fs.rmSync(target, { recursive: true, force: true });

// -- store: a corrupt links.json is never overwritten, a BOM is tolerated --
const broken = '{"keep": {"path": "X"},';
fs.writeFileSync(linksFile, broken);
assert.equal(upexIn('add', 'new', home).status, 1, 'corrupt store fails the command');
assert.equal(fs.readFileSync(linksFile, 'utf-8'), broken, 'corrupt store is left untouched');
fs.writeFileSync(linksFile, '\uFEFF' + JSON.stringify({ gh: { url: 'github.com' } }));
assert.equal(upexIn('edit', 'gh', 'gitlab.com').status, 0, 'BOM-prefixed store loads');
assert.equal(JSON.parse(fs.readFileSync(linksFile, 'utf-8')).gh.url, 'gitlab.com', 'edit replaces a URL target');
assert.ok(!fs.readdirSync(path.dirname(linksFile)).some(f => f.endsWith('.tmp')), 'save leaves no temp file');
fs.rmSync(home, { recursive: true, force: true });

// -- mergeLinks: merge overwrites on clash, replace swaps the set --
const cur = { a: { path: 'A' }, b: { path: 'B' } };
const inc = { b: { path: 'B2' }, c: { path: 'C' } };
const m = mergeLinks(cur, inc);
assert.deepEqual(m.added, ['c'], 'new name is added');
assert.deepEqual(m.updated, ['b'], 'clashing name is updated');
assert.equal(m.merged.b.path, 'B2', 'incoming wins on clash');
assert.ok(m.merged.a, 'untouched links survive a merge');
const rep = mergeLinks(cur, inc, { replace: true });
assert.deepEqual(Object.keys(rep.merged).sort(), ['b', 'c'], 'replace swaps the whole set');

// -- lastUsedName: highest lastUsed wins, none -> null --
assert.equal(lastUsedName({ x: { lastUsed: 1 }, y: { lastUsed: 9 }, z: {} }), 'y', 'most recent wins');
assert.equal(lastUsedName({ x: {}, y: {} }), null, 'no lastUsed -> null');

// -- normalizeUrl: bare host gets https, real scheme kept --
assert.equal(normalizeUrl('github.com'), 'https://github.com', 'bare host gets https');
assert.equal(normalizeUrl('http://x.dev'), 'http://x.dev', 'existing scheme preserved');

// -- parseTags: split/trim/drop-empty, undefined when nothing usable --
assert.deepEqual(parseTags('work, personal ,'), ['work', 'personal'], 'tags split and trimmed');
assert.equal(parseTags(''), undefined, 'empty tag string -> undefined');
assert.equal(parseTags(undefined), undefined, 'missing tag -> undefined');

// -- truncate: clips to visible width, ignores ANSI, keeps short lines as-is --
const strip = (s) => s.replace(/\x1B\[[0-9;]*m/g, '');
assert.equal(truncate('hello', 10), 'hello', 'short line untouched');
assert.equal(strip(truncate('abcdefghij', 5)).length, 5, 'clipped to exact width');
assert.equal(strip(truncate(`\x1B[1mabcdefghij\x1B[0m`, 5)).length, 5, 'ANSI codes do not count as width');
assert.ok(truncate('abcdefghij', 5).endsWith('\x1B[0m'), 'clipped line resets styling');
assert.equal(truncate('abc', 0), '', 'zero width -> empty');
// text fills the width exactly, then a styled tail follows: must not overflow by the ellipsis
assert.equal(strip(truncate(`abcde\x1B[2m fg\x1B[0m`, 5)).length, 5, 'styled tail after exact fill stays in width');
assert.equal(strip(truncate('abcdefghij', 1)), '…', 'width 1 -> ellipsis only');

// -- selector: Tab view lists workspaces, hides the opener row --
const viewArgs = { query: '', choices: [{ name: 's', path: 'P', exists: true }], selectedIndex: 0, appChoices: [{ key: 'explorer', label: 'Explorer' }], selectedAppIndex: 0, cmdCount: 1 };
const wsView = strip(renderInteractiveView({ ...viewArgs, view: 'workspaces', workspaces: [{ name: 'dev', path: 's:vscode' }] }));
assert.ok(wsView.includes('[Workspaces]') && wsView.includes('> dev') && wsView.includes('s:vscode'), 'workspace view lists workspaces');
assert.ok(!wsView.includes('Explorer'), 'no opener row in workspace view');
assert.ok(strip(renderInteractiveView(viewArgs)).includes('[Shortcuts]'), 'shortcut view is the default');

// -- applyShortcut: add, rename in place, clashes, path checks --
const yes = () => true;
const base = { a: { path: path.resolve('/A') }, b: { url: 'x.dev', tags: ['t'] } };
assert.ok(applyShortcut(base, undefined, { kind: 'url', name: 'c', target: 'y.dev' }, yes).links.c.url === 'y.dev', 'add url');
assert.match(applyShortcut(base, undefined, { kind: 'url', name: 'a', target: 'y' }, yes).error, /exists/, 'add clash rejected');
assert.match(applyShortcut(base, undefined, { kind: 'folder', name: 'd', target: '/nope' }, () => false).error, /does not exist/, 'missing folder rejected');
assert.match(applyShortcut(base, undefined, { kind: 'url', name: 'a b', target: 'y' }, yes).error, /spaces/, 'spaces rejected');
const ren = applyShortcut(base, 'a', { name: 'z', target: '/A', tags: 'p, q' }, () => false).links;
assert.deepEqual(Object.keys(ren), ['z', 'b'], 'rename keeps position, unchanged dead path allowed');
assert.deepEqual(ren.z.tags, ['p', 'q'], 'tags parsed on edit');
assert.equal(applyShortcut(base, 'b', { name: 'b', target: 'x.dev', tags: '' }, yes).links.b.tags, undefined, 'empty tags dropped');
assert.match(applyShortcut(base, 'a', { name: 'b', target: '/A' }, yes).error, /exists/, 'rename clash rejected');
assert.ok(applyShortcut({ 'Led start': { url: 'x' } }, 'Led start', { name: 'Led start', target: 'y' }, yes).links, 'CLI name with spaces stays editable');

// -- cleanEntries: shape workspace entries, reject bad ones --
assert.deepEqual(cleanEntries([{ shortcut: ' s ', app: '', count: '2', start: ' claude ' }]), [{ shortcut: 's', count: 2, start: 'claude' }], 'entry cleaned');
assert.equal(cleanEntries([{ shortcut: '' }]), null, 'empty shortcut rejected');
assert.equal(cleanEntries([{ shortcut: 's', count: 0 }]), null, 'count 0 rejected');
assert.equal(cleanEntries('x'), null, 'non-array rejected');
assert.equal(cleanEntries([null]), null, 'null entry rejected, not thrown');

// -- upex ui: token + host guard, add via API writes the store --
const webHome = fs.mkdtempSync(path.join(os.tmpdir(), 'upex-web-'));
const srv = spawn(process.execPath, [cli, 'ui', '--port', '0', '--no-open'], {
  env: { ...process.env, USERPROFILE: webHome, HOME: webHome },
});
try {
  const link = await new Promise((resolve, reject) => {
    let out = '';
    srv.stdout.on('data', (c) => { out += c; const m = out.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+/); if (m) resolve(m[0]); });
    srv.on('exit', () => reject(new Error('ui server exited: ' + out)));
  });
  const { origin: base, searchParams } = new URL(link);
  const token = searchParams.get('t');
  assert.equal((await fetch(base)).status, 403, 'page without token refused');
  assert.ok((await (await fetch(link)).text()).includes(`const TOKEN = '${token}'`), 'page carries the token');
  assert.equal((await fetch(base + '/api/state')).status, 403, 'api without token refused');
  const rebound = await new Promise((resolve) => http.get(base, { agent: false, headers: { host: 'evil.test' } }, (res) => { res.resume(); resolve(res.statusCode); }));
  assert.equal(rebound, 403, 'foreign Host header refused');
  const post = await fetch(base + '/api/links', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-upex-token': token },
    body: JSON.stringify({ kind: 'url', name: 'gh', target: 'github.com', tags: 'web' }),
  });
  assert.equal(post.status, 200, 'add via api ok');
  const saved = JSON.parse(fs.readFileSync(path.join(webHome, '.upex', 'links.json'), 'utf-8'));
  assert.deepEqual(saved.gh, { url: 'github.com', tags: ['web'] }, 'api add written to store');
  const putWs = (prev) => fetch(base + '/api/workspace', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-upex-token': token },
    body: JSON.stringify({ name: 'dev', entries: [{ shortcut: 'gh' }], prev }),
  });
  assert.equal((await putWs(null)).status, 200, 'new workspace created');
  assert.equal((await putWs(null)).status, 409, 'stale page cannot overwrite a changed workspace');
} finally {
  // Already exited (e.g. crashed on start): waiting for 'exit' again would never settle.
  if (srv.exitCode === null && srv.signalCode === null) {
    srv.kill();
    await new Promise((r) => srv.once('exit', r));
  }
  fs.rmSync(webHome, { recursive: true, force: true });
}

console.log('ok - frecency + prune + cmd wrapper + resolve guard + go args + safe store + edit url + merge + lastUsed + url + tags + truncate + web ui');
