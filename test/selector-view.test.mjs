import './helpers.mjs';
import { strip, viewArgs, setArgs, win, rowsOf, at, v } from './view.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import chalk from 'chalk';
import { unarchived, withPinned } from '../src/store.js';
import { checkSettings } from '../src/launcher.js';
import { setting, resetSettings, startTab } from '../src/settings.js';
import { width, dimParent, stripAnsi, toAscii } from '../src/ui.js';
import { pathLook, tidyPath } from '../src/rows.js';
import { readScripts, detectPm } from '../src/commands/run.js';
import { renderInteractiveView, nextView, backTo, accentOf, inView, optionRow, listRows, readMouse, rowClick, undoFlash, statLines, doctorLines, settingsList, archivedList, wrapHint, splice, overlayMenu } from '../src/interactive.js';

// Shared by the tests below.
const labels = ['Explorer', 'VS Code', 'cmd', 'Claude', 'WebStorm', 'PowerShell', 'Custom'];
const many = { ...viewArgs, choices: Array.from({ length: 30 }, (_, i) => ({ name: `p${i}`, path: 'P', exists: true })) };
const wideOpeners = { ...viewArgs, width: 40, appChoices: labels.map(label => ({ key: label, label })), selectedAppIndex: 6 };
// key hints: full = rows that wrap, short = one row cut to the width, off = none; the list takes the freed rows
const withHints = (keyHints, extra = {}) => strip(renderInteractiveView({ ...many, height: 30, settings: { keyHints }, ...extra })).split('\n');
const [full, short1, off] = ['full', 'short', 'off'].map(k => withHints(k));
// Keypresses through real readline, mouse reports split out.
const feed = async (...chunks) => {
  const s = new PassThrough();
  readline.emitKeypressEvents(s);
  let state = null;
  const keys = [];
  const events = [];
  s.on('keypress', (str, key) => {
    const r = readMouse(state, key);
    state = r.state;
    if (r.event) events.push(r.event);
    if (r.pass) keys.push(str ?? key.name);
  });
  for (const c of chunks) { s.write(c); await new Promise(r => setImmediate(r)); }
  return { keys: keys.join(''), events };
};
const tabArgs = { ...viewArgs, counts: { shortcuts: 1, apps: 2, workspaces: 0 } };

test('selector tabs: folders on Shortcuts, apps + URLs on Apps', () => {
  const tabbed = [{ name: 'f' }, { name: 'a', isApp: true }, { name: 'u', isUrl: true }];
  assert.deepEqual(tabbed.filter(inView('shortcuts')).map(c => c.name), ['f'], 'shortcuts tab: folders only');
  assert.deepEqual(tabbed.filter(inView('apps')).map(c => c.name), ['a', 'u'], 'apps tab: apps and URLs');
});

test('a learned folder is offered as a "+" row on top of the list: the header rule above, a blank row below', () => {
  const tipHits = [];
  const frame = (extra) => strip(renderInteractiveView({ ...viewArgs, suggest: { name: 'site', path: '/x/site' }, width: 80, ...extra })).split('\n');
  const inline = frame({ targets: tipHits });
  const at = inline.findIndex(l => l.includes('^n add'));
  assert.match(inline[at], /^ {2}\+ site +\/x\/site +you cd here often {2}\^n add {2}\^l hide$/, 'suggested row: + name, path, why and keys');
  assert.equal(inline[at].indexOf('/x/site'), inline.find(l => l.startsWith('  › s')).indexOf('P'), 'lined up with the list columns');
  assert.ok(inline[at - 1].startsWith('  ──') && inline[at + 1] === '' && inline[at + 2].startsWith('  › s'), 'rule above, blank row, then the list');
  assert.ok(tipHits.some(t => t.suggest && t.line === at), 'suggested row is clickable');
  assert.match(frame({ width: 44 }).find(l => l.includes('^n add')), /^ {2}\+ site +\/x\/site +\^n add {2}\^l hide$/, 'narrow: keys only');
  const fullFrame = frame({ full: true, height: 24 });
  assert.equal(fullFrame.length, 24, 'full screen: still fills the height exactly');
  const fullAt = fullFrame.findIndex(l => l.includes('^n add'));
  assert.ok(fullFrame[fullAt - 1].startsWith('  ──') && fullFrame[fullAt + 2].startsWith('  › s'), 'full screen: on top of the list too');
  const long = height => frame({ full: true, height, choices: Array.from({ length: 30 }, (_, i) => ({ name: `n${i}`, path: 'P', exists: true })) });
  assert.ok(long(24).length === 24 && long(24).some(l => l.includes('^n add')), 'a long list leaves room for it');
  assert.ok(long(16).length === 16 && !long(16).some(l => l.includes('^n add')), 'a short screen keeps its rows for the list');
  const heads = frame({ full: true, height: 17, settings: { pinned: 'section' }, choices: [{ name: 'a', path: 'P', exists: true, pinned: true }, { name: 'b', path: 'P', exists: true }] });
  assert.equal(heads.length, 17, 'headings count too: never taller than the screen');
  assert.ok(frame({ query: 'zz', choices: [] }).some(l => l.includes('^n add')), 'stays while filtering, also with no matches');
  assert.ok(!frame({ keysHelp: true }).some(l => l.includes('+ site')), 'not under the key overlay');
});

