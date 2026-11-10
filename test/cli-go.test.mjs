import { home, cli, run } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadHistory, bumpVisit, learnedFolders, loadVisits } from '../src/store.js';
import { installCmdWrapper } from '../src/commands/setup.js';

// CLI runs against this file's temp home. The tests below build on each other, in order.
const linksFile = path.join(home, '.upex', 'links.json');
fs.mkdirSync(path.dirname(linksFile), { recursive: true });
const upexIn = (...args) => run(args);
const now = Date.now();
// Real path: macOS's tmpdir is under the /var symlink and pwd prints /private/var.
const target = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'upex-target-')));
const stored = () => JSON.parse(fs.readFileSync(linksFile, 'utf-8'));

test('a failed open prints why and returns false, never exits (group, workspace, selector and upex ui opens)', async () => {
  const openUrl = new URL('../src/commands/open.js', import.meta.url).href;
  const code = `import { handleOpen } from '${openUrl}'; process.stdout.write(String(await handleOpen('nope', undefined, 1, '', { here: false }))); process.exit(7);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf-8', env: { ...process.env, USERPROFILE: home, HOME: home } });
  assert.equal(r.status, 7, 'failed open does not exit');
  assert.ok(r.stdout.endsWith('false'), 'failed open returns false');
  assert.match(r.stderr, /Shortcut not found: nope/, 'failed open says why');
});

test('go with args: runs the command inside the shortcut folder', () => {
  fs.writeFileSync(linksFile, JSON.stringify({ t: { path: target } }));
  const g = upexIn('go', 't', process.platform === 'win32' ? 'cd' : 'pwd');
  assert.equal(g.status, 0, 'go with args exits 0');
  assert.equal(g.stdout.trim(), target, 'command runs in the shortcut folder');
  assert.deepEqual(loadHistory(path.join(home, '.upex', 'history.jsonl')).map(h => [h.name, h.opener]), [['t', 'cd']], 'an open is logged with its opener');
  const statsOut = upexIn('stats');
  assert.equal(statsOut.status, 0, 'stats runs');
  assert.match(statsOut.stdout, /cd\s+1/, 'stats shows the opener count');
});

test('cd: a path first, else a shortcut; a file gives its folder', () => {
  fs.writeFileSync(path.join(target, 'f.txt'), '');
  assert.equal(upexIn('cd', target).stdout, target, 'cd prints an existing path');
  assert.equal(upexIn('cd', path.join(target, 'f.txt')).stdout, target, 'cd on a file prints its folder');
  assert.equal(upexIn('cd', 't').stdout, target, 'cd falls back to a shortcut');
  // --json and --dry-run round-trips.
  const json = (...args) => JSON.parse(upexIn(...args).stdout);
  assert.deepEqual(json('go', 't', '--json'), { name: 't', path: target }, 'go --json (trailing)');
  assert.deepEqual(json('go', '--json', 't'), { name: 't', path: target }, 'go --json (leading)');
  assert.equal(upexIn('go', '--json', 'zzqqxx').status, 1, 'go --json miss exits 1');
  assert.deepEqual(json('tag', 't', 'x', '--json'), { name: 't', tags: ['x'] }, 'tag add --json');
  assert.deepEqual(json('tag', '--json'), { x: 1 }, 'tag --json counts');
  assert.deepEqual(json('list', 'x', '--json').map(e => [e.name, e.path, e.exists]), [['t', target, true]], 'list --json');
  assert.ok(json('doctor', '--json').some(r => r.check === 'store' && r.status === 'ok'), 'doctor --json');
  upexIn('tag', 't', '--clear');
  const usesBefore = json('list', '--json')[0].uses;
  // Before go, --dry-run also covers its command.
  const dry = upexIn('--dry-run', 'go', 't', 'node', '-v');
  assert.equal(dry.status, 0, 'dry run exits 0');
  assert.match(dry.stdout, /^node -v {3}\(in /, 'dry run prints the go command');
  assert.match(dry.stderr, /dry run, nothing ran/, 'dry run footer on stderr');
  upexIn('rm', 't', '--dry-run');
  assert.deepEqual(json('list', '--json').map(e => [e.name, e.uses]), [['t', usesBefore]], 'dry run saves nothing, records no use');
  const cdMiss = upexIn('cd', 'zzqqxx-nope');
  assert.equal(cdMiss.status, 1, 'cd on nothing fails');
  assert.match(cdMiss.stderr, /No such folder or shortcut/, 'cd says what is missing');
  assert.match(upexIn('cd', 't', 'nope-opener').stderr, /Unknown app/, 'cd rejects an unknown opener');
  assert.ok(!loadHistory(path.join(home, '.upex', 'history.jsonl')).some(h => h.opener === 'nope-opener'), 'a failed cd open is not logged');
});

test('upex <path>: opens without a shortcut; a lone path never cds through a wrapper', () => {
  const keep = fs.readFileSync(linksFile, 'utf-8');
  fs.writeFileSync(linksFile, JSON.stringify({ '.dotfiles': { path: target } }));
  const res = upexIn('__resolve', '.');
  assert.equal(res.status, 1, '__resolve . does not fuzzy-match .dotfiles');
  assert.equal(res.stdout, '', 'no path for the wrapper to cd into');
  assert.match(upexIn(path.join(target, 'nope')).stderr, /No such file or folder/, 'a missing path fails');
  assert.match(upexIn(target, 'nope-opener').stderr, /Unknown app/, 'a path rejects an unknown opener');
  fs.writeFileSync(linksFile, keep);
});

test('learned folders: cd on a plain path counts a visit, cd <name> jumps to the most used one', () => {
  const P = os.platform() === 'win32' ? 'C:\\w\\' : '/w/';
  const all = () => true;
  let v = bumpVisit({}, `${P}site`, 1000);
  v = bumpVisit(v, os.platform() === 'win32' ? 'c:\\W\\SITE\\' : `${P}site/`, 2000);
  assert.deepEqual(v, { [`${P}site`]: { uses: 2, lastUsed: 2000 } }, 'same folder counts once, first spelling kept');
  v = { ...v, [`${P}site`]: { uses: 2, lastUsed: 2000, hidden: true } };
  assert.equal(bumpVisit(v, `${P}site`, 3000)[`${P}site`].hidden, true, 'a visit keeps the dismissal');
  const busy = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`${P}d${i}`, { uses: 50, lastUsed: 1000 + i }]));
  const kept = bumpVisit(busy, `${P}new`, 5000);
  assert.ok(Object.hasOwn(kept, `${P}new`) && !Object.hasOwn(kept, `${P}d0`) && Object.keys(kept).length < 400, 'full: a new folder stays, the least recent go');
  const visits = { [`${P}website`]: { uses: 9, lastUsed: now }, [`${P}site`]: { uses: 1, lastUsed: now }, [`${P}gone`]: { uses: 5, lastUsed: now }, [`${P}has`]: { uses: 5, lastUsed: now }, [`${P}shy`]: { uses: 5, lastUsed: now, hidden: true } };
  const links = { h: { path: `${P}has` } };
  const names = opts => learnedFolders(visits, links, { exists: p => !p.endsWith('gone'), ...opts }).map(f => f.name);
  assert.deepEqual(names(), ['website', 'shy', 'site'], 'most used first; gone folders and ones with a shortcut left out');
  assert.deepEqual(names({ query: 'SITE' }), ['site', 'website'], 'query matches the folder name, an exact name first');
  assert.deepEqual(names({ suggest: true }), ['website'], 'suggested: 3+ visits and not dismissed');
  assert.deepEqual(learnedFolders(visits, {}, { exists: all, query: 'has' }).map(f => f.path), [`${P}has`], 'without links (cd) a shortcut folder still matches');

  const visitsFile = path.join(home, '.upex', 'visits.json');
  const seen = () => loadVisits(visitsFile);
  assert.deepEqual(Object.keys(seen()), [target], 'cd on a path was learned, cd on a shortcut name was not');
  const plain = fs.mkdtempSync(path.join(target, 'zzlearn-'));
  upexIn('cd', plain);
  upexIn('cd', plain);
  assert.equal(upexIn('cd', 'zzlearn').stdout, plain, 'cd <name> jumps to the learned folder');
  assert.equal(seen()[plain].uses, 3, 'a jump counts as a visit');
  upexIn('cd', home);
  assert.ok(!Object.keys(seen()).includes(home), 'the home folder is not learned');
  const learnedOut = upexIn('learned').stdout;
  assert.ok(learnedOut.includes(path.basename(plain)) && learnedOut.includes('3 visits'), 'learned lists the folder with its visits');
  assert.equal(learnedOut.split('\n').filter(l => /\d visits?,/.test(l)).length, 1, 'a folder with a shortcut (t) is not listed');
  fs.writeFileSync(visitsFile, '{broken');
  assert.equal(upexIn('cd', plain).stdout, plain, 'a broken visits file never breaks cd');
  assert.equal(seen()[plain].uses, 1, 'and is started over');
  assert.equal(upexIn('learned', '--clear').status, 0, 'learned --clear runs');
  assert.deepEqual(seen(), {}, 'clear forgets every folder');
  assert.equal(upexIn('cd', 'zzlearn').status, 1, 'nothing learned: cd <name> fails again');
});

test('cmd.exe wrapper: a trailing \\ must not escape the quote it adds', () => {
  if (process.platform === 'win32') {
    const shim = fs.mkdtempSync(path.join(os.tmpdir(), 'upex-shim-'));
    fs.writeFileSync(path.join(shim, 'upex.cmd'), `@"${process.execPath}" "${cli}" %*\r\n`);
    const w = spawnSync('cmd.exe', ['/d', '/s', '/c', `"cd /d "${target}" & call "${installCmdWrapper(shim)}" cd ..\\ & cd"`], { encoding: 'utf-8', windowsVerbatimArguments: true, env: { ...process.env, USERPROFILE: home, HOME: home } });
    assert.equal(w.stdout.trim(), path.dirname(target), 'cmd wrapper cds into ..\\');
    fs.rmSync(shim, { recursive: true, force: true });
  }
  fs.rmSync(path.join(target, 'f.txt'));
});

test('upex config: get/set round-trip, bad values refused without saving', () => {
  assert.equal(upexIn('config', 'get', 'terminalLayout').stdout.trim(), 'here', 'config get prints the default');
  assert.equal(upexIn('config', 'set', 'terminalLayout', 'tabs').status, 0, 'config set saves');
  assert.equal(upexIn('config', 'get', 'terminalLayout').stdout.trim(), 'tabs', 'config get reads it back');
  assert.equal(upexIn('config', 'set', 'defaultOpener', 'code').status, 0, 'opener alias accepted');
  assert.equal(upexIn('config', 'get', 'defaultOpener').stdout.trim(), 'vscode', 'opener stored as its key');
  assert.equal(upexIn('config', 'set', 'terminalLayout', 'nope').status, 1, 'bad value refused');
  assert.equal(upexIn('config', 'set', 'bogus', 'x').status, 1, 'unknown setting refused');
  assert.equal(upexIn('config', 'get', 'bogus').status, 1, 'unknown setting get refused');
  assert.equal(upexIn('config', 'get', 'terminalLayout').stdout.trim(), 'tabs', 'refused sets saved nothing');
  assert.match(upexIn('config').stdout, /terminalLayout\s+tabs · here, windows/, 'config lists settings with options');
  assert.equal(upexIn('config', 'set', 'accent', 'FF66AA').status, 0, 'hex accent without # accepted');
  assert.equal(upexIn('config', 'get', 'accent').stdout.trim(), '#ff66aa', 'hex accent stored as #rrggbb');
  assert.equal(upexIn('config', 'reset', 'accent').status, 0, 'config reset one');
  assert.deepEqual([upexIn('config', 'get', 'accent').stdout.trim(), upexIn('config', 'get', 'terminalLayout').stdout.trim()], ['default', 'tabs'], 'reset one leaves the others');
  assert.equal(upexIn('config', 'reset', 'bogus').status, 1, 'reset unknown setting refused');
  assert.equal(upexIn('config', 'reset').status, 0, 'config reset all');
  assert.deepEqual([upexIn('config', 'get', 'terminalLayout').stdout.trim(), upexIn('config', 'get', 'defaultOpener').stdout.trim()], ['here', 'explorer'], 'reset all = defaults');
  {
    const cfgFile = path.join(home, '.upex', 'config.json');
    const cfgText = fs.readFileSync(cfgFile, 'utf-8');
    assert.match(upexIn('help').stdout, /Settings\n\s+startView/, 'help shows the settings');
    fs.writeFileSync(cfgFile, '{');
    const bad = upexIn('help');
    assert.ok(bad.status === 0 && bad.stdout.includes('Settings unavailable'), 'help survives a broken config.json');
    fs.writeFileSync(cfgFile, cfgText);
  }
  assert.equal(upexIn('stats', '--days', '0').status, 1, 'bad --days rejected');
});

test('subpaths: go prints a folder inside the shortcut, missing subfolder fails', () => {
  fs.mkdirSync(path.join(target, 'sub'));
  assert.equal(upexIn('go', 't/sub').stdout, path.join(target, 'sub'), 'go resolves a subpath');
  assert.equal(upexIn('go', 't/nope').status, 1, 'missing subpath fails');
});

test('default opener: set, reject unknown, reject on URL, clear', () => {
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
});

test('doctor: Documents folder from a reg export (wrapped hex(2), non-ASCII, %VAR%)', async () => {
  const { documentsFrom } = await import('../src/commands/doctor.js');
  const hex = [...Buffer.from('%USERPROFILE%\\Dökumente\0', 'utf16le')].map(b => b.toString(16).padStart(2, '0'));
  const reg = `\uFEFFWindows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\X]\r\n"Personal"=hex(2):${hex.slice(0, 20).join(',')},\\\r\n  ${hex.slice(20).join(',')}\r\n"Other"="x"\r\n`;
  assert.equal(documentsFrom(reg, { USERPROFILE: 'C:\\Users\\jé' }), 'C:\\Users\\jé\\Dökumente', 'documents from hex(2)');
  assert.equal(documentsFrom('"Personal"="D:\\\\Docs"\r\n'), 'D:\\Docs', 'documents from a plain string');
  assert.equal(documentsFrom('"Other"="x"\r\n'), null, 'no Personal value');
});

test('doctor: healthy store passes, a corrupt one fails', () => {
  const doc = upexIn('doctor');
  assert.equal(doc.status, 0, 'doctor passes on a good store');
  assert.ok(doc.stdout.includes('1 shortcut'), 'doctor reports the store');
  fs.rmSync(target, { recursive: true, force: true });
  assert.match(upexIn('doctor').stdout, /broken shortcut: t/, 'doctor flags a broken path');
});

test('npm test runs every test file', () => {
  const script = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8')).scripts.test;
  for (const f of fs.readdirSync(new URL('.', import.meta.url)).filter(f => f.endsWith('.test.mjs'))) assert.ok(script.includes(`test/${f}`), `${f} is in npm test`);
});
