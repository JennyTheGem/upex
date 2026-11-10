import './helpers.mjs';
import { strip, viewArgs, at } from './view.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { width } from '../src/ui.js';
import { goalSummary, goalsOf, oneLine } from '../src/rows.js';
import { remoteWebUrl, parseStatus, parseDiff, parseLog, gitOf, stopGit } from '../src/git.js';
import { parseRobocopy, parseDu, formatBytes, sizeCommand, sizeOf, stopSize } from '../src/size.js';
import { renderInteractiveView, detailLines, paneShown, paneToggles, paneWidthOf, dotLines, lr, withSamePath, scriptLines, markLines, goalText, goalPrompt } from '../src/interactive.js';

const det = { name: 'web', path: 'E:/code/web', exists: true, pinned: true, tags: ['node'], uses: 3, lastUsed: Date.now() - 7200000, opener: 'explorer', aliases: [] };

test('remoteWebUrl: ssh/scp/https remotes to a web page, credentials dropped, local paths null', () => {
  assert.equal(remoteWebUrl('git@github.com:me/x.git'), 'https://github.com/me/x', 'scp-style');
  assert.equal(remoteWebUrl('ssh://git@host.dev:2222/me/x.git'), 'https://host.dev/me/x', 'ssh url, port dropped');
  assert.equal(remoteWebUrl('https://u:tok@github.com/me/x/'), 'https://github.com/me/x', 'credentials + slash dropped');
  assert.equal(remoteWebUrl('http://git.lan:8080/a/b.git'), 'http://git.lan:8080/a/b', 'http port kept');
  assert.equal(remoteWebUrl('https://github.com/me/a"b'), 'https://github.com/me/a%22b', 'quote encoded');
  for (const local of [String.raw`C:\repos\x`,'C:/repos/x', '/home/me/x', '../x', 'file:///c/x']) assert.equal(remoteWebUrl(local), null, `local ${local}`);
  for (const evil of ['git@h.com:me/$(id).git', 'git@h.com:me/x?`id`', 'ssh://git@e"&calc&"x.com/r', 'git@h.com:%USERNAME%/x']) assert.equal(remoteWebUrl(evil), null, `shell-unsafe ${evil}`);
  assert.equal(remoteWebUrl('https://dev.azure.com/o/My%20Proj/_git/r'), 'https://dev.azure.com/o/My%20Proj/_git/r', 'percent escapes kept');
  assert.equal(remoteWebUrl('git@1.2.3.4.5:me/x'), null, 'bad host: null, no throw');
});

test('Full screen: footer on the last row; wide enough: detail pane beside the list.', () => {
  const fullV = renderInteractiveView({ ...viewArgs, full: true, height: 30, maxList: 8 }).split('\n');
  assert.ok(fullV.length === 30 && strip(fullV.slice(-3).join(' ')).includes('^x archive'), 'full screen pins the footer to the bottom');
  const paneV = strip(renderInteractiveView({ ...viewArgs, choices: [det], full: true, width: 150, height: 30 })).split('\n');
  assert.ok(paneV.some(l => l.includes('┬')) && paneV.some(l => l.includes('┴')) && paneV.every(l => l.length <= 150), 'pane joins the rules and stays in width');
  assert.ok(paneV.some(l => /│ ★ web +3 opens · 2h ago · Explorer$/.test(l)), 'pane shows the selected details');
  assert.ok(!paneV.some(l => l.includes('aliases')) && !strip(renderInteractiveView({ ...viewArgs, choices: [det], width: 150 })).includes('│'), 'no empty rows, no pane inline');
});