test('selector: Tab view lists workspaces, hides the opener row', () => {
  const wsView = strip(renderInteractiveView({ ...viewArgs, view: 'workspaces', workspaces: [{ name: 'dev', path: 's:vscode' }] }));
  assert.ok(wsView.includes('tab shortcuts') && wsView.includes('› dev') && wsView.includes('s:vscode'), 'workspace view lists workspaces');
  assert.ok(!wsView.includes('Explorer'), 'no opener row in workspace view');
  assert.ok(strip(renderInteractiveView(viewArgs)).includes('tab apps'), 'shortcut view is the default');
  const appsView = strip(renderInteractiveView({ ...viewArgs, view: 'apps', choices: [{ name: 'g', path: 'x.dev', isUrl: true, exists: true }] }));
  assert.ok(appsView.includes('tab workspaces') && appsView.includes('open in browser') && !appsView.includes('Explorer'), 'apps view: no opener row');
  const setView = strip(renderInteractiveView(setArgs));
  if (os.platform() === 'win32') assert.ok(setView.includes('‹ Tabs ›') && setView.includes('‹ PowerShell 7 ›') && setView.includes('‹ Explorer ›') && setView.includes('not found'), 'settings view: all rows + missing-wt note');
  assert.ok(!setView.includes('Pane split'), 'pane split hidden unless split panes');
  if (os.platform() === 'win32') assert.ok(strip(renderInteractiveView({ ...setArgs, settings: { ...setArgs.settings, terminalLayout: 'panes' } })).includes('Pane split'), 'pane split shown for split panes');
  assert.ok(setView.includes('‹ A to Z ›'), 'sort row shows the saved sort');
  assert.ok(strip(renderInteractiveView({ ...setArgs, settingIndex: 9 + win })).includes('no opener of their own'), 'note follows the picked row');
  assert.ok(setView.indexOf('Workspaces') < setView.indexOf('Settings'), 'settings tab is last');
  // archived shortcuts sit under the settings, Enter restores the picked one
  assert.deepEqual(archivedList({ b: { path: '/b', archived: true }, a: { app: 'x.exe', archived: true }, c: { path: '/c' } }), [{ name: 'a', path: 'x.exe' }, { name: 'b', path: '/b' }], 'archived list: only archived, A to Z');
  assert.deepEqual(unarchived({ path: '/a', archived: true, expires: 1, uses: 2 }), { path: '/a', uses: 2 }, 'restore drops archived and expires');
  assert.ok(!setView.includes('Archived'), 'no archived section when none');
  const arcArgs = { ...setArgs, archived: [{ name: 'old', path: '/old/dir' }], height: 80 };
  const arcView = strip(renderInteractiveView({ ...arcArgs, settingIndex: 0 }));
  assert.ok(arcView.includes('Archived 1') && arcView.includes('/old/dir') && arcView.includes('change (saved)'), 'archived section lists them');
  // 33 setting rows on Windows (pane split hidden), so index 33 is the first archived one.
  const arcSel = strip(renderInteractiveView({ ...arcArgs, settingIndex: 32 + win }));
  assert.ok(arcSel.includes('› old') && arcSel.includes('↵ restore') && arcSel.includes('upex restore old') && arcSel.includes('^d delete') && !arcView.includes('^d delete'), 'picked archived row: restore and delete keys, note');

  // color dot column before names, usage at the right edge
  const dotView = strip(renderInteractiveView({ ...viewArgs, width: 80, settings: { usage: 'opens' }, choices: [{ name: 's', path: 'P', exists: true, color: 'red', uses: 2, lastUsed: 5 }, { name: 't', path: 'Q', exists: true, uses: 0, lastUsed: 0 }] }));
  assert.ok(/● s /.test(dotView) && /  {2}t /.test(dotView) && dotView.includes('2 opens') && dotView.includes('0 opens'), 'color dot + usage column');
  const narrowUse = strip(renderInteractiveView({ ...viewArgs, width: 30, settings: { usage: 'ago' }, choices: [{ name: 's', path: 'P', exists: false, color: '🔥', lastUsed: 0 }] })).split('\n').find(l => l.startsWith('  › 🔥'));
  assert.ok(width(narrowUse) <= 30 && narrowUse.includes('missing') && !narrowUse.includes('never'), 'usage drops before the row overflows');
  // rows stay inside the given width, the missing badge survives a long path
  const longArgs = (width, exists) => ({ ...viewArgs, width, choices: [{ name: 's', path: 'P/'.repeat(60) + 'leaf', exists }] });
  const longView = strip(renderInteractiveView(longArgs(60, false)));
  assert.ok(longView.split('\n').every(l => l.length <= 60), 'rows fit the width');
  assert.ok(/…[P/]+leaf\s+missing/.test(longView), 'long path clipped from the start, badge kept');
  const selRow = (width, exists) => strip(renderInteractiveView(longArgs(width, exists))).split('\n').find(l => l.startsWith('  › s '));
  assert.equal(selRow(60, true).length, 60, 'selected row without a badge fills the width exactly');
  assert.equal(selRow(30, false).length, 30, 'narrow terminal: row still fits');
  assert.equal(tidyPath(path.join(os.homedir(), 'x')), path.join('~', 'x'), 'home -> ~');
  assert.equal(stripAnsi(dimParent('a\\b/c', s => `[${s}]`)), 'a\\b/[c]', 'dimParent splits at the last slash');
  assert.equal(stripAnsi(dimParent('a/b\\c', s => `[${s}]`)), 'a/b\\[c]', 'dimParent splits at a backslash');
  assert.equal(tidyPath(os.homedir() + 'x'), os.homedir() + 'x', 'home prefix of another name untouched');
  if (os.platform() === 'win32') assert.equal(tidyPath(os.homedir().toUpperCase() + '\\x'), '~\\x', 'windows: home match ignores case');
});

