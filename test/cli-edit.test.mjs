import { home, cli, run } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkEntry } from '../src/store.js';
import { fastPath } from '../src/fast.js';

// CLI runs against this file's temp home. The tests below build on each other, in order.
const linksFile = path.join(home, '.upex', 'links.json');
fs.mkdirSync(path.dirname(linksFile), { recursive: true });
const upexIn = (...args) => run(args);
const fastUrl = new URL('../src/fast.js', import.meta.url).href;
const stored = () => JSON.parse(fs.readFileSync(linksFile, 'utf-8'));
let proj;

test('store: a corrupt links.json is never overwritten, a BOM is tolerated', () => {
  const broken = '{"keep": {"path": "X"},';
  fs.writeFileSync(linksFile, broken);
  assert.equal(upexIn('add', 'new', home).status, 1, 'corrupt store fails the command');
  assert.equal(fs.readFileSync(linksFile, 'utf-8'), broken, 'corrupt store is left untouched');
  assert.equal(upexIn('doctor').status, 1, 'doctor fails on a corrupt store');
  fs.writeFileSync(linksFile, '\uFEFF' + JSON.stringify({ gh: { url: 'github.com' } }));
  assert.equal(upexIn('edit', 'gh', 'gitlab.com').status, 0, 'BOM-prefixed store loads');
  assert.equal(JSON.parse(fs.readFileSync(linksFile, 'utf-8')).gh.url, 'gitlab.com', 'edit replaces a URL target');
  assert.ok(!fs.readdirSync(path.dirname(linksFile)).some(f => f.endsWith('.tmp')), 'save leaves no temp file');
});

test('entries: wrong types are coerced or dropped, an entry without a target is skipped but kept on disk', () => {
  assert.deepEqual(checkEntry({ path: 'X', uses: '5', tags: 'a', pinned: 'true', note: 3, opener: null }),
    { entry: { path: 'X', uses: 5, tags: ['a'], pinned: true, note: '3' }, issues: ['note fixed', 'tags fixed', 'uses fixed', 'pinned fixed'] }, 'coerce fields');
  assert.deepEqual(checkEntry({ url: 'u', lastUsed: 'soon', aliases: [1, 'a'] }).entry, { url: 'u', aliases: ['a'] }, 'drop uncoercible, keep good list items');
  assert.equal(checkEntry({ path: ['X'] }).entry, null, 'array path leaves no target');
  assert.equal(checkEntry([]).entry, null, 'array entry is no shortcut');
  assert.deepEqual(checkEntry('X'), { entry: { path: 'X' }, issues: [] }, 'legacy string is fine');
  fs.writeFileSync(linksFile, JSON.stringify({ bad: { path: ['X'] }, ok: { path: home, uses: '2' } }));
  const warned = upexIn('add', 'fresh', home);
  assert.equal(warned.status, 0, 'a bad entry does not break a save');
  assert.match(warned.stderr, /2 bad entries/, 'load warns once');
  assert.deepEqual(stored().bad, { path: ['X'] }, 'skipped entry kept on save');
  assert.equal(stored().ok.uses, 2, 'coerced field saved');
  assert.match(upexIn('doctor').stdout, /bad: path dropped, no path, app or url \(skipped\)/, 'doctor names the entry and field');
  assert.equal(upexIn('__names').stderr, '', 'hidden commands stay quiet');
  const bakDir = path.join(home, '.upex', 'backups');
  fs.writeFileSync(linksFile, JSON.stringify({ g: { path: home, url: ['dropme'] } }));
  upexIn('go', 'g');
  assert.ok(!('url' in stored().g) && fs.readdirSync(bakDir).some(f => fs.readFileSync(path.join(bakDir, f), 'utf-8').includes('dropme')), 'an open that drops a field backs up the hand edit first');
  fs.writeFileSync(linksFile, '{}');
  upexIn('add', 'u1', home);
  fs.writeFileSync(linksFile, JSON.stringify({ ...stored(), hand: { pth: 'x' } }));
  upexIn('undo');
  assert.deepEqual(stored(), { hand: { pth: 'x' } }, 'undo keeps a hand-added skipped entry');
  const bundleFile = path.join(home, 'bundle.json');
  fs.writeFileSync(bundleFile, JSON.stringify({ n: { url: 'example.com' } }));
  upexIn('import', bundleFile, '--replace');
  assert.deepEqual(Object.keys(stored()), ['n'], 'import --replace drops skipped entries too');
  upexIn('undo');
  assert.ok(stored().hand, 'undo brings them back');
  fs.rmSync(bundleFile);
});

