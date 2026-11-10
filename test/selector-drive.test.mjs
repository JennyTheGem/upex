import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pickedNames, pickedPaths } from '../src/commands/pick.js';
import { filterChoices, subfolderChoices } from '../src/interactive.js';

test('selector on fake streams: S-Tab, ↑ (wraps to the last archived), Enter restores; a double-click restores once, keeps its flash', async () => {
  const shome = fs.mkdtempSync(path.join(os.tmpdir(), 'upex-sel-'));
  const file = path.join(shome, '.upex', 'links.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ live: { path: shome }, a1: { path: 'A', archived: true, expires: 1 }, a2: { path: 'B', archived: true }, a3: { path: 'C', archived: true } }));
  const drive = path.join(shome, 'drive.mjs');
  fs.writeFileSync(drive, String.raw`
import { PassThrough } from 'node:stream';
import { runInteractiveMode } from '${new URL('../src/interactive.js', import.meta.url).href}';
const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 60 });
let out = '';
stdout.on('data', d => { out += d; });
const frame = () => out.slice(out.lastIndexOf('\x1b[H')).replace(/\x1b\[[\d;?<]*[A-Za-z]/g, '').split('\n');
const send = async s => { stdin.write(s); await new Promise(r => setTimeout(r, 30)); };
const run = runInteractiveMode({ stdin, stdout });
await send('\x1b[Z'); await send('\x1b[A'); await send('\r');
const y = frame().findIndex(l => l.includes('› a2')) + 1;
await send('\x1b[<0;3;' + y + 'm'); await send('\x1b[<0;3;' + y + 'm');
console.log(frame().join('\n'));
await send('\x03'); await run;
`);
  const r = spawnSync(process.execPath, [drive], { encoding: 'utf-8', env: { ...process.env, USERPROFILE: shome, HOME: shome } });
  const left = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.deepEqual([r.stderr, left.a1, left.a2, left.a3], ['', { path: 'A', archived: true, expires: 1 }, { path: 'B' }, { path: 'C' }], 'Enter, then a double-click restore one each');
  assert.ok(r.stdout.includes('restored "a2"') && r.stdout.includes('Archived 1') && r.stdout.includes('› a1'), 'flash kept, list and selection follow');
});

test('upex pick: Enter finishes even with After open = Stay; names map to path, url, app', async () => {
  const shome = fs.mkdtempSync(path.join(os.tmpdir(), 'upex-pick-'));
  fs.mkdirSync(path.join(shome, '.upex'), { recursive: true });
  fs.writeFileSync(path.join(shome, '.upex', 'links.json'), JSON.stringify({ one: { path: shome } }));
  fs.writeFileSync(path.join(shome, '.upex', 'config.json'), JSON.stringify({ enter: 'stay' }));
  const drive = path.join(shome, 'drive.mjs');
  fs.writeFileSync(drive, String.raw`
import { PassThrough } from 'node:stream';
import { runInteractiveMode } from '${new URL('../src/interactive.js', import.meta.url).href}';
const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 40 });
stdout.resume();
const run = runInteractiveMode({ stdin, stdout, picker: true });
await new Promise(r => setTimeout(r, 30)); stdin.write('\r');
console.log(JSON.stringify(await run));
`);
  const r = spawnSync(process.execPath, [drive], { encoding: 'utf-8', env: { ...process.env, USERPROFILE: shome, HOME: shome } });
  assert.deepEqual([r.stderr, JSON.parse(r.stdout).status], ['', 'selected'], 'picker Enter finishes despite Stay open');
  const links = { f: { path: '/f', aliases: ['ff'] }, u: { url: 'https://x' }, a: { app: 'x.exe' } };
  assert.deepEqual(pickedPaths(pickedNames({ status: 'marked', entries: [{ shortcut: 'f' }, { shortcut: 'gone' }, { shortcut: 'u' }] }), links), ['/f', 'https://x'], 'marked: paths in order, gone skipped');
  assert.deepEqual(pickedPaths(pickedNames({ status: 'workspace', name: 'w' }, { w: [{ shortcut: 'a' }, { shortcut: 'ff' }, { shortcut: 'f/src' }, { shortcut: 'u/x' }] }), links),
    ['x.exe', '/f', path.join('/f', 'src')], 'workspace entries: app command, alias, subpath; no subpath of a url');
  assert.deepEqual(pickedNames({ status: 'cancelled' }), [], 'Esc picks nothing');
});

test('^f: folders then files, each A to Z, dot ones last; ^f in, ↓, ← back, ^f again, Enter picks "top/A"; a file opens in its default app', async () => {
  const shome = fs.mkdtempSync(path.join(os.tmpdir(), 'upex-drill-'));
  fs.mkdirSync(path.join(shome, '.upex'), { recursive: true });
  for (const d of ['b', 'A']) fs.mkdirSync(path.join(shome, d));
  for (const f of ['c.txt', '.env']) fs.writeFileSync(path.join(shome, f), '');
  fs.writeFileSync(path.join(shome, '.upex', 'links.json'), JSON.stringify({ top: { path: shome } }));
  assert.deepEqual(subfolderChoices(shome, 'top').map(c => [c.name, c.ref, c.isFile]),
    [['A', 'top/A', false], ['b', 'top/b', false], ['.upex', 'top/.upex', false], ['c.txt', 'top/c.txt', true], ['.env', 'top/.env', true]], 'folders then files, sorted, refs');
  assert.deepEqual(subfolderChoices(path.join(shome, 'gone'), 'x'), [], 'unreadable folder: no rows');
  const scoped = [{ name: '@types', opener: 'vscode', tags: [] }, { name: 'src', opener: 'vscode', tags: [] }];
  assert.deepEqual(filterChoices(scoped, '@types', { searchIn: 'names', tokens: false }).map(c => c.name), ['@types'], '^f rows: @ and # are name text, not tokens');
  const drive = path.join(shome, 'drive.mjs');
  fs.writeFileSync(drive, String.raw`
import { PassThrough } from 'node:stream';
import { runInteractiveMode } from '${new URL('../src/interactive.js', import.meta.url).href}';
const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 40 });
stdout.resume();
const send = async s => { stdin.write(s); await new Promise(r => setTimeout(r, 30)); };
const run = runInteractiveMode({ stdin, stdout, picker: process.argv[2] === 'pick' });
if (process.argv[2] === 'pick') { await send('\x06'); await send('\x1b[B'); await send('\x1b[D'); await send('\x06'); }
else if (process.argv[2] === 'guard') { await send('\x1b[B'); await send('\x06'); await send('\x1b[B'); for (const k of ['\x10', ' ', '\x18', '\x05', '\x12']) await send(k); }
else { await send('\x06'); await send('c.txt'); }
await send('\r');
console.log(JSON.stringify(await run));
`);
  const drill = mode => spawnSync(process.execPath, [drive, mode], { encoding: 'utf-8', timeout: 20000, env: { ...process.env, USERPROFILE: shome, HOME: shome } });
  const r = drill('pick');
  const res = JSON.parse(r.stdout);
  assert.deepEqual([r.stderr, res.name], ['', 'top/A'], 'drill in, back, in again, pick the first subfolder');
  const f = drill('open');
  assert.deepEqual([f.stderr, JSON.parse(f.stdout).name, JSON.parse(f.stdout).app], ['', 'top/c.txt', 'open'], 'a file row opens in its default app');
  assert.deepEqual(pickedPaths(pickedNames(res), JSON.parse(fs.readFileSync(path.join(shome, '.upex', 'links.json'), 'utf-8'))), [path.join(shome, 'A')], 'picked subfolder prints its path');
  // A shortcut "b" shares the subfolder row's name: ^p, Space, ^x, ^e, ^r on that row must leave it alone.
  const guarded = { b: { path: path.join(shome, 'b') }, top: { path: shome } };
  fs.writeFileSync(path.join(shome, '.upex', 'links.json'), JSON.stringify(guarded));
  const g = drill('guard');
  assert.deepEqual([g.stderr, JSON.parse(g.stdout || '{}').name], ['', 'top/b'], 'drill keys blocked, Enter opens the subfolder row');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(shome, '.upex', 'links.json'), 'utf-8')).b, guarded.b, 'same-named shortcut untouched');
});