test('fit the terminal: option rows scroll around the selection, the list fits the height', () => {
  assert.equal(strip(optionRow(labels, 1, 200)), 'Explorer  ‹ VS Code ›  cmd  Claude  WebStorm  PowerShell  Custom', 'wide row shows all');
  const mid = strip(optionRow(labels, 4, 30));
  assert.ok(mid.includes('‹ WebStorm ›') && mid.startsWith('‹…') && mid.endsWith('…›') && mid.length <= 30, 'narrow row keeps the selection, marks both edges');
  assert.ok(strip(optionRow(labels, 6, 30)).endsWith('‹ Custom ›') && !strip(optionRow(labels, 0, 30)).startsWith('‹…'), 'no marker past the ends');
  assert.ok(strip(optionRow(labels, -1, 30)).startsWith('Explorer'), 'unknown value anchors at the start');
  assert.equal(listRows(5, 10), 5, 'all rows fit');
  assert.equal(listRows(20, 10), 9, 'one row left for the scroll hint');
  assert.equal(listRows(20, 1), 3, 'at least 3 rows');
  for (const height of [16, 30]) assert.equal(renderInteractiveView({ ...many, height }).split('\n').length, height, `fills height ${height} exactly`);
  assert.ok(renderInteractiveView({ ...many, height: 40, maxList: 8 }).includes('↓ 22 more'), 'inline cap keeps 8 rows');
  assert.ok(strip(renderInteractiveView(wideOpeners)).split('\n').some(l => l.includes('open with') && l.includes('‹ Custom ›') && l.length <= 40), 'opener row keeps the selection in width');
  assert.equal(setting('fullScreen', {}), 'on', 'full screen on by default');
  assert.equal(setting('fullScreen', { fullScreen: 'off' }), 'off', 'full screen can be turned off');
  assert.deepEqual([setting('recentStrip', { recentStrip: 'on' }), setting('recentStrip', { recentStrip: '5' }), setting('staleAfter', {}), setting('staleAfter', { staleAfter: '7' }), setting('staleAfter', { staleAfter: '180' })], ['3', '5', '60', '60', '180'], 'old recent on reads as 3, stale after defaults to 60');
  assert.deepEqual([{}, { fullScreen: 'off' }].map(s => settingsList(s).rows.some(r => r.key === 'mouse')), [true, false], 'mouse row only in full screen');
  assert.ok(strip(renderInteractiveView({ ...setArgs, settings: { ...setArgs.settings, fullScreen: 'off' }, height: 80 })).includes('Full screen     On  ‹ Off ›'), 'full screen row');
  for (const k of ['full', 'short', 'off']) assert.equal(withHints(k).length, 30, `hints ${k}: fills the height`);
  // glyphs ascii: one column per swapped glyph, hint keys spelled out
  assert.equal(toAscii('‹ a › ▏▎─│┬┴…↑↓←→●★×'), '< a > ||-|++.^v<>**x', 'ascii glyphs');
  const asc = withHints('full', { settings: { glyphs: 'ascii' } }).join('\n');
  assert.ok(asc.includes('enter open') && asc.includes('up/down move') && !full.join('\n').includes('enter open'), 'ascii hint keys');
  assert.ok(full.some(l => l.includes('tab apps')) && full.some(l => l.includes('^a add')), 'full: both rows');
  assert.ok(!short1.some(l => l.includes('tab apps') || l.includes('^a add')) && short1.at(-1).includes('←→ opener') && short1.at(-1).includes('^e edit'), 'short: one row of what the row can do now');
  assert.ok(/ \? all keys$/.test(short1.at(-1)) && withHints('short', { query: 'p' }).at(-1).endsWith(' ^k all keys'), 'short: all keys at the right end, ^k while filtering');
  assert.ok(!short1.at(-1).includes('esc') && withHints('short', { query: 'p' }).at(-1).includes('esc clear'), 'short: esc only when it does more than quit');
  assert.ok(withHints('short', { marks: new Set(['p1']) }).at(-1).includes('^x archive 1 marked'), 'short: marks swap space for ^x');
  assert.ok(!withHints('short', { choices: [] }).at(-1).includes('↵') && withHints('short', { choices: [] }).at(-1).includes('^a add'), 'short: nothing to open on an empty list');
  assert.equal(setting('keyHints', {}), 'short', 'short hints by default');
  assert.ok(!off.some(l => l.includes('^a add') || l.includes('↵ open')) && off.at(-1).includes('open with'), 'off: no hints, opener row kept');
  assert.ok(off.filter(l => /^  [ ›] p\d/.test(l)).length > full.filter(l => /^  [ ›] p\d/.test(l)).length, 'off: more list rows');
  const cut = withHints('short', { width: 40 }).at(-1);
  assert.ok(cut.length <= 40 && cut.includes('↵ open') && cut.endsWith('? all keys'), 'short row cut to the width, all keys kept');
  assert.ok(withHints('off', { view: 'apps' }).at(-1).includes('↓'), 'off in apps: no footer rule, list runs to the bottom');
  assert.ok(/^ {2}─+$/.test(withHints('off', { view: 'apps', webUrl: 'http://h/?t=x' }).at(-2)), 'off: web link right under the rule');
  assert.ok(withHints('off', { view: 'settings' }).some(l => l.includes('change (saved)')), 'settings keeps its keys');
  assert.equal(withHints('short', { mode: 'input', action: 'rename' }).at(-1).trim().startsWith('↵ save'), true, 'short: typing shows input keys');
  // full rows wrap instead of cutting; the row count ignores the selection
  assert.deepEqual(wrapHint([['a', 'one'], ['b', 'two'], false, ['c', 'three']], 14).map(strip), ['  a one  b two', '  c three'], 'wrapHint wraps');
  assert.ok(wrapHint([['^x', 'archive']], 40)[0] === `  ${chalk.dim('^x')} archive`, 'hint: key dim, word plain');
  {
    const nar = withHints('full', { width: 50 });
    const rule = nar.findLastIndex(l => /^ *─+$/.test(l));
    const keys = nar.slice(rule + 1).join(' ');
    assert.ok(nar.slice(rule).every(l => l.length <= 50) && keys.includes('^y copy') && keys.includes('^u web ui') && keys.includes('^s scripts') && !keys.includes('|'), 'narrow full: keys wrap, nothing cut');
    // Rows under the last rule (full screen, so S-→ details shows): the same with the pinned row (A-↑↓ move pin, ^p unpin) or the other one selected, marks, a filter, a confirm or typing.
    const footOf = (extra) => {
      const l = withHints('full', { full: true, choices: [{ name: 'a', path: 'P', exists: true, pinned: true }, { name: 'b', path: 'Q', exists: true }], ...extra });
      return l.length - l.findLastIndex(x => /^ *─+$/.test(x));
    };
    const states = [{ selectedIndex: 1 }, { marks: new Set(['a']) }, { query: 'a' }, { mode: 'confirm', action: 'archive' }, { mode: 'input', action: 'rename' }];
    assert.ok([60, 99].every(width => states.every(s => footOf({ width, ...s }) === footOf({ width }))), 'key rows keep their count when the selection, marks, filter or mode change');
    const apps = { view: 'apps', width: 89, choices: [{ name: 'x', path: 'x.exe', isApp: true, exists: true }, { name: 'u', path: 'http://x', isUrl: true, exists: true }] };
    assert.equal(footOf(apps), footOf({ ...apps, selectedIndex: 1 }), 'apps: launch app and open in browser rows count the same');
    const help = withHints('short', { keysHelp: true }).join('\n');
    assert.ok(help.includes('Move') && help.includes('tab apps') && help.includes('^x archive') && help.includes('any key closes') && !help.includes('p0 '), 'key overlay lists every key over the list');
    assert.deepEqual(['on', 'off'].map(mouse => withHints('short', { keysHelp: true, full: true, settings: { keyHints: 'short', mouse } }).join(' ').includes('right-click')), [true, false], 'key overlay: right-click only with the mouse on');
    assert.ok(withHints('full', { view: 'workspaces', workspaces: [{ name: 'w', entries: [] }] }).join(' ').includes('^d delete'), 'workspaces keep ^d delete');
  }
});

