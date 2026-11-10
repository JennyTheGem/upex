import { cli } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { frecency, statsFrom, loadHistory, pruneBroken, staleLinks, sweepExpired, mergeLinks, lastUsedName, diffLinks, keepUsage } from '../src/store.js';
import { parseDuration, parseTags, defaultName } from '../src/commands/add.js';
import { span } from '../src/ui.js';

const now = Date.now();

test('frecency: recent + used beats old + unused; unused = 0', () => {
  const recent = frecency({ uses: 1, lastUsed: now });
  const old = frecency({ uses: 1, lastUsed: now - 30 * 86400000 });
  const never = frecency({});
  assert.ok(recent > old, 'recent use should outrank old use');
  assert.ok(old > never, 'any use should outrank never-used');
  assert.equal(never, 0, 'never-used scores 0');
  assert.ok(frecency({ uses: 10, lastUsed: now - 86400000 }) > recent, 'more uses ranks higher');
});

test('stats: window, ranking, per-week buckets; history read skips junk', () => {
  const D = 86400000;
  const hist = [
    { ts: now - 1 * D, name: 'a', opener: 'vscode' },
    { ts: now - 2 * D, name: 'b', opener: 'cd' },
    { ts: now - 3 * D, name: 'a', opener: 'cd' },
    { ts: now - 10 * D, name: 'b', opener: 'cd' },
    { ts: now - 40 * D, name: 'old', opener: 'explorer' },
    { ts: now - 3 * D, name: 'c' },
  ];
  const s = statsFrom(hist, { since: now - 30 * D, now });
  assert.equal(s.total, 5, 'only opens inside the window count');
  assert.deepEqual(s.shortcuts, [['a', 2], ['b', 2], ['c', 1]], 'ranked by count, then name');
  assert.deepEqual(s.openers, [['cd', 3], ['vscode', 1]], 'openers ranked, missing opener skipped');
  assert.deepEqual(s.perWeek, [0, 0, 1, 0, 0, 0, 1, 4], 'opens per week, oldest first');
  assert.equal(statsFrom(hist, { now }).total, 6, 'no since = all time');
  assert.deepEqual(statsFrom([], { now }).perWeek, Array(8).fill(0), 'empty history');

  const hdir = fs.mkdtempSync(path.join(os.tmpdir(), 'upex-hist-'));
  const hfile = path.join(hdir, 'history.jsonl');
  assert.deepEqual(loadHistory(hfile), [], 'missing history file = []');
  fs.writeFileSync(hfile, '{"ts":1,"name":"a","opener":"cd"}\r\nnot json\n{"ts":"x","name":"b"}\n[]\nnull\n\n{"ts":2,"name":"b"}\n');
  assert.deepEqual(loadHistory(hfile).map(h => h.name), ['a', 'b'], 'malformed lines skipped, CRLF ok');
  const line = i => JSON.stringify({ ts: i, name: 'n' }) + '\n';
  fs.writeFileSync(hfile, Array.from({ length: 5900 }, (_, i) => line(i)).join(''));
  assert.equal(loadHistory(hfile).length, 5900, 'a bit over the cap stays');
  fs.writeFileSync(hfile, Array.from({ length: 7000 }, (_, i) => line(i)).join(''));
  const capped = loadHistory(hfile);
  assert.ok(capped.length === 5000 && capped[0].ts === 2000, 'well over the cap: newest 5000 read');
  assert.equal(fs.readFileSync(hfile, 'utf-8'), Array.from({ length: 5000 }, (_, i) => line(i + 2000)).join(''), 'and the file is cut to them');
  fs.rmSync(hdir, { recursive: true, force: true });
});

test('pruneBroken: drop dead folders, keep good ones, keep app when path dies', () => {
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
});

test('durations, stale selection, expiry sweep', () => {
  assert.equal(parseDuration('30m'), 1800000, 'minutes');
  assert.equal(parseDuration('2W'), 14 * 86400000, 'weeks, any case');
  assert.ok([undefined, '', '7', 'd', '0d', '1.5h', '7 days', '-1d'].every(v => parseDuration(v) === null), 'garbage rejected');
  assert.deepEqual([span(59 * 60000), span(47 * 3600000), span(3 * 86400000)], ['59m', '47h', '3d'], 'span units');
  assert.deepEqual([span(7 * 86400000 - 5000, Math.ceil), span(30000, Math.ceil)], ['7d', '1m'], 'time left rounds up: no "6d left" right after --ttl 7d, no "0m left"');
  const D = 86400000;
  const pool = {
    fresh: { lastUsed: now - D },
    older: { lastUsed: now - 90 * D },
    oldest: { lastUsed: now - 200 * D },
    bare: {},
    newAdd: { added: now - D },
    oldAdd: { added: now - 100 * D },
    hidden: { archived: true },
  };
  assert.deepEqual(staleLinks(pool, 60, now).map(s => s.name), ['bare', 'oldAdd', 'oldest', 'older'], 'never opened first, then oldest; fresh, just added and archived skipped');
  const sw = sweepExpired({ gone: { expires: now - 1 }, live: { expires: now + D }, done: { expires: 1, archived: true }, plain: {} }, now);
  assert.deepEqual(sw.archived, ['gone'], 'only active expired swept');
  assert.equal(sw.links.gone.archived, true, 'swept entry archived');
  assert.deepEqual(sw.links.live, { expires: now + D }, 'live entry untouched');
});

