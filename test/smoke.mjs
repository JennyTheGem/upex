/**
 * smoke.mjs -- Minimal asserts for the non-trivial logic: frecency + prune.
 * Run: npm test
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { frecency, pruneBroken, mergeLinks, lastUsedName } from '../src/store.js';
import { installCmdWrapper } from '../src/commands/setup.js';
import { normalizeUrl } from '../src/launcher.js';
import { parseTags } from '../src/commands/add.js';

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

// -- go with args: runs the command inside the shortcut folder --
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'upex-home-'));
const target = fs.mkdtempSync(path.join(os.tmpdir(), 'upex-target-'));
fs.mkdirSync(path.join(home, '.upex'), { recursive: true });
fs.writeFileSync(path.join(home, '.upex', 'links.json'), JSON.stringify({ t: { path: target } }));
const pwd = process.platform === 'win32' ? 'cd' : 'pwd';
const g = spawnSync(process.execPath, [cli, 'go', 't', pwd], {
  encoding: 'utf-8',
  env: { ...process.env, USERPROFILE: home, HOME: home },
});
assert.equal(g.status, 0, 'go with args exits 0');
assert.equal(g.stdout.trim(), target, 'command runs in the shortcut folder');
fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(target, { recursive: true, force: true });

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

console.log('ok - frecency + prune + cmd wrapper + resolve guard + go args + merge + lastUsed + url + tags');
