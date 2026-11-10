import { cli } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { parseColor, colorOf } from '../src/store.js';
import { applyShortcut, applyOpener, cleanEntries, startServer } from '../src/commands/web.js';
import { usageText, stepColor } from '../src/interactive.js';
import { VERSION } from '../src/update.js';

const yes = () => true;

test('applyShortcut: add, rename in place, clashes, path checks', () => {
  const base = { a: { path: path.resolve('/A') }, b: { url: 'x.dev', tags: ['t'] } };
  assert.ok(applyShortcut(base, undefined, { kind: 'url', name: 'c', target: 'y.dev' }, yes).links.c.url === 'y.dev', 'add url');
  assert.match(applyShortcut(base, undefined, { kind: 'url', name: 'a', target: 'y' }, yes).error, /exists/, 'add clash rejected');
  const { added: _cmdAdded, ...cmdAdd } = applyShortcut(base, undefined, { kind: 'cmd', name: 'dev', target: 'npm run dev' }, yes).links.dev;
  assert.deepEqual(cmdAdd, { app: 'npm run dev', terminal: true }, 'add cmd stores a terminal app');
  assert.deepEqual(applyShortcut({ dev: cmdAdd }, 'dev', { name: 'dev', target: 'npm test' }, yes).links.dev, { app: 'npm test', terminal: true }, 'edit cmd keeps terminal');
  assert.match(applyShortcut(base, undefined, { kind: 'folder', name: 'd', target: '/nope' }, () => false).error, /does not exist/, 'missing folder rejected');
  assert.match(applyShortcut(base, undefined, { kind: 'url', name: 'a b', target: 'y' }, yes).error, /spaces/, 'spaces rejected');
  // color labels: palette, hex (bare too), one emoji; none clears; edit sets, '' drops, junk is refused
  assert.deepEqual([parseColor('Blue'), parseColor('FF66AA'), parseColor('#00ff00'), parseColor('🔥'), parseColor('none'), parseColor('')].map(r => r.color), ['blue', '#ff66aa', '#00ff00', '🔥', '', '']);
  assert.ok(parseColor('pink').error && parseColor('🔥🔥').error && parseColor('a').error, 'bad colors refused');
  assert.deepEqual([colorOf({ color: 5 }), colorOf({ color: 'pink' }), colorOf({ color: 'Red' }), colorOf({})], ['', '', 'red', ''], 'hand-edited color junk reads as none');
  assert.equal(applyShortcut(base, 'b', { name: 'b', target: 'x.dev', color: 'red' }, yes).links.b.color, 'red', 'ui sets a color');
  assert.ok(!('color' in applyShortcut({ b: { url: 'x', color: 'red' } }, 'b', { name: 'b', target: 'x', color: '' }, yes).links.b), 'ui clears a color');
  assert.match(applyShortcut(base, 'b', { name: 'b', target: 'x.dev', color: 'pink' }, yes).error, /Color/, 'ui refuses a bad color');
  assert.deepEqual([stepColor('', 1), stepColor('red', -1), stepColor('', -1), stepColor('🔥', 1)], ['red', '', 'gray', 'red'], 'color row steps');
  // usage setting: last opened, open count, off; workspaces (no lastUsed) show none
  const used = { lastUsed: 1000, uses: 1 };
  assert.deepEqual([usageText(used, 'ago', 1000 + 3 * 86400000), usageText({ lastUsed: 0, uses: 0 }, 'ago'), usageText(used, 'opens'), usageText({ lastUsed: 0, uses: 0 }, 'opens'), usageText(used, 'off'), usageText({}, 'ago')],
    ['3d ago', 'never', '1 open', '0 opens', '', '']);
  const ren = applyShortcut(base, 'a', { name: 'z', target: '/A', tags: 'p, q' }, () => false).links;
  assert.deepEqual(Object.keys(ren), ['z', 'b'], 'rename keeps position, unchanged dead path allowed');
  assert.deepEqual(ren.z.tags, ['p', 'q'], 'tags parsed on edit');
  assert.equal(applyShortcut(base, 'b', { name: 'b', target: 'x.dev', tags: '' }, yes).links.b.tags, undefined, 'empty tags dropped');
  assert.equal(applyShortcut(base, 'b', { name: 'b', target: 'x.dev', note: ' hi\n there ' }, yes).links.b.note, 'hi there', 'note set, one line');
  assert.equal(applyShortcut({ b: { url: 'x', note: 'n' } }, 'b', { name: 'b', target: 'x' }, yes).links.b.note, 'n', 'note kept when not sent');
  assert.equal(applyShortcut({ b: { url: 'x', note: 'n' } }, 'b', { name: 'b', target: 'x', note: '' }, yes).links.b.note, undefined, 'empty note cleared');
  assert.match(applyShortcut(base, 'a', { name: 'b', target: '/A' }, yes).error, /exists/, 'rename clash rejected');
  assert.ok(applyShortcut({ 'Led start': { url: 'x' } }, 'Led start', { name: 'Led start', target: 'y' }, yes).links, 'CLI name with spaces stays editable');
});