test('Narrow: Shift+Right opens the pane (or Pane on narrow Always), never under 60 or inline.', () => {
  assert.deepEqual([paneShown(150, true), paneShown(100, true), paneShown(100, true, true), paneShown(59, true, true), paneShown(150, false)], [true, false, true, false, false], 'pane: wide, or opened on narrow');
  assert.deepEqual([paneToggles(100, true), paneToggles(150, true), paneToggles(100, false), paneToggles(100, true, { narrowPane: 'always' })], [true, false, false, false], 'Shift+Right/Left toggle only narrow, full screen, not Always');
  assert.deepEqual([paneWidthOf(150, 'narrow'), paneWidthOf(150), paneWidthOf(150, 'wide'), paneWidthOf(300, 'wide'), paneWidthOf(150, 'junk')], [42, 57, 75, 110, 57], 'pane width: narrow / normal / wide, capped, unknown = normal');
  const thin = extra => strip(renderInteractiveView({ ...viewArgs, choices: [det], full: true, width: 99, height: 30, ...extra }));
  assert.ok(!thin().includes('│') && thin().includes('S-→ details'), 'narrow: no pane, Shift+Right hint');
  assert.ok(thin({ paneOpen: true }).includes('3 opens ·') && thin({ paneOpen: true }).includes('esc hide details') && !thin({ paneOpen: true }).includes('S-←'), 'narrow opened: pane, Esc closes (one hint)');
  assert.ok(thin({ paneOpen: true, query: 's' }).includes('esc clear') && thin({ paneOpen: true, query: 's' }).includes('S-← hide details'), 'filter typed: Esc clears, S-← hint shows');
  assert.ok(thin({ settings: { narrowPane: 'always' } }).includes('3 opens ·') && !thin({ settings: { narrowPane: 'always' } }).includes('details'), 'Always: pane without the toggle');
  assert.deepEqual(dotLines(['aa', 0, 'bb', 'cccc'], 7).map(strip), ['aa · bb', 'cccc'], 'dotLines: skips empty parts, wraps at the width');
  assert.deepEqual([lr('abc', 'xy', 8), lr('abcdefgh', 'xy', 8), lr('GIT', 'a-long-branch', 10, 3), lr('a', '', 5)].map(strip), ['abc   xy', 'abc…  xy', 'GIT  a-lo…', 'a'], 'lr: right-aligned, left clips first, right cut to keep the left');
  assert.ok([8, 10, 16].every(n => width(lr('日本語の名前', 'x'.repeat(30), n)) === n), 'lr stays in width');
  assert.ok(strip(detailLines({ name: 'averylongshortcutname', uses: 3, lastUsed: Date.now() - 7200000, opener: 'explorer' }, 30)[0]).startsWith('averylong…  3 opens'), 'pane title: the name keeps 10 columns');
  assert.deepEqual(strip(detailLines({ name: 'dev', entries: [{ shortcut: 's', app: 'vscode' }] }, 40).join('|')), 'dev||s:vscode', 'workspace pane lists entries');
  assert.ok(!detailLines({ name: 'x', path: 'P', added: 'garbage' }, 60).join().includes('added'), 'a bad added date is left out, not thrown');
});

test('Same path: other folder shortcuts on it (trailing slash ignored), shown as a pane row.', () => {
  const sp = withSamePath([{ name: 'a', path: 'X/y', isDir: true }, { name: 'b', path: 'X/y/', isDir: true }, { name: 'c', path: 'X/z', isDir: true }, { name: 'u', path: 'X/y', isUrl: true }]);
  assert.deepEqual(sp.map(c => c.same), [['b'], ['a'], [], undefined], 'withSamePath');
  assert.ok(strip(detailLines({ ...det, same: ['b'] }, 60).join('|')).includes('same path as b') && !strip(detailLines(det, 60).join('|')).includes('same path'), 'same path row');
});