test('prototype names are real names; a workspace with a failing entry exits 1', () => {
  fs.writeFileSync(linksFile, JSON.stringify({}));
  assert.equal(upexIn('add', 'constructor', home).status, 0, '"constructor" can be added');
  assert.equal(upexIn('add', 'has space', home).status, 1, 'names with spaces rejected');
  upexIn('ws', 'add', 'w', 'nope');
  assert.equal(upexIn('ws', 'w').status, 1, 'failed workspace entry exits 1');
  assert.equal(upexIn('ws', 'toString').status, 1, 'prototype workspace name is not found');
});

test('auto-backup: 12 saves keep the newest 10, newest holds the previous file; opens don\'t back up', () => {
  const backupDir = path.join(home, '.upex', 'backups');
  fs.rmSync(backupDir, { recursive: true, force: true });
  for (let i = 0; i < 12; i++) upexIn('add', `b${i}`, home);
  const backups = () => fs.readdirSync(backupDir).sort();
  assert.equal(backups().length, 10, 'only the newest 10 backups are kept');
  const mine = path.join(backupDir, 'links-0-mine.json');
  fs.writeFileSync(mine, '{}');
  const prev = fs.readFileSync(linksFile, 'utf-8');
  upexIn('add', 'b12', home);
  assert.equal(fs.readFileSync(path.join(backupDir, backups().at(-1)), 'utf-8'), prev, 'newest backup is the previous file');
  assert.ok(fs.existsSync(mine), 'pruning skips files it did not name');
  const before = backups();
  assert.equal(upexIn('go', 'b0').status, 0, 'go works');
  assert.deepEqual(backups(), before, 'usage bumps make no backup');
  assert.equal(upexIn('edit', 'b0', home).status, 0, 'edit works');
  assert.deepEqual(backups(), before, 'a no-op save makes no backup');
});

test('aliases + archive: an alias works like the name, archived ones hide until restored', async () => {
  fs.writeFileSync(linksFile, JSON.stringify({ velora: { path: home }, other: { path: home } }));
  assert.equal(upexIn('alias', 'velora', 'vd', 'v2').status, 0, 'aliases added');
  assert.deepEqual(stored().velora.aliases, ['vd', 'v2'], 'aliases stored');
  assert.equal(upexIn('go', 'vd').stdout, home, 'go follows an alias');
  assert.equal(upexIn('alias', 'other', 'vd').status, 1, 'alias owned by another shortcut rejected');
  upexIn('add', 'v2', home);
  assert.ok(!stored().v2, 'add refuses a name that is an alias');
  assert.equal(upexIn('add', 'x', home, '--alias', 'other').status, 1, 'add --alias clash rejected');
  assert.equal(upexIn('rename', 'vd', 'vel').status, 0, 'rename via alias');
  assert.ok(stored().vel && !stored().velora, 'alias rename renames the real shortcut');
  assert.equal(upexIn('rm', 'vel', '--archive').status, 0, 'archive');
  assert.equal(stored().vel.archived, true, 'archived flag stored');
  assert.equal(upexIn('go', 'vd').status, 1, 'archived shortcut no longer resolves');
  assert.ok(!upexIn('__names').stdout.includes('v'), 'archived names and aliases hidden from completion');
  {
    const names = code => spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf-8', env: { ...process.env, USERPROFILE: home, HOME: home } });
    const fast = names(`import { fastPath } from '${fastUrl}'; if (!fastPath(['__names'])) process.exit(7);`);
    const full = names(`import { createProgram } from '${new URL('../src/index.js', import.meta.url).href}'; await (await createProgram()).parseAsync(['node', 'upex', '__names']);`);
    assert.ok(fast.status === 0 && fast.stdout && fast.stdout === full.stdout, '__names: fast path prints what the command does');
    assert.equal(fastPath(['__names', '']), false, '__names with an arg (even empty) is left to commander');
  }
  assert.match(upexIn('ls', '--archived').stdout, /vel/, 'ls --archived lists it');
  assert.equal(upexIn('restore', 'v2').status, 0, 'restore via alias');
  assert.equal(upexIn('go', 'vd').stdout, home, 'restored shortcut resolves again');
});