test('row details + pinned section', () => {
  const two = [{ name: 'pin', path: 'P', exists: true, pinned: true, tags: ['w'] }, { name: 'gone', path: 'Q', exists: false, tags: ['x'] }];
  const look = (s, extra = {}) => strip(renderInteractiveView({ ...viewArgs, choices: two, settings: s, ...extra }));
  const both = look({});
  assert.ok(both.includes('#w  ★') && both.includes('#x  missing'), 'details: both by default');
  assert.ok(!look({ rowDetails: 'tags' }).includes('missing') && look({ rowDetails: 'tags' }).includes('#x'), 'details: tags only');
  assert.ok(!look({ rowDetails: 'badges' }).includes('#w') && look({ rowDetails: 'badges' }).includes('missing'), 'details: badges only');
  assert.ok(!/#w|#x|★|missing/.test(look({ rowDetails: 'none' })), 'details: none');
  const sec = look({ pinned: 'section' }).split('\n');
  assert.ok(sec.findIndex(l => l.trim() === 'Pinned') < sec.findIndex(l => l.includes('pin ')) && sec.some(l => l.trim() === 'All'), 'section: headings');
  assert.ok(!sec.some(l => l.includes('★')), 'section: no pinned badge');
  assert.ok(!look({ pinned: 'section' }, { query: 'p' }).includes('Pinned'), 'section: no headings while searching');
  assert.ok(look({ pinned: 'section' }, { query: ' ' }).includes('Pinned'), 'section: a blank query keeps the headings');
  const manyPinned = { ...many, choices: many.choices.map((c, i) => ({ ...c, pinned: i < 3 })), settings: { pinned: 'section' } };
  for (const selectedIndex of [0, 3, 29]) assert.equal(renderInteractiveView({ ...manyPinned, height: 20, selectedIndex }).split('\n').length, 20, `section: fills the height (sel ${selectedIndex})`);
  assert.ok(strip(renderInteractiveView({ ...manyPinned, height: 20, selectedIndex: 29 })).includes('more'), 'section: scroll hint');
  assert.ok(look({}).includes('^p unpin') && look({}, { selectedIndex: 1 }).includes('^p pin'), 'pin key hint follows the row');
  assert.deepEqual([withPinned({ path: 'x', pinned: true }, false), withPinned({ path: 'x' }, true)], [{ path: 'x' }, { path: 'x', pinned: true }], 'withPinned');
});

test('mouse: SGR reports through real readline never leak into keys; the hit map follows scroll and option windows', async () => {
  const fed = await feed('a\x1b[<0;12;5M\x1b[<0;1', '2;5mb', '\x1b[<64;3;9M\x1b[<65;3;9M\x1b[<2;1;1m', '\x1b[<0;1x', '\x1b[M !!c');
  assert.equal(fed.keys, 'abxc', 'only real keys pass: split, broken and X10 reports are swallowed');
  assert.deepEqual(fed.events.map(e => [e.x, e.y, e.wheel, e.click, e.right]), [[12, 5, 0, false, false], [12, 5, 0, true, false], [3, 9, -1, false, false], [3, 9, 1, false, false], [1, 1, 0, false, true]], 'press, left release = click, wheel up/down, right release = right');
});

test('right-click menu: spliced over styled lines, under the row or above it near the bottom, inside the width', async () => {
  assert.equal(strip(splice('ab\x1b[2mcdef\x1b[22mgh', 3, 'XY')), 'abcXYfgh', 'splice keeps the columns around');
  assert.ok(splice('\x1b[2mabcdef\x1b[22m', 1, 'X').replaceAll('\x1b[0m', '').endsWith('X\x1b[2mcdef\x1b[22m'), 'splice re-applies the line style after');
  assert.equal(strip(splice('a', 3, 'X')), 'a  X', 'splice past the end pads');
  const frame = Array.from({ length: 10 }, () => '.'.repeat(30));
  const items = [{ label: 'edit' }, { label: 'archive' }];
  const below = overlayMenu(frame, { items, index: 1, line: 2, col: 28 }, 30);
  assert.deepEqual([below.hits.map(h => [h.line, h.from, h.to]), strip(below.lines[3]), strip(below.lines[5])], [[[4, 18, 30], [5, 18, 30]], '..................╭──────────╮', '..................│› archive │'], 'menu under the row, pulled inside the width');
  assert.equal(overlayMenu(frame, { items, index: 0, line: 8, col: 0 }, 30).hits[0].line, 5, 'menu above the row near the bottom');
  assert.ok(overlayMenu(frame.map(l => l.slice(0, 20)), { items: [{ label: 'open in Windows Terminal' }], index: 0, line: 2, col: 5 }, 20).lines.every(l => strip(l).length <= 20), 'menu labels clip to a narrow width');
  const escFed = await feed('\x1b', '\x1b[<65;3;9M', 'x');
  assert.ok(escFed.keys === 'x' && escFed.events.length === 1, 'esc right before a report: the report is not typed');
  assert.deepEqual([rowClick({}, 5, 0, true), rowClick({}, 5, 0, false), rowClick({ y: 5, at: 0 }, 5, 300, false), rowClick({ y: 5, at: 0, opened: true }, 5, 300, true), rowClick({ y: 5, at: 0, opened: true }, 5, 900, true), rowClick({ y: 4, at: 0, opened: true }, 5, 300, true)],
    ['open', 'select', 'open', 'skip', 'open', 'open'], 'click selected opens, double-click opens once');
  const twoLine = { ...viewArgs, height: 20, flash: 'Command "claude" not found.\nInstall it.' };
  const noFlash = rowsOf({ ...twoLine, flash: '' });
  const flashed = rowsOf(twoLine);
  const promptAt = noFlash.findIndex(l => l.includes('type to filter'));
  assert.ok(flashed.length === noFlash.length && flashed.every((l, i) => i === promptAt || l === noFlash[i]), 'flash moves no row');
  assert.ok(flashed[promptAt].endsWith(' Command "claude" not found. Install it.') && flashed[promptAt].length === 80, 'multi-line flash: one line, right end of the prompt line');
  const bare = { ...viewArgs, view: 'apps', settings: { keyHints: 'off' } };
  assert.equal(rowsOf({ ...bare, flash: 'x' }).length, rowsOf(bare).length, 'no footer: the flash still adds no row');
  assert.ok(rowsOf({ ...viewArgs, flash: 'too long '.repeat(20) })[3].length <= 80, 'long flash clips to the width');
  assert.ok(rowsOf({ ...viewArgs, mode: 'input', action: 'rename', inputBuffer: 'a b', flash: 'no spaces' })[3].includes('a b▏') && rowsOf({ ...viewArgs, mode: 'input', action: 'rename', inputBuffer: 'a b', flash: 'no spaces' })[3].endsWith('no spaces'), 'typing: the input and its flash share the line');
  {
    const typed = (width, action, inputBuffer, flash, inputName) => rowsOf({ ...viewArgs, width, mode: 'input', action, inputBuffer, flash, inputName })[3];
    assert.ok(typed(80, 'rename', 'x'.repeat(70), 'taken').endsWith('▏  taken'), 'typing: a short flash shows beside a long value');
    const ws = typed(60, 'wsadd', 'my work', 'names cannot contain spaces', 3);
    assert.ok(ws.length <= 60 && ws.includes('my work▏') && ws.endsWith(' names cannot contain spaces'), 'typing: a long label gives way to the value and the flash');
    assert.ok(typed(60, 'wsadd', 'x'.repeat(30), '', 3).length <= 60 && typed(60, 'wsadd', 'x'.repeat(30), '', 3).endsWith('x▏'), 'typing: the cursor end stays in the width');
  }
  assert.ok(rowsOf({ ...viewArgs, flash: 'a\tb\r\nc' })[3].endsWith(' a b c'), 'flash: tabs and line breaks become spaces');
  assert.ok(rowsOf({ ...viewArgs, marks: new Set(['s']), flash: 'hi' })[3].endsWith('hi') && rowsOf({ ...viewArgs, marks: new Set(['s']) })[3].endsWith('● 1 marked'), 'a flash covers the marked count for a moment');
  const head = strip(renderInteractiveView(tabArgs)).split('\n')[1];
  assert.equal(at(tabArgs, head.indexOf('Apps') + 1, 2)?.tab, 'apps', 'click a tab');
  assert.equal(at(tabArgs, head.indexOf('Settings') + 1, 2)?.tab, 'settings', 'click the Settings tab');
  assert.equal(at(tabArgs, 4, 2), undefined, 'click on the name is nothing');
  const scrolled = { ...many, height: 20, selectedIndex: 15 };
  const rows = strip(renderInteractiveView(scrolled)).split('\n');
  assert.equal(at(scrolled, 3, rows.findIndex(l => l.includes(' p13 ')) + 1)?.row, 13, 'list row maps through the scroll window');
  const narrow = { ...wideOpeners, selectedAppIndex: 3, width: 50 };
  const openRow = strip(renderInteractiveView(narrow)).split('\n').findIndex(l => l.includes('open with')) + 1;
  assert.equal(at(narrow, 15, openRow)?.opener, 1, 'the ‹… marker steps to the hidden neighbour');
  assert.equal(at(narrow, 28, openRow)?.opener, 3, 'click an opener');
  assert.equal(at(narrow, 16, openRow), undefined, 'gap between options is nothing');
  assert.equal(at({ ...many, height: 30, settings: { keyHints: 'off' } }, 14, off.findIndex(l => l.includes('open with')) + 1)?.opener, 0, 'key hints off: opener row stays clickable');
  const setLines = strip(renderInteractiveView(setArgs)).split('\n');
  const sortLine = setLines.findIndex(l => l.includes('Sort')) + 1;
  assert.deepEqual([at(setArgs, setLines[sortLine - 1].indexOf('Most used') + 1, sortLine)].map(t => [t.setting, t.option]), [[11 + win, 0]], 'click a settings option');
  assert.equal(at(setArgs, 5, sortLine)?.option, undefined, 'click a settings label just picks the row');
});

test('appearance: paths, compact density, accent, the appearance rows', () => {
  assert.deepEqual([pathLook({ text: 'a/b' }, 'hidden').text, pathLook({ text: 'u', style: 'url' }, 'hidden').text, pathLook({ text: 'a', style: 'plain' }, 'hidden').text], ['', '', 'a'], 'hidden blanks paths and urls, not plain rows');
  assert.equal(pathLook({ text: 'a/b', style: 'path' }, 'full').style, 'plain', 'full = undimmed');
  assert.ok(!strip(renderInteractiveView({ ...viewArgs, settings: { paths: 'hidden' } })).split('\n').find(l => l.startsWith('  › s ')).includes('P'), 'hidden paths in the selector');
  const roomy = rowsOf({ ...many, height: 20 });
  const tight = rowsOf({ ...many, height: 20, settings: { density: 'compact' } });
  assert.ok(tight.length === 20 && tight.filter(l => / p\d+ /.test(l)).length > roomy.filter(l => / p\d+ /.test(l)).length, 'compact fits more rows in the same height');
  assert.equal(at({ ...tabArgs, settings: { density: 'compact' } }, rowsOf({ ...tabArgs, settings: { density: 'compact' } })[0].indexOf('Apps') + 1, 1)?.tab, 'apps', 'compact header still clickable');
  assert.ok(renderInteractiveView({ ...setArgs, settings: { ...setArgs.settings, accent: 'blue' } }).includes(chalk.blueBright('‹ A to Z ›')), 'accent colors the picked option');
  const tall = strip(renderInteractiveView({ ...setArgs, height: 80, settings: { ...setArgs.settings, theme: 'light' } }));
  assert.ok(tall.includes('Web theme       System  Dark  ‹ Light ›'), 'web theme row');
  assert.ok(['General', 'Search', 'Terminals', 'Opening', 'List', 'Rows', 'Look', 'Detail pane'].every(s => tall.includes(`\n  ${s}\n`)), 'settings grouped in sections');
  // scope tag right of each row, inside the width; type to filter by label, option or note
  assert.ok(/Web theme {7}System {2}Dark {2}‹ Light › +web$/.test(tall.split('\n').find(l => l.includes('Web theme'))) && tall.split('\n').every(l => l.length <= 80), 'scope tag at the row end');
  assert.ok(tall.includes('Shortcuts, Apps') && tall.includes('After open') && tall.includes('Message time') && tall.includes('Pane on narrow'), 'clearer labels');
  assert.deepEqual([settingsList({}, 'ascii').rows.map(r => r.key), settingsList({}, ' AFTER open').rows.map(r => r.key)], [['glyphs'], ['enter']], 'filter by option and label, any case');
  assert.deepEqual(settingsList({ terminalLayout: 'windows' }, 'exit comes back').rows.map(r => r.key), ['terminalLayout'], 'a note of another value still matches');
  assert.deepEqual([settingsList({}, 'old', [], [{ name: 'old', path: '/o' }]).more.length, settingsList({}, 'zzz', [{ section: 'Maintenance', kind: 'doctor', name: 'Doctor' }]).more.length], [1, 0], 'filter archived and extras');
  const themeOnly = strip(renderInteractiveView({ ...setArgs, query: 'web theme', settingIndex: 0 }));
  assert.ok(themeOnly.includes('› web theme') && themeOnly.includes('› Web theme') && !themeOnly.includes('Sort') && themeOnly.includes('esc clear'), 'filtered settings view');
  assert.ok(strip(renderInteractiveView({ ...setArgs, query: 'zzz', settingIndex: 0 })).includes('No settings match.'), 'no match');
  const short = rowsOf({ ...setArgs, height: 14, settingIndex: 22 + win });
  assert.ok(short.length <= 14 && short.some(l => l.startsWith('  › Web theme')) && short.at(-1).includes('setting'), 'short terminal scrolls settings, keeps the footer');
  assert.equal(at({ ...setArgs, height: 14, settingIndex: 21 + win }, 3, short.findIndex(l => l.startsWith('  › Web theme')) + 1)?.setting, 21 + win, 'scrolled settings stay clickable');
  const arcShort = { ...setArgs, archived: [{ name: 'old', path: '/old/dir' }], height: 14, settingIndex: 32 + win };
  assert.equal(at(arcShort, 3, rowsOf(arcShort).findIndex(l => l.startsWith('  › old')) + 1)?.setting, 32 + win, 'last archived row scrolls into view, stays clickable');
  assert.equal(checkSettings({ accent: 'red' }).error, 'accent must be one of: default, green, blue, purple, orange, or a hex color like #ff66aa.', 'bad accent refused');
  assert.deepEqual([checkSettings({ accent: '#FF66aa' }).next.accent, checkSettings({ accent: 'ff66aa' }).next.accent, checkSettings({ sort: '#ff66aa' }).error?.slice(0, 4)], ['#ff66aa', '#ff66aa', 'sort'], 'hex only for accent, normalized');
  assert.deepEqual([setting('accent', { accent: '#ff66aa' }), setting('accent', { accent: '#ff66a' }), setting('accent', { accent: '"><x' })], ['#ff66aa', 'default', 'default'], 'stored hex read back, junk falls back');
  assert.equal(accentOf('#ff66aa')('x'), chalk.hex('#ff66aa')('x'), 'hex accent via chalk.hex (it downsamples by color level)');
  const hexSet = strip(renderInteractiveView({ ...setArgs, height: 44, settings: { ...setArgs.settings, accent: '#ff66aa' } }));
  assert.ok(hexSet.includes('‹ #ff66aa ›'), 'hex accent shows as its own picked option');
  assert.deepEqual(resetSettings({ sort: 'name', accent: 'blue', apps: { x: 'y' }, workspaces: {} }, ['sort']), { accent: 'blue', apps: { x: 'y' }, workspaces: {} }, 'reset one setting');
  assert.deepEqual(resetSettings({ sort: 'name', defaultOpener: 'vscode', accent: '#ff66aa', apps: { x: 'y' } }), { apps: { x: 'y' } }, 'reset all keeps openers and workspaces');
  assert.deepEqual([startTab({ startView: 'last', lastView: 'apps' }), startTab({ startView: 'last' }), startTab({ startView: 'last', lastView: 'last' }), startTab({ startView: 'workspaces', lastView: 'apps' })], ['apps', 'shortcuts', 'shortcuts', 'workspaces'], 'start view last');
});

test('esc clears a filter first, success flash is green, ^z undo hint and restore checks', () => {
  assert.ok(v({}).includes('esc quit') && v({ query: 's' }).includes('esc clear') && v({ query: 's', mode: 'input', action: 'add' }).includes('esc cancel'), 'esc hint says what esc does');
  assert.ok(v({ view: 'workspaces', query: 'd' }).includes('esc clear'), 'workspaces too');
  assert.ok(v({}).includes('^u web ui') && v({ view: 'workspaces' }).includes('^u web ui'), '^u hint');
});

test('settings: openers and maintenance rows above Archived, stats and doctor lines', () => {
  const extras = [{ section: 'Openers', kind: 'opener', name: 'zed', text: 'zed' }, { section: 'Maintenance', kind: 'stats', name: 'Stats', text: 'web 3' }];
  const ex = (i, more = {}) => strip(renderInteractiveView({ ...setArgs, extras, archived: [{ name: 'old', path: '/o' }], height: 80, settingIndex: i, ...more }));
  const e0 = ex(32 + win);
  assert.ok(e0.indexOf('Openers') < e0.indexOf('Maintenance') && e0.indexOf('Maintenance') < e0.indexOf('Archived 1'), 'extra sections in order');
  assert.ok(e0.includes('› zed') && e0.includes('↵ edit command') && e0.includes('^d remove'), 'opener row keys');
  assert.ok(ex(33 + win, { expanded: { kind: 'stats', lines: ['web  3'] } }).includes('↵ hide') && ex(33 + win, { expanded: { kind: 'stats', lines: ['web  3'] } }).includes('      web  3'), 'stats lines under its row');
  assert.ok(ex(34 + win).includes('› old') && ex(34 + win).includes('↵ restore'), 'archived index after the extras');
  assert.ok(strip(renderInteractiveView({ ...setArgs, mode: 'confirm', ask: 'remove opener "zed"?' })).includes('? remove opener "zed"?  y / n'), 'settings confirm question');
  const day = 86400000;
  const sl = statLines({ code: { displayName: 'VS Code' } }, [{ name: 'web', opener: 'code', ts: 10 * day }, { name: 'web', ts: 11 * day }, { name: 'api', ts: 11 * day }], 12 * day).map(strip);
  assert.ok(sl[0].startsWith('web') && sl[0].endsWith('2') && sl.some(l => l.includes('VS Code 1')), 'stats lines');
  assert.deepEqual(strip(statLines({}, [], 0)[0]), 'No opens in the last 30 days.', 'no stats');
  assert.ok(strip(doctorLines([['warn', 'paths', '1 broken']])[0]).startsWith('warn  paths'), 'doctor line');
});

test('script picker: ^s hint, the picker rows, package.json reading', () => {
  const picker = v({ mode: 'scripts', scripts: { pm: 'pnpm', list: [{ name: 'dev', path: 'vite' }, { name: 'build', path: 'vite build' }] }, scriptIndex: 1 });
  assert.ok(v({}).includes('^s scripts'), '^s hint on Shortcuts');
  assert.ok(picker.includes('run a script of s (pnpm)') && /› build\s+vite build/.test(picker) && picker.includes('esc back') && !picker.includes('open with'), 'script picker view');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upex-pkg-'));
    assert.equal(readScripts(dir), null, 'no package.json');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    assert.deepEqual([readScripts(dir), detectPm(dir)], [{ dev: 'vite' }, 'pnpm'], 'scripts and package manager');
  }
  const webAt = 'http://127.0.0.1:4545/?t=x';
  assert.ok(!v({}).includes('upex ui running') && v({ webUrl: webAt }).includes(`● upex ui running  ${webAt}`) && v({ view: 'settings', settings: setArgs.settings, webUrl: webAt }).includes(webAt), 'running web ui shows its link in the selector');
  assert.ok(v({ webUrl: webAt, mode: 'input', action: 'add' }).includes(webAt), 'link stays while typing');
  assert.ok(v({ webUrl: webAt }).includes('^u stop web ui') && !v({}).includes('stop web ui'), '^u stops a running web ui');
  assert.ok(!v({}).includes('^z') && v({ undo: true }).includes('^z undo') && v({ view: 'apps', undo: true }).includes('^z undo'), '^z hint only while undo is available');
  const lvl = chalk.level;
  chalk.level = 1;
  assert.ok(renderInteractiveView({ ...viewArgs, flash: { text: 'added "x"', ok: true } }).includes(chalk.green('added "x"')), 'success flash is green');
  assert.ok(renderInteractiveView({ ...viewArgs, flash: 'path not found' }).includes(chalk.yellow('path not found')), 'plain flash stays yellow');
  {
    // A shortcut shown twice (two tags, recent strip) keeps both rows lit while its archive is asked.
    const dup = [{ name: 'a', path: 'P', exists: true }, { name: 'b', path: 'Q', exists: true }, { name: 'a', path: 'P', exists: true }];
    const dimmed = renderInteractiveView({ ...viewArgs, choices: dup, mode: 'confirm', action: 'archive' }).split('\n').filter(l => l.startsWith(chalk.dim(' ').slice(0, 4)) && / [ab] /.test(strip(l)));
    assert.deepEqual(dimmed.map(l => strip(l).trim()[0]), ['b'], 'confirm dims only the rows it is not about');
  }
  chalk.level = lvl;
  assert.equal(undoFlash({ at: 0, added: ['a', 'b'], removed: [], changed: ['c'], left: 3 }, 120000), 'undid the change from 2m ago · brought back a, b · reverted c · 3 more', 'selector ^z flash says what came back');
  assert.equal(undoFlash({ at: 0, added: [], removed: ['x'], changed: [], left: 0 }, 0), 'undid the change from 0m ago · removed x', 'no steps left: no count');
  assert.equal(undoFlash({ at: 0, added: ['dev'], removed: [], changed: [], left: 0, workspaces: true }, 0), 'undid the workspace change from 0m ago · brought back dev', 'workspace undo flash says so');
});