test('right-click menu on fake streams: click "pin" on one row, then ↑ (wraps to archive) Enter y on another', async () => {
  const shome = fs.mkdtempSync(path.join(os.tmpdir(), 'upex-menu-'));
  const file = path.join(shome, '.upex', 'links.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ one: { path: shome }, two: { path: shome } }));
  const drive = path.join(shome, 'drive.mjs');
  fs.writeFileSync(drive, String.raw`
import { PassThrough } from 'node:stream';
import { runInteractiveMode } from '${new URL('../src/interactive.js', import.meta.url).href}';
const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 40 });
let out = '';
stdout.on('data', d => { out += d; });
const frame = () => out.slice(out.lastIndexOf('\x1b[H')).replace(/\x1b\[[\d;?<]*[A-Za-z]/g, '').split('\n');
const send = async s => { stdin.write(s); await new Promise(r => setTimeout(r, 30)); };
const rowY = name => frame().findIndex(l => new RegExp('^  . ' + name + ' ').test(l)) + 1;
const run = runInteractiveMode({ stdin, stdout });
await send('\x1b[<2;5;' + rowY('two') + 'm');
const pinY = frame().findIndex(l => l.includes('│  pin ')) + 1;
await send('\x1b[<0;' + (frame()[pinY - 1].indexOf('pin') + 1) + ';' + pinY + 'm');
await send('\x1b[<2;5;' + rowY('one') + 'm'); await send('\x1b[A'); await send('\r'); await send('y');
await send('\x03'); await run;
`);
  const r = spawnSync(process.execPath, [drive], { encoding: 'utf-8', env: { ...process.env, USERPROFILE: shome, HOME: shome } });
  const left = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.deepEqual([r.stderr, !!left.two.pinned, !!left.one.archived], ['', true, true], 'right-click menu pins by click, archives by keys');
});

test('live reload on fake streams: another save shows up; a reload keeps the picked "search archived" offer', async () => {
  const shome = fs.mkdtempSync(path.join(os.tmpdir(), 'upex-live-'));
  const file = path.join(shome, '.upex', 'links.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ one: { path: 'A' }, zzarc: { path: 'Z', archived: true } }));
  const drive = path.join(shome, 'drive.mjs');
  fs.writeFileSync(drive, String.raw`
import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import { runInteractiveMode } from '${new URL('../src/interactive.js', import.meta.url).href}';
const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 40 });
let out = '';
stdout.on('data', d => { out += d; });
const frame = () => out.slice(out.lastIndexOf('\x1b[H')).replace(/\x1b\[[\d;?<]*[A-Za-z]/g, '');
const send = async (s, ms = 30) => { stdin.write(s); await new Promise(r => setTimeout(r, ms)); };
const save = (name) => {
  const links = JSON.parse(fs.readFileSync(${JSON.stringify(file)}, 'utf-8'));
  fs.writeFileSync(${JSON.stringify(file)} + '.tmp', JSON.stringify({ ...links, [name]: { path: 'B' } }));
  fs.renameSync(${JSON.stringify(file)} + '.tmp', ${JSON.stringify(file)});
};
const run = runInteractiveMode({ stdin, stdout });
await send('');
save('two');
await new Promise(r => setTimeout(r, 500));
console.log(frame().includes(' two ') ? 'reloaded' : 'stale');
await send('zz'); await send('\x1b[B');
save('three');
await new Promise(r => setTimeout(r, 500));
await send('\r');
await send('\x03'); await run;
`);
  const r = spawnSync(process.execPath, [drive], { encoding: 'utf-8', env: { ...process.env, USERPROFILE: shome, HOME: shome } });
  const left = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.deepEqual([r.stderr, r.stdout.trim(), Object.keys(left).sort().join()], ['', 'reloaded', 'one,three,two,zzarc'], 'live reload shows a save from elsewhere, keeps the picked offer');
});

test('Settings filter on fake streams: a Shortcuts filter doesn\'t move the picked setting; a change that hides a row above keeps the picked one', async () => {
  const shome = fs.mkdtempSync(path.join(os.tmpdir(), 'upex-setf-'));
  fs.mkdirSync(path.join(shome, '.upex'), { recursive: true });
  fs.writeFileSync(path.join(shome, '.upex', 'links.json'), JSON.stringify({ one: { path: shome } }));
  const drive = path.join(shome, 'drive.mjs');
  fs.writeFileSync(drive, String.raw`
import { PassThrough } from 'node:stream';
import { runInteractiveMode } from '${new URL('../src/interactive.js', import.meta.url).href}';
const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 40 });
stdout.resume();
const send = async s => { stdin.write(s); await new Promise(r => setTimeout(r, 30)); };
const run = runInteractiveMode({ stdin, stdout });
for (const k of ['\x1b[Z', '\x1b[B', '\x1b[B', '\x1b[B', '\x1b[B', '\x1b[Z', 'zzz', '\x1b[Z', '\x1b[C', 'screen', '\x1b[B', '\x1b[C', '\x1b[C', '\x03']) await send(k);
await run;
`);
  const r = spawnSync(process.execPath, [drive], { encoding: 'utf-8', env: { ...process.env, USERPROFILE: shome, HOME: shome } });
  const cfg = JSON.parse(fs.readFileSync(path.join(shome, '.upex', 'config.json'), 'utf-8'));
  assert.deepEqual([r.stderr, cfg.updateCheck, cfg.fullScreen, cfg.startView, cfg.narrowPane], ['', 'off', 'on', undefined, undefined], 'settings filter keeps the picked row');
});

test('no-match offers on fake streams: ↓ Enter shows archived in Settings; with a mark, Enter adds the typed name (not opens marked)', async () => {
  const shome = fs.mkdtempSync(path.join(os.tmpdir(), 'upex-offer-'));
  const file = path.join(shome, '.upex', 'links.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ one: { path: shome }, qqqold: { path: shome, archived: true } }));
  const drive = path.join(shome, 'drive.mjs');
  fs.writeFileSync(drive, String.raw`
import { PassThrough } from 'node:stream';
import { runInteractiveMode } from '${new URL('../src/interactive.js', import.meta.url).href}';
const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 40 });
let out = '';
stdout.on('data', d => { out += d; });
const send = async s => { stdin.write(s); await new Promise(r => setTimeout(r, 30)); };
const run = runInteractiveMode({ stdin, stdout });
for (const k of [' ', 'qqqold', '\x1b[B', '\r']) await send(k);
console.log(out.slice(out.lastIndexOf('\x1b[H')).replace(/\x1b\[[\d;?<]*[A-Za-z]/g, ''));
for (const k of ['\x1b[Z', 'qqq', '\r', '\x03']) await send(k);
console.log(JSON.stringify(await run));
`);
  const r = spawnSync(process.execPath, [drive], { encoding: 'utf-8', cwd: shome, env: { ...process.env, USERPROFILE: shome, HOME: shome } });
  const left = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.deepEqual([r.stderr, typeof left.qqq?.path, JSON.parse(r.stdout.trim().split('\n').at(-1)).status], ['', 'string', 'cancelled'], 'Enter on a no-match offer adds, marks stay unopened');
  assert.ok(r.stdout.includes('› qqqold'), 'search archived: Settings with the archived row picked');
});

test('started in System32 (Windows): the no-match "add" asks the folder after the name, then adds it', async () => {
  if (os.platform() === 'win32') {
    const shome = fs.mkdtempSync(path.join(os.tmpdir(), 'upex-sys-'));
    const file = path.join(shome, '.upex', 'links.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ one: { path: shome } }));
    const drive = path.join(shome, 'drive.mjs');
    fs.writeFileSync(drive, String.raw`
import { PassThrough } from 'node:stream';
import { runInteractiveMode } from '${new URL('../src/interactive.js', import.meta.url).href}';
const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 40 });
let out = '';
stdout.on('data', d => { out += d; });
const send = async s => { stdin.write(s); await new Promise(r => setTimeout(r, 30)); };
const run = runInteractiveMode({ stdin, stdout });
for (const k of ['qqq', '\r', '\r', ${JSON.stringify(path.join(shome, 'nope'))}, '\r', '\x15', ${JSON.stringify(shome)}, '\r', '\x03']) await send(k);
await run;
console.log(out.replace(/\x1b\[[\d;?<]*[A-Za-z]/g, ''));
`);
    const r = spawnSync(process.execPath, [drive], { encoding: 'utf-8', cwd: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'), env: { ...process.env, USERPROFILE: shome, HOME: shome } });
    const left = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.deepEqual([r.stderr, left.qqq?.path], ['', shome], 'System32: name, then the typed folder is added');
    assert.ok(['its target next', 'type a folder, program or url', 'path not found', 'added "qqq"'].every(s => r.stdout.includes(s)), 'System32: no cwd offered, empty and missing folder flashed');
  }
});