test('parseTags: split/trim/drop-empty, undefined when nothing usable', () => {
  assert.deepEqual(parseTags('work, personal ,'), ['work', 'personal'], 'tags split and trimmed');
  assert.equal(parseTags(''), undefined, 'empty tag string -> undefined');
  assert.equal(parseTags(undefined), undefined, 'missing tag -> undefined');
});

test('mergeLinks: merge overwrites on clash, replace swaps the set', () => {
  const cur = { a: { path: 'A' }, b: { path: 'B' } };
  const inc = { b: { path: 'B2' }, c: { path: 'C' } };
  const m = mergeLinks(cur, inc);
  assert.deepEqual(m.added, ['c'], 'new name is added');
  assert.deepEqual(m.updated, ['b'], 'clashing name is updated');
  assert.equal(m.merged.b.path, 'B2', 'incoming wins on clash');
  assert.ok(m.merged.a, 'untouched links survive a merge');
  const rep = mergeLinks(cur, inc, { replace: true });
  assert.deepEqual(Object.keys(rep.merged).sort(), ['b', 'c'], 'replace swaps the whole set');
});

test('lastUsedName: highest lastUsed wins, none -> null', () => {
  assert.equal(lastUsedName({ x: { lastUsed: 1 }, y: { lastUsed: 9 }, z: {} }), 'y', 'most recent wins');
  assert.equal(lastUsedName({ x: {}, y: {} }), null, 'no lastUsed -> null');
});

test('diffLinks, keepUsage, defaultName', () => {
  assert.deepEqual(diffLinks({ a: { path: 'A' }, b: { path: 'B' } }, { b: { path: 'X' }, c: { path: 'C' } }), { added: ['c'], removed: ['a'], changed: ['b'] }, 'diffLinks');
  assert.deepEqual(keepUsage({ a: { path: 'A', uses: 1 }, b: { path: 'B' } }, { a: { path: 'Z', uses: 3, lastUsed: 9 } }), { a: { path: 'A', uses: 3, lastUsed: 9 }, b: { path: 'B' } }, 'keepUsage takes current stats');
  assert.equal(defaultName('/x/My Cool  App/'), 'My-Cool-App', 'defaultName: basename, spaces to dashes');
});

test('removeLinks: one save, so one upex undo brings all of them back', () => {
  const rhome = fs.mkdtempSync(path.join(os.tmpdir(), 'upex-rm-'));
  const env = { ...process.env, USERPROFILE: rhome, HOME: rhome };
  const file = path.join(rhome, '.upex', 'links.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ a: { path: 'A' }, b: { path: 'B' }, c: { path: 'C' } }));
  const storeUrl = new URL('../src/store.js', import.meta.url).href;
  const rm = spawnSync(process.execPath, ['--input-type=module', '-e', `import { removeLinks } from '${storeUrl}'; console.log(Object.keys(removeLinks(['a', 'b', 'zz'])).join())`], { encoding: 'utf-8', env });
  assert.equal(rm.stdout.trim(), 'a,b', 'removeLinks returns what it removed');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf-8'))), ['c'], 'removeLinks deletes them');
  assert.equal(spawnSync(process.execPath, [cli, 'undo'], { encoding: 'utf-8', env }).status, 0, 'undo runs');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf-8'))).sort(), ['a', 'b', 'c'], 'one upex undo restores all of them');
});

test('import with workspaces: the first undo takes the shortcuts back, the next the workspaces, even in one ms', () => {
  const ihome = fs.mkdtempSync(path.join(os.tmpdir(), 'upex-imp-'));
  const env = { ...process.env, USERPROFILE: ihome, HOME: ihome };
  const src = f => new URL(`../src/${f}`, import.meta.url).href;
  // Every backup gets the same stamp, as two saves inside one ms would.
  const code = `import { importBundle } from '${src('commands/transfer.js')}';
import { undoLast, loadLinks, loadWorkspaces } from '${src('store.js')}';
Date.prototype.toISOString = () => '2026-01-01T00:00:00.000Z';
importBundle({ upex: 'bundle', links: { n: { path: 'x' } }, config: { workspaces: { w: [{ shortcut: 'n' }] } } });
const step = () => { const r = undoLast(); return [!!r.workspaces, r.removed, Object.keys(loadLinks()), Object.keys(loadWorkspaces())]; };
console.log(JSON.stringify([step(), step()]));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf-8', env });
  assert.equal(r.stderr, '', 'runs');
  assert.deepEqual(JSON.parse(r.stdout), [[false, ['n'], [], ['w']], [true, ['w'], [], []]], 'shortcuts first, then workspaces');
  fs.rmSync(ihome, { recursive: true, force: true });
});