test('views setting: Tab cycle, header, start tab fallback', () => {
  assert.deepEqual([nextView('shortcuts'), nextView('apps', 'no-workspaces'), nextView('shortcuts', 'no-apps'), nextView('shortcuts', 'shortcuts'), nextView('settings', 'shortcuts')],
    ['apps', 'shortcuts', 'workspaces', 'shortcuts', 'shortcuts'], 'Tab cycles the shown tabs');
  assert.deepEqual([backTo('apps', 'all'), backTo('apps', 'no-apps'), backTo('workspaces', 'shortcuts')], ['apps', 'shortcuts', 'shortcuts'], 'Shift+Tab back to a hidden tab goes to Shortcuts');
  assert.deepEqual([startTab({ startView: 'apps', views: 'no-apps' }), startTab({ startView: 'last', lastView: 'workspaces', views: 'shortcuts' }), startTab({ startView: 'workspaces', views: 'no-apps' })],
    ['shortcuts', 'shortcuts', 'workspaces'], 'a hidden start tab falls back to Shortcuts');
  const onlyS = strip(renderInteractiveView({ ...viewArgs, settings: { views: 'shortcuts' } }));
  assert.ok(!onlyS.includes('Apps') && !onlyS.includes('Workspaces') && !onlyS.includes('tab '), 'only Shortcuts: no other tabs, no tab hint');
  const noWs = strip(renderInteractiveView({ ...viewArgs, view: 'apps', choices: [], settings: { views: 'no-workspaces' } }));
  assert.ok(!noWs.includes('Workspaces') && noWs.includes('tab shortcuts'), 'hidden Workspaces: header and tab hint skip it');
});