test('temporary + stale: add --ttl stores expires, any command archives it once passed, restore clears it', () => {
  fs.writeFileSync(linksFile, JSON.stringify({ old: { path: home, lastUsed: 1 } }));
  assert.equal(upexIn('add', 'tmp', home, '--ttl', 'soon').status, 1, 'garbage --ttl rejected');
  assert.equal(upexIn('add', 'tmp', home, '--ttl', '7d').status, 0, 'add --ttl');
  const tmp = stored().tmp;
  assert.ok(tmp.added > 0 && Math.abs(tmp.expires - tmp.added - 7 * 86400000) < 1000, 'added + expires stored');
  assert.match(upexIn('ls').stdout, /left/, 'ls shows time left');
  const staleOut = upexIn('stale');
  assert.match(staleOut.stdout, /^\s+old\s/m, 'old shortcut reported stale');
  assert.doesNotMatch(staleOut.stdout, /^\s+tmp\s/m, 'just-added shortcut is not stale');
  assert.equal(stored().old.archived, undefined, 'non-TTY stale only lists');
  assert.equal(upexIn('stale', '--yes').status, 0, 'stale --yes');
  assert.equal(stored().old.archived, true, 'stale --yes archives');
  fs.writeFileSync(linksFile, JSON.stringify({ ...stored(), tmp: { ...stored().tmp, expires: 1 } }));
  for (const cmd of ['go', '__resolve']) {
    const r = upexIn(cmd, 'tmp');
    assert.equal(r.status, 1, `${cmd} refuses an expired shortcut`);
    assert.equal(r.stdout, '', `${cmd} prints no path`);
  }
  assert.equal(stored().tmp.archived, undefined, 'go/__resolve leave the archiving to the next command');
  const swept = upexIn('ls');
  assert.match(swept.stderr, /archived expired: tmp/, 'expired notice on stderr');
  assert.doesNotMatch(swept.stdout, /^\s+tmp\s/m, 'expired shortcut hidden from ls');
  assert.equal(upexIn('restore', 'tmp').status, 0, 'restore expired');
  assert.equal(upexIn('ls').stderr, '', 'restored shortcut is not re-archived');
  assert.equal(stored().tmp.expires, undefined, 'restore drops expires');
  fs.writeFileSync(linksFile, JSON.stringify({ ['n'.repeat(30)]: { path: path.join(home, 'p'.repeat(90)), tags: ['t'] } }));
  const piped = upexIn('ls').stdout;
  assert.ok(piped.includes('n'.repeat(30)) && piped.includes('p'.repeat(90)), 'piped ls clips no name or path');
});