test('Note: wrapped at spaces, 3 lines at most, the last clipped.', () => {
  assert.ok(strip(detailLines({ ...det, note: 'one two three four five six seven' }, 14).join('|')).includes('▎ one two|▎ three four|▎ five six se…'), 'note wraps');
  assert.ok(!strip(detailLines(det, 60).join('|')).includes('note'), 'no note, no row');
  const day = 86400000;
  const staleRow = c => detailLines({ name: 'x', path: 'P', ...c }, 80).some(l => l.archive && /^stale 30\+ days +\^x archive$/.test(strip(l.text)));
  assert.deepEqual([staleRow({ lastUsed: Date.now() - 31 * day }), staleRow({ lastUsed: Date.now() - day }), staleRow({ added: Date.now() - day }), staleRow({ added: Date.now() - 40 * day })], [true, false, false, true], 'stale hint after 30 days');
  {
    const targets = [];
    const sv = strip(renderInteractiveView({ ...viewArgs, choices: [{ ...det, lastUsed: Date.now() - 31 * day }], full: true, width: 150, height: 30, targets })).split('\n');
    const y = sv.findIndex(l => l.includes('│ stale 30+ days '));
    assert.ok(y >= 0 && targets.some(t => t.archive && t.line === y), 'stale line clicks to archive');
  }
});

test('Open goals: planned/partial count, by phase then file order; the pane shows up to the setting\'s count.', () => {
  const gs = goalSummary({ items: [{ id: 'a', title: 'A', phase: 'later', status: 'planned' }, { id: 'b', title: 'B', phase: 'maybe', status: 'partial' },
    { id: 'c', title: 'C', phase: 'now', status: 'done' }, { id: 'd', title: 'D', phase: 'next', status: 'planned' }, { id: 'e', title: 'E', phase: 'odd', status: 'planned' }, { id: 'f', title: 'F', phase: 'later', status: 'planned' }, { id: 'g', status: 'dropped' }] });
  assert.deepEqual([gs.open, gs.done, gs.total, gs.next.map(g => g.id)], [5, 1, 6, ['d', 'a', 'f', 'b', 'e']], 'goalSummary counts open, done, total without dropped, next by phase');
  assert.deepEqual([goalText({ id: 'i', title: 'T', body: 'B' }), goalText({ id: 'i', title: 'T' })], ['i: T\nB', 'i: T'], 'goalText: id: title, body below');
  assert.deepEqual([goalPrompt({ id: '3.2', title: 'Fix "x" & %PATH%; $(rm) `id` !! ^|<>\\\n' }), goalPrompt({ title: 'T' })], ['"do goal 3.2 next: Fix x PATH rm id"', '"do goal next: T"'], 'goalPrompt: shell-safe quoted prompt');
  assert.deepEqual([goalSummary({}), goalSummary(null), goalSummary({ items: [null] })], [null, null, { open: 0, done: 0, total: 0, next: [] }], 'goalSummary: not a goals file');
  const gdir = fs.mkdtempSync(path.join(os.tmpdir(), 'upex-goals-'));
  assert.equal(goalsOf(gdir), null, 'no goals.json: nothing');
  fs.writeFileSync(path.join(gdir, 'goals.json'), '{ broken');
  assert.equal(goalsOf(gdir), null, 'broken goals.json: nothing, no throw');
  fs.writeFileSync(path.join(gdir, 'goals.json'), JSON.stringify({ items: ['Ship\nit', 'two', 'three', 'four'].map((title, i) => ({ id: `g${i}`, title, phase: 'now', status: 'planned' })) }));
  fs.utimesSync(path.join(gdir, 'goals.json'), new Date(), new Date(Date.now() + 5000));
  assert.equal(goalsOf(gdir)?.open, 4, 'changed goals.json is read again');
  const gdet = { ...det, path: gdir };
  const goalPane = (goals, extra) => strip(renderInteractiveView({ ...viewArgs, choices: [gdet], full: true, width: 150, height: 30, settings: { goals }, ...extra }));
  assert.ok(goalPane('3').includes('▱▱▱▱▱▱▱▱▱▱ 0/4') && goalPane('3').includes('│   now        Ship it') && !goalPane('3').includes('four') && goalPane('5').includes('four') && !goalPane('off').includes('GOALS'), 'pane goals: up to the setting, off hides them');
  {
    const bdir = fs.mkdtempSync(path.join(os.tmpdir(), 'upex-goals-'));
    fs.writeFileSync(path.join(bdir, 'goals.json'), JSON.stringify({ items: ['done', 'done', 'done', 'planned'].map((status, i) => ({ id: `b${i}`, phase: 'now', status })) }));
    const bp = strip(renderInteractiveView({ ...viewArgs, choices: [{ ...det, path: bdir }], full: true, width: 150, height: 30, settings: { goals: '3' } }));
    assert.ok(bp.includes('▰▰▰▰▰▰▰▰▱▱ 3/4'), 'goal bar fills by done/total');
  }
  assert.ok(strip(detailLines(det, 40, [], Date.now(), { goals: { open: 1, done: 0, total: 1, next: [{ id: 'w', title: 'T', phase: 'wayLater' }] }, sel: 0 }).at(-1).text) === '  wayLater › T', 'goal phase column fits wayLater');
  assert.ok(goalPane('3').includes('S-→ goals') && goalPane('3', { mode: 'goals', goalIndex: 1 }).includes('│            › two') && goalPane('3', { mode: 'goals' }).includes('↵ copy'), 'S-→ goal picker marks the picked goal');
  const shortPane = goalPane('5', { mode: 'goals', goalIndex: 3, height: 14 }).split('\n');
  assert.ok(shortPane.some(l => l.includes('› four')) && shortPane.length === 14, 'short pane scrolls to the picked goal');
  {
    const targets = [];
    const lines = goalPane('3', { targets }).split('\n');
    const tOf = s => targets.find(t => t.line === lines.findIndex(l => l.includes(s)) && t.copy);
    assert.deepEqual([tOf('│              two')?.copy, tOf('│              two')?.msg], ['g1: two', 'copied "g1"'], 'pane goal lines click to copy');
  }
  assert.equal(oneLine('a\x1b[2J\u009b1m\n b'), 'a [2J 1m b', 'goals.json text: no escapes, one line');
  fs.rmSync(gdir, { recursive: true, force: true });
});