test('opener via the web form: set, clear, folder only, known only', () => {
  const op = { a: { path: path.resolve('/A'), opener: 'vscode' }, b: { url: 'x.dev' } };
  assert.equal(applyShortcut(op, 'a', { name: 'a', target: '/A', opener: 'cmd' }, yes).links.a.opener, 'cmd', 'opener set');
  assert.equal(applyShortcut(op, 'a', { name: 'a', target: '/A', opener: '' }, yes).links.a.opener, undefined, 'empty opener clears');
  assert.equal(applyShortcut(op, 'a', { name: 'a', target: '/A' }, yes).links.a.opener, 'vscode', 'missing opener kept');
  assert.match(applyShortcut(op, 'b', { name: 'b', target: 'x.dev', opener: 'cmd' }, yes).error, /folder/, 'opener on URL rejected');
  assert.match(applyShortcut(op, 'a', { name: 'a', target: '/A', opener: 'nope' }, yes).error, /Unknown/, 'unknown opener rejected');
  const ab = { a: { path: '/A' }, b: { url: 'x', aliases: ['bb'] } };
  assert.deepEqual(applyShortcut(ab, 'a', { name: 'a', target: '/A', aliases: 'p, q' }, yes).links.a.aliases, ['p', 'q'], 'aliases set');
  assert.match(applyShortcut(ab, 'a', { name: 'a', target: '/A', aliases: 'bb' }, yes).error, /alias of b/, 'taken alias rejected');
  assert.match(applyShortcut(ab, 'a', { name: 'bb', target: '/A' }, yes).error, /alias of b/, 'rename onto an alias rejected');
  assert.equal(applyShortcut(ab, 'b', { name: 'bb', target: 'x' }, yes).links.bb.aliases, undefined, 'rename to own alias drops it');
});

test('cleanEntries: shape workspace entries, reject bad ones', () => {
  assert.deepEqual(cleanEntries([{ shortcut: ' s ', app: '', count: '2', start: ' claude ' }]), [{ shortcut: 's', count: 2, start: 'claude' }], 'entry cleaned');
  assert.equal(cleanEntries([{ shortcut: '' }]), null, 'empty shortcut rejected');
  assert.equal(cleanEntries([{ shortcut: 's', count: 0 }]), null, 'count 0 rejected');
  assert.equal(cleanEntries('x'), null, 'non-array rejected');
  assert.equal(cleanEntries([null]), null, 'null entry rejected, not thrown');
});