test('add with no name / ".", pin, undo', () => {
  fs.writeFileSync(linksFile, '{}');
  fs.rmSync(path.join(home, '.upex', 'backups'), { recursive: true, force: true });
  fs.mkdirSync(path.join(home, 'my proj'));
  // macOS reports the cwd as /private/var/..., so compare against the real path.
  proj = fs.realpathSync(path.join(home, 'my proj'));
  const addHere = (...args) => spawnSync(process.execPath, [cli, 'add', ...args], { encoding: 'utf-8', cwd: proj, env: { ...process.env, USERPROFILE: home, HOME: home } });
  assert.equal(addHere().status, 0, 'add with no name');
  assert.equal(stored()['my-proj'].path, proj, 'no name = cwd under its folder name, spaces as dashes');
  assert.equal(addHere('.', home).status, 0, 'add . <path>');
  assert.equal(stored()[path.basename(home)].path, home, '". <path>" names it after that folder');
  assert.equal(addHere('.').status, 0, 'add . again only warns');
  assert.equal(Object.keys(stored()).length, 2, 'taken default name is not overwritten');
  assert.equal(addHere('.', 'notepad', '--app').status, 1, '"." is no name for an app shortcut');
  assert.equal(stored()['.'], undefined, 'no shortcut named "."');
  assert.equal(upexIn('pin', 'my-proj').status, 0, 'pin');
  assert.equal(stored()['my-proj'].pinned, true, 'pin stored');
  assert.match(upexIn('pin').stdout, /Pinned: my-proj/, 'pin lists pinned');
  assert.equal(upexIn('pin', 'nope').status, 1, 'pin unknown fails');
  assert.equal(upexIn('unpin', 'my-proj').status, 0, 'unpin');
  assert.equal(stored()['my-proj'].pinned, undefined, 'unpin drops the flag');
  fs.writeFileSync(linksFile, JSON.stringify({ ...stored(), 'my-proj': { ...stored()['my-proj'], uses: 7, lastUsed: 5 } }));
  assert.equal(upexIn('rm', 'my-proj').status, 0, 'rm');
  let u = upexIn('undo');
  assert.match(u.stdout, /brought back: my-proj/, 'undo reports what came back');
  assert.equal(stored()['my-proj'].path, proj, 'undo restores the removed shortcut');
  u = upexIn('undo');
  assert.match(u.stdout, /reverted: my-proj/, 'second undo steps further back (the unpin)');
  assert.equal(stored()['my-proj'].pinned, true, 'undo of unpin re-pins');
  assert.equal(stored()['my-proj'].uses, 7, 'undo keeps usage stats');
  upexIn('undo'); upexIn('undo'); upexIn('undo');
  assert.deepEqual(stored(), {}, 'undo all the way back to empty');
  assert.match(upexIn('undo').stdout, /Nothing to undo/, 'nothing left to undo');
});

test('workspace undo: one timeline with shortcuts, a delete comes back, settings make no backup or get undone', () => {
  const whome = fs.mkdtempSync(path.join(os.tmpdir(), 'upex-wsundo-'));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf-8', env: { ...process.env, USERPROFILE: whome, HOME: whome } });
  const dir = path.join(whome, '.upex');
  const read = f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
  const baks = () => fs.readdirSync(path.join(dir, 'backups')).sort();
  run('add', 'a', whome);
  run('ws', 'add', 'dev', 'a');
  run('add', 'b', whome);
  run('ws', 'rm', 'dev');
  assert.deepEqual(read('config.json').workspaces, {}, 'ws rm deletes');
  assert.equal(baks().filter(f => f.startsWith('workspaces-')).length, 2, 'each workspace change backs up the old map');
  const before = baks();
  assert.equal(run('config', 'set', 'sort', 'name').status, 0, 'config set');
  assert.deepEqual(baks(), before, 'a settings-only save makes no backup');
  fs.writeFileSync(path.join(dir, 'links.json'), JSON.stringify({ ...read('links.json'), a: { ...read('links.json').a, uses: 4, lastUsed: 9 } }));
  let r = run('undo');
  assert.match(r.stdout, /Undid the workspace change/, 'newest step is the workspace delete');
  assert.match(r.stdout, /brought back: dev/, 'it names the workspace');
  assert.deepEqual(read('config.json').workspaces.dev, [{ shortcut: 'a' }], 'deleted workspace restored');
  assert.equal(read('config.json').sort, 'name', 'a workspace undo keeps settings');
  r = run('undo');
  assert.match(r.stdout, /removed: b/, 'then the shortcut add before it');
  assert.equal(read('links.json').a.uses, 4, 'usage stats stay');
  r = run('undo');
  assert.match(r.stdout, /workspace change[\s\S]*removed: dev/, 'then the workspace add');
  r = run('undo');
  assert.deepEqual([read('links.json'), read('config.json').workspaces], [{}, {}], 'back to the start');
  assert.match(run('undo').stdout, /Nothing to undo/, 'both kinds used up');
  fs.rmSync(whome, { recursive: true, force: true });
});

test('note: set (words joined), show, clear', () => {
  upexIn('add', 'n1', proj);
  assert.equal(upexIn('note', 'n1', 'react', ' app').status, 0, 'note sets');
  assert.equal(stored().n1.note, 'react app', 'note joins words, one line');
  assert.match(upexIn('note', 'n1').stdout, /react app/, 'note shows');
  upexIn('note', 'n1', '--clear');
  assert.equal(stored().n1.note, undefined, 'note --clear drops it');
  assert.equal(upexIn('note', 'nope', 'x').status, 1, 'note on unknown fails');
});