test('Git status: parsed from porcelain v2, shown when the setting is on, web line clickable.', () => {
  assert.deepEqual(parseStatus('# branch.oid abc\n# branch.head main\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 a b src/x.js\n? new.txt\n'), { branch: 'main', ahead: 2, behind: 1, changed: 2 }, 'parseStatus');
  assert.deepEqual([parseDiff(' 3 files changed, 10 insertions(+), 2 deletions(-)\n'), parseDiff(' 1 file changed, 1 deletion(-)'), parseDiff(null)], [{ added: 10, deleted: 2 }, { added: 0, deleted: 1 }, { added: 0, deleted: 0 }], 'parseDiff');
  assert.deepEqual([parseLog('1700000000 fix it'), parseLog(''), parseLog(null)], [{ time: 1700000000000, subject: 'fix it' }, null, null], 'parseLog');
  {
    const g = { branch: 'dev', ahead: 1, behind: 0, changed: 3, last: { time: Date.now() - 7200000, subject: 'ship\nit' }, web: 'https://github.com/o/r' };
    const targets = [];
    const gargs = { ...viewArgs, choices: [det], full: true, width: 150, height: 30, gitFor: () => g, targets };
    const on = strip(renderInteractiveView({ ...gargs, settings: { git: 'on' } })).split('\n');
    assert.ok(on.some(l => /│ GIT +dev  ↑1$/.test(l)) && on.some(l => l.includes('│   3 files changed')) && on.some(l => /│   ship it +2h ago$/.test(l)), 'pane shows git status');
    const y = on.findIndex(l => /│   github\.com\/o\/r +\^g$/.test(l));
    assert.ok(y >= 0 && targets.some(t => t.web && t.line === y) && on.some(l => l.includes('^g github')), 'web line clickable, ^g hint');
    assert.ok(!strip(renderInteractiveView({ ...gargs, settings: {} })).includes('│ GIT'), 'git off by default');
    assert.ok(strip(detailLines(det, 60, [], Date.now(), { git: { branch: 'm', changed: 0 } }).join('|')).includes('|  clean'), 'clean repo, no web line');
    const alias = strip(renderInteractiveView({ ...gargs, gitFor: () => ({ ...g, web: 'https://gh-work/o/r' }), settings: { git: 'on' } }));
    assert.ok(alias.includes('^g gh-work') && !alias.includes('undefined'), 'one-label host hint');
  }
});