test('marks: pointer column, count, hints, confirm', () => {
  const markArgs = { ...viewArgs, selectedIndex: 1, choices: [{ name: 's', path: 'P', exists: true }, { name: 't', path: 'Q', exists: true }], marks: new Set(['s']) };
  const marked = strip(renderInteractiveView(markArgs)).split('\n');
  assert.ok(marked.some(l => l.startsWith('  ● s ')) && marked.some(l => l.startsWith('  › t ')), 'marked row shows ●, the highlight keeps ›');
  assert.equal(marked.find(l => l.startsWith('  ● s ')).indexOf('P'), marked.find(l => l.startsWith('  › t ')).indexOf('Q'), 'the mark keeps the row layout');
  assert.ok(marked.join('\n').includes('● 1 marked') && marked.join('\n').includes('↵ open 1 marked') && marked.join('\n').includes('^x archive 1 marked') && marked.join('\n').includes('esc unmark'), 'marked count and hints');
  assert.ok(strip(renderInteractiveView(viewArgs)).includes('space mark'), 'space mark hint');
  assert.ok(strip(renderInteractiveView({ ...markArgs, mode: 'confirm', action: 'archiveMarked', marks: new Set(['s', 't']) })).includes('? archive 2 marked?  y / n'), 'confirm names the marked count');
  assert.ok(strip(renderInteractiveView({ ...markArgs, mode: 'confirm', action: 'archive', marks: new Set(['s', 't']) })).includes('? archive "t"?  y / n'), 'archive confirm names the one row, not the marks');
});