test('applyOpener: add, change command, clashes', () => {
  assert.deepEqual(applyOpener({}, { name: ' cursor ', command: ' cursor ' }, true).apps, { cursor: 'cursor' }, 'opener added, trimmed');
  assert.match(applyOpener({ Cursor: 'c' }, { name: 'cursor', command: 'x' }, true).error, /exists/, 'case-only clash rejected');
  assert.match(applyOpener({}, { name: 'a b', command: 'x' }, true).error, /spaces/, 'spaced opener name rejected');
  assert.match(applyOpener({}, { name: '__PROTO__', command: 'x' }, true).error, /reserved/, 'opener lowercasing to __proto__ rejected');
  assert.match(applyOpener({}, { name: 'sub', command: ' ' }, true).error, /required/, 'empty command rejected');
  assert.deepEqual(applyOpener({ sub: 'subl', z: 'z' }, { name: 'sub', command: 'subl -n' }).apps, { sub: 'subl -n', z: 'z' }, 'command changed in place');
  assert.match(applyOpener({}, { name: 'nope', command: 'x' }).error, /No custom opener/, 'edit of unknown opener rejected');
});

test('startServer for the selector: onReady gets the link instead of printing it', async () => {
  const logged = [];
  const { log } = console;
  console.log = (...a) => logged.push(a.join(' '));
  let inner;
  const url = await new Promise((onReady, onError) => { inner = startServer({ port: 0, open: false, onReady, onError }); });
  console.log = log;
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{32}$/, 'onReady gets the link');
  assert.deepEqual(logged, [], 'nothing printed over the selector');
  assert.equal((await fetch(url)).status, 200, 'page served');
  inner.close();
  inner.closeAllConnections();
});