test('gitOf: one lookup at a time, a fresh cache is not looked up again, stopGit drops a running one.', async () => {
  const [a, b, c] = [0, 1, 2].map(() => fs.mkdtempSync(path.join(os.tmpdir(), 'upex-git-')));
  const seen = [];
  const land = dir => new Promise(res => gitOf(dir, () => { seen.push(dir); res(); }));
  const la = land(a);
  land(b); // busy: no lookup, never lands
  await la;
  gitOf(a, () => seen.push('again')); // fresh: no lookup
  await land(b); // never lands (exit 13) if a was looked up again
  gitOf(path.join(c, 'x'), () => seen.push('stopped'));
  stopGit();
  await land(c); // never lands if the stopped one kept the slot
  assert.deepEqual(seen, [a, b, c], 'gitOf one at a time, cached, stoppable');
  for (const d of [a, b, c]) fs.rmSync(d, { recursive: true, force: true });
});

test('Folder size: robocopy summary in any language, du + wc, the pane line, a real lookup.', async () => {
  const de = '\n  Verzeich.:      3893      3893         0         0         0         0\n  Dateien:     32218     32218         0         0         0         0\n    Bytes: 835633619 835633619         0         0         0         0\n   Zeiten:   0:00:00   0:00:00                       0:00:00   0:00:00\n';
  const en = '2026/11/10 02:39:05 ERROR 5 (0x00000005) Access denied\n   Dirs :  2  2  0  0  0  0\r\n  Files :  1  1  0  0  0  0\r\n  Bytes :  5  5  0  0  0  0\r\n';
  assert.deepEqual([parseRobocopy(de), parseRobocopy(en), parseRobocopy('ERROR : bad\n')], [{ files: 32218, bytes: 835633619 }, { files: 1, bytes: 5 }, null], 'parseRobocopy');
  assert.deepEqual([parseDu('12\t/a b\n  3\n'), parseDu(''), parseDu('0\n')], [{ files: 3, bytes: 12288 }, null, null], 'parseDu');
  assert.deepEqual([0, 1023, 2048, 835633619, 3.2 * 2 ** 30].map(formatBytes), ['0 B', '1023 B', '2.0 KB', '797 MB', '3.2 GB'], 'formatBytes');
  assert.equal(sizeCommand('C:\\', 'win32')[1][0], 'C:\\.', 'drive root keeps no bare trailing backslash');
  assert.equal(sizeCommand('D:\\a b\\', 'win32')[1][0], 'D:\\a b', 'trailing backslash dropped');
  assert.equal(sizeCommand('/x y', 'linux')[1].at(-1), '/x y', 'path passed as $1, not in the script');
  const sargs = { ...viewArgs, choices: [det], full: true, width: 150, height: 30, gitFor: () => null, sizeFor: () => ({ files: 1200, bytes: 5 * 2 ** 20 }) };
  assert.ok(strip(renderInteractiveView({ ...sargs, settings: { size: 'on' } })).includes('5.0 MB in 1,200 files'), 'pane shows folder size');
  assert.ok(!strip(renderInteractiveView({ ...sargs, settings: { size: 'off' } })).includes('5.0 MB'), 'size off hides it');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upex size '));
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'x'.repeat(3000));
  sizeOf(path.join(dir, 'gone'), () => assert.fail('a dropped lookup landed'));
  const got = await new Promise(res => sizeOf(dir, () => res(sizeOf(dir))));
  assert.equal(got?.files, 2, 'real lookup counts files');
  assert.ok(os.platform() === 'win32' ? got.bytes === 3005 : got.bytes >= 3005, 'real lookup sizes them');
  const link = `${dir} link`;
  fs.symlinkSync(dir, link, 'junction');
  assert.equal((await new Promise(res => sizeOf(link, () => res(sizeOf(link)))))?.files, 2, 'a linked folder is sized, not the link');
  fs.unlinkSync(link);
  sizeOf(path.join(dir, 'sub'), () => assert.fail('a stopped lookup landed'));
  stopSize();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('^s with the pane: scripts there, the shortcut list stays; a pane row click picks that script.', () => {
  const sargs = { ...viewArgs, choices: [det], full: true, width: 150, height: 30, mode: 'scripts', scriptIndex: 1, scripts: { pm: 'npm', list: [{ name: 'dev', path: 'vite' }, { name: 'build', path: 'vite build' }] } };
  const sp = strip(renderInteractiveView(sargs)).split('\n');
  const y = sp.findIndex(l => l.includes('› build'));
  assert.ok(sp.some(l => /› web .*│ scripts 2$/.test(l)) && /│ › build +vite build$/.test(sp[y]) && !sp.some(l => l.includes('opens in')), 'pane script picker beside the list');
  assert.deepEqual([at(sargs, 140, y + 1)?.row, at(sargs, 10, y + 1)?.row], [1, undefined], 'pane script rows are the clickable ones');
  const tall = scriptLines({ list: Array.from({ length: 20 }, (_, i) => ({ name: `s${i}`, path: 'x' })) }, 15, 40, 8);
  assert.ok(tall.some(l => l.i === 15) && tall.length <= 8 && strip(tall.at(-1)).includes('more'), 'pane scripts scroll to the picked one');
  const short = scriptLines({ list: Array.from({ length: 10 }, (_, i) => ({ name: `s${i}`, path: 'x' })) }, 9, 40, 4);
  assert.ok(short.length === 4 && short.some(l => l.i === 9), 'short pane: the picked script still fits');
  // Marks: the pane lists them and what Enter / ^d do, instead of the selected row.
  const mk = [{ c: { name: 'web', path: 'P' }, app: 'cmd', count: 2 }, { c: { name: 'u', isUrl: true } }, { c: { name: 'gone', exists: false } }];
  const mp = strip(renderInteractiveView({ ...viewArgs, choices: [det], full: true, width: 150, height: 30, marks: new Set(['web']), marked: mk }));
  assert.ok(/│ ● 3 marked$/m.test(mp) && /│ {3}web +cmd ×2$/m.test(mp) && /│ {3}u +browser$/m.test(mp) && /│ {3}gone +missing$/m.test(mp) && mp.includes('^x archives all 3') && !mp.includes('opens in'), 'pane lists the marks');
  const cut = markLines(Array.from({ length: 10 }, (_, i) => ({ c: { name: `m${i}` }, app: 'x' })), 40, 8).map(strip);
  assert.ok(cut.length === 8 && cut.includes('  ↓ 8 more') && cut.at(-1).startsWith('^x'), 'many marks: list cut, ^x line kept');
});

test('Full screen without the pane: the opener row is still clickable after the footer moves down.', () => {
  const fullA = { ...viewArgs, full: true, height: 30 };
  assert.equal(at(fullA, 15, strip(renderInteractiveView(fullA)).split('\n').findIndex(l => l.includes('open with')) + 1)?.opener, 0, 'full screen: opener row hit follows the pinned footer');
  // width is the terminal minus its last column: 140 columns get the pane.
  assert.deepEqual([139, 138].map(width => renderInteractiveView({ ...fullA, width }).includes('┬')), [true, false], 'pane from 140 columns');
});
