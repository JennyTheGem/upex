/**
 * smoke.mjs -- Minimal asserts for the non-trivial logic: frecency + prune.
 * Run: npm test
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { frecency, pruneBroken, mergeLinks, lastUsedName, nameError } from '../src/store.js';
import { installCmdWrapper } from '../src/commands/setup.js';
import { normalizeUrl, caretEscape, wtCommandLine, terminalLayout } from '../src/launcher.js';
import { parseTags } from '../src/commands/add.js';
import { truncate } from '../src/ui.js';
import { applyShortcut, cleanEntries } from '../src/commands/web.js';
import { renderInteractiveView, inView, tidyPath } from '../src/interactive.js';
import { resolveTarget, suggestNames } from '../src/fuzzy.js';

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

// -- subpaths: go prints a folder inside the shortcut, missing subfolder fails --
fs.mkdirSync(path.join(target, 'sub'));
assert.equal(upexIn('go', 't/sub').stdout, path.join(target, 'sub'), 'go resolves a subpath');
assert.equal(upexIn('go', 't/nope').status, 1, 'missing subpath fails');

// -- default opener: set, reject unknown, reject on URL, clear --
const stored = () => JSON.parse(fs.readFileSync(linksFile, 'utf-8'));
assert.equal(upexIn('edit', 't', '--opener', 'VSCode').status, 0, 'opener set');
assert.equal(stored().t.opener, 'vscode', 'opener stored lowercased');
assert.equal(stored().t.path, target, 'opener-only edit keeps the path');
assert.equal(upexIn('edit', 't', '--opener', 'nope').status, 1, 'unknown opener rejected');
assert.equal(upexIn('edit', 't', '--opener', 'constructor').status, 1, 'prototype names are not openers');
assert.equal(upexIn('edit', 't', '--opener', 'code').status, 0, 'alias opener accepted');
assert.equal(stored().t.opener, 'vscode', 'alias stored under the selector key');
assert.equal(upexIn('add', 'u', 'x.dev', '--url', '--opener', 'vscode').status, 1, 'opener on a URL shortcut rejected');
assert.equal(upexIn('edit', 't', '--no-opener').status, 0, 'opener cleared');
assert.equal(stored().t.opener, undefined, 'cleared opener removed from the entry');

// -- doctor: healthy store passes, a corrupt one fails --
const doc = upexIn('doctor');
assert.equal(doc.status, 0, 'doctor passes on a good store');
assert.ok(doc.stdout.includes('1 shortcut'), 'doctor reports the store');
fs.rmSync(target, { recursive: true, force: true });
assert.match(upexIn('doctor').stdout, /broken shortcut: t/, 'doctor flags a broken path');

// -- store: a corrupt links.json is never overwritten, a BOM is tolerated --
const broken = '{"keep": {"path": "X"},';
fs.writeFileSync(linksFile, broken);
assert.equal(upexIn('add', 'new', home).status, 1, 'corrupt store fails the command');
assert.equal(fs.readFileSync(linksFile, 'utf-8'), broken, 'corrupt store is left untouched');
assert.equal(upexIn('doctor').status, 1, 'doctor fails on a corrupt store');
fs.writeFileSync(linksFile, '\uFEFF' + JSON.stringify({ gh: { url: 'github.com' } }));
assert.equal(upexIn('edit', 'gh', 'gitlab.com').status, 0, 'BOM-prefixed store loads');
assert.equal(JSON.parse(fs.readFileSync(linksFile, 'utf-8')).gh.url, 'gitlab.com', 'edit replaces a URL target');
assert.ok(!fs.readdirSync(path.dirname(linksFile)).some(f => f.endsWith('.tmp')), 'save leaves no temp file');

// -- prototype names are real names; a workspace with a failing entry exits 1 --
fs.writeFileSync(linksFile, JSON.stringify({}));
assert.equal(upexIn('add', 'constructor', home).status, 0, '"constructor" can be added');
assert.equal(upexIn('add', 'has space', home).status, 1, 'names with spaces rejected');
upexIn('ws', 'add', 'w', 'nope');
assert.equal(upexIn('ws', 'w').status, 1, 'failed workspace entry exits 1');
assert.equal(upexIn('ws', 'toString').status, 1, 'prototype workspace name is not found');

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

// -- resolveTarget: exact, subpath, fuzzy head, slash-named shortcut wins --
const rl = { web: {}, api: {}, 'a/b': {} };
assert.deepEqual(resolveTarget('web', rl), { name: 'web', exact: true, sub: '' }, 'exact name');
assert.deepEqual(resolveTarget('web/src/x', rl), { name: 'web', exact: true, sub: 'src/x' }, 'subpath split');
assert.deepEqual(resolveTarget('web\\src', rl), { name: 'web', exact: true, sub: 'src' }, 'backslash subpath');
assert.equal(resolveTarget('wbe/src', rl).name, 'web', 'fuzzy head keeps the subpath');
assert.deepEqual(resolveTarget('a/b', rl), { name: 'a/b', exact: true, sub: '' }, 'full name with a slash wins');
assert.deepEqual(resolveTarget('a/b/c', rl), { name: 'a/b', exact: true, sub: 'c' }, 'slash-named shortcut takes a subpath');
assert.equal(resolveTarget('zzzzzz', rl), null, 'no match -> null');

// -- selector tabs: folders on Shortcuts, apps + URLs on Apps --
const tabbed = [{ name: 'f' }, { name: 'a', isApp: true }, { name: 'u', isUrl: true }];
assert.deepEqual(tabbed.filter(inView('shortcuts')).map(c => c.name), ['f'], 'shortcuts tab: folders only');
assert.deepEqual(tabbed.filter(inView('apps')).map(c => c.name), ['a', 'u'], 'apps tab: apps and URLs');

// -- normalizeUrl: bare host gets https, real scheme kept --
assert.equal(normalizeUrl('github.com'), 'https://github.com', 'bare host gets https');
assert.equal(normalizeUrl('http://x.dev'), 'http://x.dev', 'existing scheme preserved');

// -- caretEscape: cmd.exe metachars inside the user's own quotes survive the outer shell --
assert.equal(caretEscape('cd x && echo "a & b|c"'), 'cd x && echo "a ^& b^|c"', 'only user-quoted metachars escaped');
if (process.platform === 'win32') {
  // Same quote layout as `start "" cmd /s /k "<line>"`, but /c so no window opens.
  const line = 'echo "a & b" && echo two';
  const out = execSync(`cmd /s /c "${caretEscape(line)}"`, { encoding: 'utf-8' }).split(/\r?\n/).map(s => s.trim());
  assert.deepEqual(out.slice(0, 2), ['"a & b"', 'two'], 'cmd.exe runs the line as typed');
}

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
assert.ok(wsView.includes('tab shortcuts') && wsView.includes('› dev') && wsView.includes('s:vscode'), 'workspace view lists workspaces');
assert.ok(!wsView.includes('Explorer'), 'no opener row in workspace view');
assert.ok(strip(renderInteractiveView(viewArgs)).includes('tab apps'), 'shortcut view is the default');
const appsView = strip(renderInteractiveView({ ...viewArgs, view: 'apps', choices: [{ name: 'g', path: 'x.dev', isUrl: true, exists: true }] }));
assert.ok(appsView.includes('tab workspaces') && appsView.includes('open in browser') && !appsView.includes('Explorer'), 'apps view: no opener row');
const setView = strip(renderInteractiveView({ ...viewArgs, view: 'settings', layout: 'tabs', wt: false }));
assert.ok(setView.includes('‹ Tabs ›') && setView.includes('not found') && !setView.includes('Explorer'), 'settings view: layout + missing-wt note');
assert.ok(setView.indexOf('Workspaces') < setView.indexOf('Settings'), 'settings tab is last');

// rows stay inside the given width, the missing badge survives a long path
const longArgs = (width, exists) => ({ ...viewArgs, width, choices: [{ name: 's', path: 'P/'.repeat(60) + 'leaf', exists }] });
const longView = strip(renderInteractiveView(longArgs(60, false)));
assert.ok(longView.split('\n').every(l => l.length <= 60), 'rows fit the width');
assert.ok(/…[P/]+leaf\s+missing/.test(longView), 'long path clipped from the start, badge kept');
const selRow = (width, exists) => strip(renderInteractiveView(longArgs(width, exists))).split('\n').find(l => l.startsWith('  › s '));
assert.equal(selRow(60, true).length, 60, 'selected row without a badge fills the width exactly');
assert.equal(selRow(30, false).length, 30, 'narrow terminal: row still fits');
assert.equal(tidyPath(path.join(os.homedir(), 'x')), path.join('~', 'x'), 'home -> ~');
assert.equal(tidyPath(os.homedir() + 'x'), os.homedir() + 'x', 'home prefix of another name untouched');
if (os.platform() === 'win32') assert.equal(tidyPath(os.homedir().toUpperCase() + '\\x'), '~\\x', 'windows: home match ignores case');

// -- applyShortcut: add, rename in place, clashes, path checks --
const yes = () => true;
const base = { a: { path: path.resolve('/A') }, b: { url: 'x.dev', tags: ['t'] } };
assert.ok(applyShortcut(base, undefined, { kind: 'url', name: 'c', target: 'y.dev' }, yes).links.c.url === 'y.dev', 'add url');
assert.match(applyShortcut(base, undefined, { kind: 'url', name: 'a', target: 'y' }, yes).error, /exists/, 'add clash rejected');
const cmdAdd = applyShortcut(base, undefined, { kind: 'cmd', name: 'dev', target: 'npm run dev' }, yes).links.dev;
assert.deepEqual(cmdAdd, { app: 'npm run dev', terminal: true }, 'add cmd stores a terminal app');
assert.deepEqual(applyShortcut({ dev: cmdAdd }, 'dev', { name: 'dev', target: 'npm test' }, yes).links.dev, { app: 'npm test', terminal: true }, 'edit cmd keeps terminal');
assert.match(applyShortcut(base, undefined, { kind: 'folder', name: 'd', target: '/nope' }, () => false).error, /does not exist/, 'missing folder rejected');
assert.match(applyShortcut(base, undefined, { kind: 'url', name: 'a b', target: 'y' }, yes).error, /spaces/, 'spaces rejected');
const ren = applyShortcut(base, 'a', { name: 'z', target: '/A', tags: 'p, q' }, () => false).links;
assert.deepEqual(Object.keys(ren), ['z', 'b'], 'rename keeps position, unchanged dead path allowed');
assert.deepEqual(ren.z.tags, ['p', 'q'], 'tags parsed on edit');
assert.equal(applyShortcut(base, 'b', { name: 'b', target: 'x.dev', tags: '' }, yes).links.b.tags, undefined, 'empty tags dropped');
assert.match(applyShortcut(base, 'a', { name: 'b', target: '/A' }, yes).error, /exists/, 'rename clash rejected');
assert.ok(applyShortcut({ 'Led start': { url: 'x' } }, 'Led start', { name: 'Led start', target: 'y' }, yes).links, 'CLI name with spaces stays editable');

// -- opener via the web form: set, clear, folder only, known only --
const op = { a: { path: path.resolve('/A'), opener: 'vscode' }, b: { url: 'x.dev' } };
assert.equal(applyShortcut(op, 'a', { name: 'a', target: '/A', opener: 'cmd' }, yes).links.a.opener, 'cmd', 'opener set');
assert.equal(applyShortcut(op, 'a', { name: 'a', target: '/A', opener: '' }, yes).links.a.opener, undefined, 'empty opener clears');
assert.equal(applyShortcut(op, 'a', { name: 'a', target: '/A' }, yes).links.a.opener, 'vscode', 'missing opener kept');
assert.match(applyShortcut(op, 'b', { name: 'b', target: 'x.dev', opener: 'cmd' }, yes).error, /folder/, 'opener on URL rejected');
assert.match(applyShortcut(op, 'a', { name: 'a', target: '/A', opener: 'nope' }, yes).error, /Unknown/, 'unknown opener rejected');

// -- names: one rule for CLI, selector and web --
assert.equal(nameError('dev'), null, 'plain name ok');
assert.ok(nameError('') && nameError('a b') && nameError('__proto__'), 'empty, spaced and __proto__ rejected');
assert.deepEqual(suggestNames('webap', ['webapp', 'notes']), ['webapp'], 'close name suggested');

// -- cleanEntries: shape workspace entries, reject bad ones --
assert.deepEqual(cleanEntries([{ shortcut: ' s ', app: '', count: '2', start: ' claude ' }]), [{ shortcut: 's', count: 2, start: 'claude' }], 'entry cleaned');
assert.equal(cleanEntries([{ shortcut: '' }]), null, 'empty shortcut rejected');
assert.equal(cleanEntries([{ shortcut: 's', count: 0 }]), null, 'count 0 rejected');
assert.equal(cleanEntries('x'), null, 'non-array rejected');
assert.equal(cleanEntries([null]), null, 'null entry rejected, not thrown');

// -- wt: N shells in one wt call; trailing backslash, user `;` and quotes survive wt's parser --
assert.equal(wtCommandLine('C:\\a b\\', '', 2, 'tabs'), String.raw`-w 0 new-tab -d "C:\a b\\" cmd ; new-tab -d "C:\a b\\" cmd`, 'tabs, quoted dir');
assert.equal(wtCommandLine(String.raw`C:\x`, 'a; b', 2, 'panes'), String.raw`-w 0 new-tab -d C:\x cmd /s /k "a\; b" ; split-pane -d C:\x cmd /s /k "a\; b"`, 'panes, escaped ;');
assert.equal(wtCommandLine(String.raw`C:\x`, String.raw`code "C:\a b\" && x`, 1, 'tabs'), String.raw`-w 0 new-tab -d C:\x cmd /s /k "code \"C:\a b\\\" && x"`, 'start cmd is one arg, inner quotes escaped');
assert.equal(wtCommandLine(String.raw`C:\x`, 'claude', 1, 'tabs'), String.raw`-w 0 new-tab -d C:\x cmd /s /k claude`, 'plain start cmd unquoted');
assert.equal(terminalLayout({ terminalLayout: 'bogus' }), 'windows', 'unknown layout falls back to windows');

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
  const st = await (await fetch(base + '/api/state', { headers: { 'x-upex-token': token } })).json();
  assert.equal(st.links.find(l => l.name === 'gh').tab, 'apps', 'URL shortcut listed on the Apps tab');
  const putWs = (prev) => fetch(base + '/api/workspace', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-upex-token': token },
    body: JSON.stringify({ name: 'dev', entries: [{ shortcut: 'gh' }], prev }),
  });
  assert.equal((await putWs(null)).status, 200, 'new workspace created');
  assert.equal((await putWs(null)).status, 409, 'stale page cannot overwrite a changed workspace');
  const rename = await fetch(base + '/api/workspace', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-upex-token': token },
    body: JSON.stringify({ name: 'dev', newName: 'work', entries: [{ shortcut: 'gh' }], prev: [{ shortcut: 'gh' }] }),
  });
  assert.equal(rename.status, 200, 'workspace renamed');
  const cfg = JSON.parse(fs.readFileSync(path.join(webHome, '.upex', 'config.json'), 'utf-8'));
  assert.deepEqual(Object.keys(cfg.workspaces), ['work'], 'old workspace name gone');
  const putSet = (terminalLayout) => fetch(base + '/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-upex-token': token },
    body: JSON.stringify({ terminalLayout }),
  });
  assert.equal((await putSet('nope')).status, 400, 'bad layout refused');
  assert.equal((await putSet('panes')).status, 200, 'layout saved');
  const cfg2 = JSON.parse(fs.readFileSync(path.join(webHome, '.upex', 'config.json'), 'utf-8'));
  assert.equal(cfg2.terminalLayout, 'panes', 'layout written to config');
  assert.deepEqual(Object.keys(cfg2.workspaces), ['work'], 'settings save keeps workspaces');
} finally {
  // Already exited (e.g. crashed on start): waiting for 'exit' again would never settle.
  if (srv.exitCode === null && srv.signalCode === null) {
    srv.kill();
    await new Promise((r) => srv.once('exit', r));
  }
  fs.rmSync(webHome, { recursive: true, force: true });
}

console.log('ok - frecency + prune + cmd wrapper + resolve guard + go args + safe store + edit url + merge + lastUsed + url + tags + truncate + web ui + subpaths + opener + doctor + apps tab + names + ws rename + cmd quoting + wt layout + settings');