test('upex ui: token + host guard, add via API writes the store', async () => {
  const webHome = fs.mkdtempSync(path.join(os.tmpdir(), 'upex-web-'));
  // Fresh cache: no npm check spawns (it would hold the folder), and the page gets the newer version.
  fs.mkdirSync(path.join(webHome, '.upex'));
  fs.writeFileSync(path.join(webHome, '.upex', 'update.json'), JSON.stringify({ checked: Date.now(), latest: '99.0.0' }));
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
    const pageHtml = await (await fetch(link)).text();
    assert.ok(pageHtml.includes(`const TOKEN = '${token}'`), 'page carries the token');
    assert.ok(pageHtml.includes('data-theme="system" data-accent="default"') && !/__[A-Z]+__/.test(pageHtml), 'page has the appearance baked in');
    const webCfg = path.join(webHome, '.upex', 'config.json');
    const webCfgText = fs.readFileSync(webCfg, 'utf-8');
    fs.writeFileSync(webCfg, '{');
    assert.equal((await fetch(link)).status, 500, 'bad config.json: page gets an error, server stays up');
    fs.writeFileSync(webCfg, webCfgText);
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
    const { added: ghAdded, ...gh } = saved.gh;
    assert.deepEqual(gh, { url: 'github.com', tags: ['web'] }, 'api add written to store');
    assert.ok(ghAdded > 0, 'api add stamps added');
    const st = await (await fetch(base + '/api/state', { headers: { 'x-upex-token': token } })).json();
    assert.equal(st.links.find(l => l.name === 'gh').tab, 'apps', 'URL shortcut listed on the Apps tab');
    assert.deepEqual([st.version, st.update], [VERSION, { latest: '99.0.0', cmd: 'npm i -g @uplift-beyond/upex@latest' }], 'page gets the version and a newer one');
    const call = (method, route, body) => fetch(base + '/api/' + route, { method, headers: { 'content-type': 'application/json', 'x-upex-token': token }, body: JSON.stringify(body) });
    // a learned folder is offered as a shortcut until dismissed
    const tipDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upex-tip-'));
    fs.writeFileSync(path.join(webHome, '.upex', 'visits.json'), JSON.stringify({ [tipDir]: { uses: 3, lastUsed: Date.now() } }));
    const tipOf = async () => (await (await fetch(base + '/api/state', { headers: { 'x-upex-token': token } })).json()).suggest;
    assert.deepEqual(await tipOf(), { name: path.basename(tipDir), path: tipDir, uses: 3 }, 'a folder visited 3 times is suggested');
    assert.equal((await call('PUT', 'learned/hide', { path: '' })).status, 400, 'hide needs an absolute path');
    await call('PUT', 'learned/hide', { path: tipDir, hidden: true });
    assert.equal(await tipOf(), null, 'dismissed: not suggested again');
    await call('PUT', 'learned/hide', { path: tipDir, hidden: false });
    assert.equal((await tipOf())?.path, tipDir, 'undo brings the suggestion back');
    fs.rmSync(tipDir, { recursive: true, force: true });
    assert.equal((await call('PUT', 'archive', { name: 'gh', archived: true })).status, 200, 'archive via api');
    assert.equal((await call('PUT', 'archive', { name: 'gh', archived: true })).status, 409, 'no-op archive refused (its Undo would step back an older change)');
    assert.equal((await call('POST', 'undo', {})).status, 200, 'undo via api');
    assert.equal(JSON.parse(fs.readFileSync(path.join(webHome, '.upex', 'links.json'), 'utf-8')).gh.archived, undefined, 'api undo restores the archived one');
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
    const putSet = (body) => fetch(base + '/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-upex-token': token },
      body: JSON.stringify(body),
    });
    assert.equal((await putSet({ terminalLayout: 'nope' })).status, 400, 'bad layout refused');
    assert.equal((await putSet({ paneSplit: 'vertical', bogus: 1 })).status, 400, 'unknown setting refused');
    assert.equal((await putSet({ defaultOpener: 'nope' })).status, 400, 'unknown opener refused');
    assert.equal((await putSet({ defaultOpener: 'copy' })).status, 400, 'copy refused as default opener');
    assert.equal((await putSet({ sort: 'used' })).status, 400, 'bad sort refused');
    const put = (route, body) => fetch(base + '/api/' + route, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-upex-token': token }, body: JSON.stringify(body) });
    assert.equal((await putSet({ accent: '#00aaff', density: 'compact' })).status, 200, 'hex accent saved over the api');
    assert.equal((await put('settings/reset', { keys: ['bogus'] })).status, 400, 'reset refuses unknown keys');
    assert.equal((await put('settings/reset', { keys: ['accent'] })).status, 200, 'reset a section');
    const rs = JSON.parse(fs.readFileSync(path.join(webHome, '.upex', 'config.json'), 'utf-8'));
    assert.deepEqual([rs.accent, rs.density], [undefined, 'compact'], 'reset only the given keys');
    assert.deepEqual([(await put('last', { view: 'settings' })).status, (await put('last', { view: 'workspaces' })).status], [400, 200], 'last tab: settings refused, workspaces saved');
    assert.equal((await (await fetch(base + '/api/state', { headers: { 'x-upex-token': token } })).json()).startTab, 'shortcuts', 'last tab only used for start view last');
    assert.equal((await put('settings/reset', { keys: ['density'] })).status, 200, 'density back to default');
    assert.equal((await putSet({ terminalLayout: 'panes', paneSplit: 'horizontal', terminalShell: 'powershell', defaultOpener: 'code', startView: 'apps', sort: 'name' })).status, 200, 'settings saved');
    const cfg2 = JSON.parse(fs.readFileSync(path.join(webHome, '.upex', 'config.json'), 'utf-8'));
    assert.equal(cfg2.terminalLayout, 'panes', 'layout written to config');
    assert.equal(cfg2.paneSplit, 'horizontal', 'refused request saved nothing, later one did');
    assert.equal(cfg2.defaultOpener, 'vscode', 'default opener stored as its key');
    const st2 = await (await fetch(base + '/api/state', { headers: { 'x-upex-token': token } })).json();
    assert.deepEqual(st2.settings, { startView: 'apps', sort: 'name', terminalLayout: 'panes', paneSplit: 'horizontal', terminalShell: 'powershell', fullScreen: 'on', mouse: 'on', theme: 'system', accent: 'default', density: 'comfortable', paths: 'dim', keyHints: 'short', maxRows: 'auto', recentStrip: 'off', staleAfter: '60', views: 'all', enter: 'quit', numberKeys: 'off', confirmMany: '5', fuzzy: 'normal', searchIn: 'all', flash: '3', updateCheck: 'on', usage: 'off', rowDetails: 'both', pinned: 'top', groups: 'off', narrowPane: 'toggle', paneWidth: 'normal', goals: 'off', git: 'off', size: 'on', glyphs: 'unicode', defaultOpener: 'vscode' }, 'state reports settings');
    assert.deepEqual(Object.keys(cfg2.workspaces), ['work'], 'settings save keeps workspaces');
    const note = path.join(webHome, 'note.txt');
    fs.writeFileSync(note, '');
    await fetch(base + '/api/links', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-upex-token': token },
      body: JSON.stringify({ kind: 'folder', name: 'nt', target: note }),
    });
    const st3 = await (await fetch(base + '/api/state', { headers: { 'x-upex-token': token } })).json();
    assert.ok(st3.links.find(l => l.name === 'nt').file && !st3.links.find(l => l.name === 'gh').file, 'file shortcuts flagged (they skip the default opener)');
    const send = (method, route, body) => fetch(base + '/api/' + route, {
      method, headers: { 'content-type': 'application/json', 'x-upex-token': token }, body: JSON.stringify(body),
    });
    const webLinks = () => JSON.parse(fs.readFileSync(path.join(webHome, '.upex', 'links.json'), 'utf-8'));
    assert.equal((await send('PUT', 'pin', { name: 'gh', pinned: true })).status, 200, 'pin via api');
    assert.equal(webLinks().gh.pinned, true, 'pin stored via api');
    assert.equal((await send('PUT', 'pin', { name: 'gh', pinned: false })).status, 200, 'unpin via api');
    assert.equal(webLinks().gh.pinned, undefined, 'unpin clears the flag');
    assert.equal((await send('PUT', 'pin', { name: 'nope', pinned: true })).status, 404, 'pin unknown 404s');
    assert.equal((await send('PUT', 'archive', { name: 'gh', archived: true })).status, 200, 'archive via api');
    assert.equal((await send('POST', 'open', { name: 'gh' })).status, 404, 'archived shortcut cannot be opened');
    assert.equal((await send('PUT', 'archive', { name: 'gh', archived: false })).status, 200, 'restore via api');
    assert.equal(JSON.parse(fs.readFileSync(path.join(webHome, '.upex', 'links.json'), 'utf-8')).gh.archived, undefined, 'restore clears the flag');
    assert.equal((await send('POST', 'opener', { name: 'subl', command: 'subl' })).status, 200, 'opener added via api');
    assert.equal((await send('POST', 'opener', { name: 'SUBL', command: 'x' })).status, 400, 'duplicate opener refused');
    assert.equal((await send('PUT', 'opener', { name: 'subl', command: 'subl -n' })).status, 200, 'opener command changed via api');
    const st4 = await (await fetch(base + '/api/state', { headers: { 'x-upex-token': token } })).json();
    assert.deepEqual(st4.openers, [{ name: 'subl', command: 'subl -n' }], 'state lists custom openers');
    assert.ok(st4.apps.some(a => a.key === 'subl'), 'custom opener in opener menus');
    assert.equal((await send('DELETE', 'opener', { name: 'subl' })).status, 200, 'opener deleted via api');
    assert.equal((await send('DELETE', 'opener', { name: 'subl' })).status, 404, 'deleting a missing opener 404s');
    const cfg3 = JSON.parse(fs.readFileSync(path.join(webHome, '.upex', 'config.json'), 'utf-8'));
    assert.deepEqual([cfg3.apps, Object.keys(cfg3.workspaces)], [{}, ['work']], 'opener edits keep the rest of config');
    // scripts and goals on folder rows, run refuses what upex run would
    const pkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upex-pk-'));
    fs.writeFileSync(path.join(pkDir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite\n--open' } }));
    fs.writeFileSync(path.join(pkDir, 'goals.json'), JSON.stringify({ items: [{ id: 'a', title: 'A', status: 'done' }, { id: 'b', title: 'B', status: 'planned', phase: 'next' }] }));
    await send('POST', 'links', { kind: 'folder', name: 'pk', target: pkDir });
    const pkRow = async () => (await (await fetch(base + '/api/state', { headers: { 'x-upex-token': token } })).json()).links.find(l => l.name === 'pk');
    assert.deepEqual(await pkRow().then(l => [l.scripts, l.pm, l.goals]), [[['dev', 'vite --open']], 'npm', null], 'folder row lists its scripts, goals off by default');
    await send('PUT', 'settings', { goals: '3' });
    assert.deepEqual((await pkRow()).goals, { done: 1, total: 2, next: ['B'] }, 'goals setting puts open goals on the row');
    assert.equal((await send('POST', 'run', { name: 'pk', script: 'nope' })).status, 404, 'unknown script refused');
    assert.equal((await send('POST', 'run', { name: 'pk', script: 'constructor' })).status, 404, 'prototype key is no script');
    assert.equal((await send('POST', 'run', { name: 'gh', script: 'dev' })).status, 404, 'run needs a folder shortcut');
    // export / import: merge, counts, changed only when links.json changed, junk refused
    const exp = await (await send('GET', 'export')).json();
    assert.ok(exp.upex === 'bundle' && Object.hasOwn(exp.links, 'pk'), 'export gives the bundle');
    const imp = b => send('POST', 'import', { bundle: b });
    const imp1 = await (await imp({ upex: 'bundle', version: 1, links: { im: { url: 'example.com' } } })).json();
    assert.deepEqual([imp1.added, imp1.updated, imp1.changed], [['im'], [], true], 'import merges and reports');
    assert.ok(webLinks().pk && webLinks().im, 'import keeps the rest');
    assert.equal((await (await imp({ im: { url: 'example.com' } })).json()).changed, false, 'same import again changes nothing');
    for (const bad of [[1], { upex: 'bundle' }, { a: 5 }, 'x', { a: {} }, { a: { path: 5 } }, { a: { url: 'u', tags: 'y' } }]) assert.equal((await imp(bad)).status, 400, `junk bundle refused: ${JSON.stringify(bad)}`);
    // only the upex marker makes a bundle: a bare map may name shortcuts config and links
    const cfgText = fs.readFileSync(webCfg, 'utf-8');
    assert.deepEqual((await (await imp({ config: { url: 'example.org' }, links: { url: 'example.net' } })).json()).added, ['config', 'links'], 'bare map: config and links are shortcuts');
    assert.equal(fs.readFileSync(webCfg, 'utf-8'), cfgText, 'bare map leaves config.json alone');
    await imp({ upex: 'bundle', links: {}, config: { apps: 'xy', workspaces: { w: 5, v: [{ shortcut: 'pk' }] } } });
    const cfgImp = JSON.parse(fs.readFileSync(webCfg, 'utf-8'));
    assert.deepEqual([cfgImp.apps, Object.keys(cfgImp.workspaces)], [{}, ['work', 'v']], 'bundle config: only maps merge, workspaces as lists');
    // hand-edited entries: no path keeps the page up, path plus url is no folder to run in
    fs.writeFileSync(path.join(webHome, '.upex', 'links.json'), JSON.stringify({ ...webLinks(), bare: { tags: [] }, both: { path: pkDir, url: 'example.com' } }));
    assert.equal((await send('GET', 'state')).status, 200, 'entry without a path keeps state up');
    assert.equal((await send('POST', 'run', { name: 'both', script: 'dev' })).status, 404, 'run skips a url shortcut with a path');
    const stats = await (await send('GET', 'stats')).json();
    assert.deepEqual([stats.total, stats.top, stats.perWeek.length], [0, [], 8], 'stats with no opens');
    fs.rmSync(pkDir, { recursive: true, force: true });
  } finally {
    // Already exited (e.g. crashed on start): waiting for 'exit' again would never settle.
    if (srv.exitCode === null && srv.signalCode === null) {
      srv.kill();
      await new Promise((r) => srv.once('exit', r));
    }
    fs.rmSync(webHome, { recursive: true, force: true });
  }
});
