import './helpers.mjs';
import { strip, viewArgs, setArgs } from './view.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import chalk from 'chalk';
import { truncate, width, stripAnsi, wrap } from '../src/ui.js';
import { clipMiddle } from '../src/rows.js';
import { renderInteractiveView } from '../src/interactive.js';
import { createProgram } from '../src/index.js';
import { helpLines } from '../src/commands/help.js';
import { isNewer, VERSION, updateText } from '../src/update.js';

test('truncate: clips to visible width, ignores ANSI, keeps short lines as-is', () => {
  assert.equal(truncate('hello', 10), 'hello', 'short line untouched');
  assert.equal(strip(truncate('abcdefghij', 5)).length, 5, 'clipped to exact width');
  assert.equal(strip(truncate(`\x1B[1mabcdefghij\x1B[0m`, 5)).length, 5, 'ANSI codes do not count as width');
  assert.ok(truncate('abcdefghij', 5).endsWith('\x1B[0m'), 'clipped line resets styling');
  assert.equal(truncate('abc', 0), '', 'zero width -> empty');
  // text fills the width exactly, then a styled tail follows: must not overflow by the ellipsis
  assert.equal(strip(truncate(`abcde\x1B[2m fg\x1B[0m`, 5)).length, 5, 'styled tail after exact fill stays in width');
  assert.equal(strip(truncate('abcdefghij', 1)), '…', 'width 1 -> ellipsis only');
});

test('Middle clip keeps the first part and the last folders.', () => {
  const P = 'E:\\Downloads\\Projects\\Assets\\upex';
  assert.deepEqual([clipMiddle(P, 40), clipMiddle(P, 26), clipMiddle(P, 20), clipMiddle(P, 10), clipMiddle(P, 6), clipMiddle('/home/me/a/b/c', 12), clipMiddle('abcdefgh', 4)],
    [P, 'E:\\Downloads\\…\\Assets\\upex', 'E:\\…\\Assets\\upex', 'E:\\…\\upex', '…\\upex', '/home/…/b/c', '…fgh'], 'clipMiddle');
});

test('help: grouped, wraps to any width, lists every visible command', async () => {
  assert.deepEqual(wrap([['aa bb cc'], ['\ndd']], 5).map(stripAnsi), ['aa bb', 'cc', 'dd'], 'wrap fills lines, \n breaks');
  assert.equal(width(wrap([['abcdefgh']], 4)[0]), 4, 'a too long word is clipped');
  assert.deepEqual(wrap([['a\u00a0b c']], 3), ['a b', 'c'], 'nbsp keeps words together, printed as a space');
  const lvl3 = chalk.level;
  chalk.level = 1;
  for (const total of [20, 40, 80, 120]) {
    const program = await createProgram();
    const text = helpLines(program, total);
    assert.ok(text.every(l => width(l) <= total), `help fits ${total} columns`);
    const plain = text.map(stripAnsi).join('\n');
    for (const c of program.commands.filter(c => !c._hidden)) assert.match(plain, new RegExp(`^ {4}${c.name()}\\b`, 'm'), `help lists ${c.name()} at ${total}`);
  }
  chalk.level = lvl3;
});

test('update notice: version compare, version on the bottom rule', () => {
  assert.ok(isNewer('1.15.0', '1.14.9') && isNewer('2.0.0', '1.99.99') && isNewer('1.10.0', '1.9.0'), 'newer x.y.z');
  assert.ok(!isNewer('1.14.0', '1.14.0') && !isNewer('1.9.0', '1.10.0') && !isNewer(undefined, '1.0.0'), 'same, older or missing is not newer');
  assert.ok(!isNewer('1.14.0-beta.1', '1.14.0'), 'pre-release tag ignored');
  assert.ok(updateText('99.0.0').startsWith('v99.0.0 out') && updateText(VERSION) === `v${VERSION} is the latest`, 'Settings update line');
  const bottom = (flash, more = {}) => stripAnsi(renderInteractiveView({ ...viewArgs, flash, width: 119, ...more })).split('\n').filter(l => l.includes('─')).at(-1);
  assert.ok(bottom('').endsWith(`─ v${VERSION} ──`) && bottom('').length === 119, 'wide: version at the right end of the bottom rule');
  assert.ok(bottom('saved').includes(`v${VERSION}`) && !bottom('saved').includes('saved'), 'a flash leaves the version alone');
  assert.ok(!bottom('', { width: 60 }).includes(`v${VERSION}`), 'narrow: no version');
  assert.ok(bottom('', { ...setArgs, width: 60 }).includes(`v${VERSION}`), 'settings: version at any width');
});

test('update notice hook on a fake terminal: after a command, not after completion, __names or with updateCheck off', async () => {
  const uhome = fs.mkdtempSync(path.join(os.tmpdir(), 'upex-upd-'));
  const cache = path.join(uhome, '.upex', 'update.json');
  fs.mkdirSync(path.dirname(cache));
  fs.writeFileSync(cache, JSON.stringify({ checked: Date.now(), latest: '99.0.0' }));
  const before = fs.readFileSync(cache, 'utf-8');
  const runs = [['config', 'get', 'sort'], ['completion', 'bash'], ['__names'], ['config', 'set', 'updateCheck', 'off'], ['config', 'get', 'sort']];
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `process.stderr.isTTY = true;
const { createProgram } = await import('${new URL('../src/index.js', import.meta.url).href}');
let err = [];
console.error = (s) => err.push(String(s));
const out = [];
for (const args of ${JSON.stringify(runs)}) { await (await createProgram()).parseAsync(['node', 'upex', ...args]); out.push(err.filter(s => s.includes('update available')).join()); err = []; }
process.stdout.write('\\n' + JSON.stringify(out));`], { encoding: 'utf-8', env: { ...process.env, USERPROFILE: uhome, HOME: uhome } });
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').at(-1)).map(stripAnsi), [`  update available ${VERSION} -> 99.0.0, run npm i -g @uplift-beyond/upex@latest`, '', '', '', ''], 'notice gating');
  assert.equal(fs.readFileSync(cache, 'utf-8'), before, 'fresh cache: no new check');
  fs.rmSync(uhome, { recursive: true, force: true });
});
