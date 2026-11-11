import { home } from './helpers.mjs';
import { strip, viewArgs, v } from './view.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import chalk from 'chalk';
import { withPinned } from '../src/store.js';
import { setting } from '../src/settings.js';
import { truncate, width, stripAnsi } from '../src/ui.js';
import { clipName, expandHome, underlineHits, expiryText } from '../src/rows.js';
import { renderInteractiveView, inView, byOrder, optionRow, prefill, editLine, kindOf, retyped, setField, fieldWords, completeTag, expiryOptions, formRows, formLines, inputLine, missingFlash, staysOpen, movePinned, sameGroup, withRecent, withGroups, filterChoices, noMatchOffers, maxListOf, jumpIndex, isAlt, rowOptions, pickedOf, clipPath, cwdTarget, targetEntry, asksMany, CTRL_BACKSPACE } from '../src/interactive.js';

const zs = new PassThrough();
readline.emitKeypressEvents(zs);

test('edit form (^e): types, field parsing, rows, render in the list and in the pane', () => {
  assert.deepEqual(['folder', 'app', 'cmd', 'url'], [{ path: '/p' }, { app: 'x' }, { app: 'npm t', terminal: true }, { url: 'x.dev' }].map(kindOf), 'kind of each entry');
  assert.deepEqual(retyped({ path: '/p', opener: 'vscode', tags: ['a'] }, 'cmd', 'npm t'), { tags: ['a'], app: 'npm t', terminal: true }, 'folder -> command drops path and opener');
  assert.deepEqual(retyped({ app: 'npm t', terminal: true }, 'folder', '/p'), { path: '/p' }, 'command -> folder drops terminal');
  assert.deepEqual([setField({ a: 1, n: 'x' }, 'n', ''), setField({ a: 1 }, 'tags', []), setField({ a: 1 }, 'n', 'y')], [{ a: 1 }, { a: 1 }, { a: 1, n: 'y' }], 'empty value drops the field');
  assert.deepEqual(fieldWords(' #web, api  web #'), ['web', 'api'], 'tags field: # and commas dropped, once each');
  assert.deepEqual([completeTag('api #ve', ['work', 'velora']), completeTag('x', ['y']), completeTag('', ['y'])], ['api #velora ', 'x', ''], 'tab completes the last tag');
  const D = 86400000;
  assert.deepEqual(expiryOptions({}, 0), { labels: ['never', '1d', '7d', '30d'], at: 0 }, 'no expiry: never picked');
  assert.deepEqual(expiryOptions({ expires: D - 5 }, 0), { labels: ['never', 'in 24h', '7d', '30d'], at: 1 }, 'just set 1d: in the 1d slot, so → goes on to 7d');
  assert.deepEqual(expiryOptions({ expires: 3 * D }, 0), { labels: ['never', '1d', 'in 3d', '30d'], at: 2 }, '3d left: in the 7d slot');
  assert.deepEqual(expiryOptions({ expires: 60 * D }, 0), { labels: ['never', '1d', '7d', '30d', 'in 60d'], at: 4 }, 'past 30d: its own slot last');
  assert.equal(expiryOptions({ expires: 5 }, 10).at, 0, 'expired counts as never');
  assert.deepEqual(formRows({ entry: { url: 'x' } }), ['name', 'target', 'type', 'tags', 'aliases', 'note', 'color', 'expires'], 'no opener row for a url');
  assert.deepEqual(formRows({ ws: true, entry: [{ shortcut: 'a' }, { shortcut: 'b' }] }), ['name', 0, 1], 'workspace rows: name, then entries');
  const entry = { path: home, tags: ['work'], note: 'hi there', opener: 'explorer' };
  const fl = formLines({ name: 'web', entry, field: 4, editing: false }, 60, [{ key: 'explorer', label: 'Explorer' }]).map(strip);
  assert.ok(fl[0].startsWith('  name') && !fl.some(l => l.endsWith('folder')) && fl.some(l => l.startsWith('› tags') && l.includes('#work')) && fl.some(l => l.includes('‹ Explorer ›')), 'form rows');
  assert.ok(fl.some(l => l.includes('tab completes')) && fl.every(l => l.length <= 60), 'form note, in width');
  const typing = formLines({ name: 'web', entry, field: 6, editing: true, buffer: 'new note', cursor: 8 }, 60).map(strip);
  assert.ok(typing.some(l => l.startsWith('› note') && l.includes('new note▏')), 'editing shows the input');
  // Values get the full width left of the label, no more: the cursor, a row's last option and a path's end stay in view.
  const narrow = formLines({ name: 'web', entry: { path: `${home}/${'d/'.repeat(20)}leaf` }, field: 1, editing: false }, 34).map(strip);
  assert.ok(narrow.find(l => l.startsWith('› target')).includes('…') && narrow.find(l => l.startsWith('› target')).endsWith('leaf  missing'), 'long target keeps its end');
  assert.ok(narrow.find(l => l.startsWith('  expires')).endsWith('›') && narrow.every(l => l.length <= 34), 'option row not cut by one');
  const long = formLines({ name: 'web', entry, field: 6, editing: true, buffer: 'x'.repeat(80), cursor: 80 }, 40).map(strip);
  assert.ok(long.find(l => l.startsWith('› note')).endsWith('x▏'), 'long input keeps its cursor');
  const ws = formLines({ name: 'dev', ws: true, entry: [{ shortcut: 'api', app: 'explorer', count: 2, start: 'npm run dev' }], field: 1 }, 60, [{ key: 'explorer', label: 'Explorer' }]).map(strip);
  assert.ok(ws.some(l => l.startsWith('› api') && l.includes('Explorer ×2') && l.includes('npm run dev')), 'workspace entry row');
  const form = { name: 's', entry: { path: home }, field: 0, editing: false, history: [] };
  const inList = strip(renderInteractiveView({ ...viewArgs, mode: 'form', form, height: 30 }));
  assert.ok(inList.includes('edit s') && inList.includes('› name') && inList.includes('↵ edit') && !inList.includes('open with'), 'form replaces the list when narrow');
  const inPane = strip(renderInteractiveView({ ...viewArgs, mode: 'form', form, width: 160, height: 30, full: true })).split('\n');
  assert.ok(inPane.some(l => l.includes('│') && l.includes('› name')), 'form in the pane when wide');
  assert.ok(strip(renderInteractiveView({ ...viewArgs, mode: 'form', form: { ...form, field: 2, kind: 'url' }, height: 30 })).includes('↵ new target'), 'picked type: enter asks for its target');
});

test('Ctrl+Z arrives as a ctrl z keypress', async () => {
  const zkey = await new Promise(r => { zs.once('keypress', (_, k) => r(k)); zs.write('\x1a'); });
  assert.ok(zkey.ctrl && zkey.name === 'z', 'Ctrl+Z arrives as a ctrl z keypress');
});

test('no dead ends: long names clip, prompts start prefilled, a missing path keeps the selector open', () => {
  assert.deepEqual(clipName('abcdefghij', 5, [[0, 1], [3, 6], [8, 9]]), { text: 'abcd…', hits: [[0, 1], [3, 3]] }, 'clip keeps hits inside the cut');
  assert.deepEqual(clipName('abc', 5, [[0, 2]]), { text: 'abc', hits: [[0, 2]] }, 'short name untouched');
  const longName = strip(renderInteractiveView({ ...viewArgs, selectedIndex: 1, choices: [{ name: 'n'.repeat(40), path: 'P1', exists: true }, { name: 'short', path: 'P2', exists: true }] })).split('\n');
  const p1 = longName.find(l => l.includes('P1'));
  assert.ok(p1.includes(`${'n'.repeat(23)}…  P1`) && p1.indexOf('P1') === longName.find(l => l.includes('P2')).indexOf('P2'), 'long name clipped, path column aligned');
  assert.deepEqual([prefill('rename', { name: 'n', path: 'C:/x' }), prefill('add', { name: 'n' })], ['n', ''], 'rename prefill, add starts empty');
  const typing = v({ mode: 'input', action: 'rename', inputBuffer: 's', height: 20 });
  {
    const home = os.homedir();
    const yes = () => true;
    assert.deepEqual([clipPath(`"${home}"`, yes), clipPath(' ~ ', yes), clipPath('relative/dir', yes), clipPath(`${home}
${home}`, yes), clipPath(home, () => false), clipPath('', yes)],
      [path.resolve(home), path.resolve(home), null, null, null, null], 'clipboard path: quotes and ~ ok, relative, multi-line or missing not');
    const adding = v({ mode: 'input', action: 'add', inputName: path.join(home, 'proj'), inputBuffer: 'proj', height: 30 });
    assert.ok(adding.includes('› new shortcut') && adding.includes('› name       proj▏') && /target\s+~[\\/]proj/.test(adding) && adding.includes('↵ add') && !adding.includes('open with'), 'add screen: name typed, clipboard path as target');
    assert.ok(v({ mode: 'input', action: 'add', height: 30 }).includes(path.basename(cwdTarget()) || 'none'), 'add screen without one: cwd');
    assert.deepEqual([cwdTarget('C:\\WINDOWS\\system32\\', 'win32', 'C:\\Windows'), cwdTarget('C:\\Windows\\System32', 'linux', 'C:\\Windows'), cwdTarget('C:\\dev', 'win32', 'C:\\Windows')], ['', 'C:\\Windows\\System32', 'C:\\dev'], 'System32 is no target');
    const st = (file, mode = 0o644) => () => ({ isFile: () => file, mode });
    const exe = path.resolve('C:\\t\\a.EXE');
    assert.deepEqual([targetEntry(' https://x.dev/a ', 'win32'), targetEntry(`"${exe}"`, 'win32', st(true)), targetEntry(exe, 'win32', () => null), targetEntry('C:\\t\\a.txt', 'win32', st(true)).app,
      targetEntry('/opt/run', 'linux', st(true, 0o755)).app, targetEntry('/opt/run', 'linux', st(true)).app, targetEntry('/opt', 'linux', st(false, 0o755)).app, targetEntry(''),
      targetEntry('http://a:b:c', 'linux', () => null).url, targetEntry('C://x', 'win32', () => null).url],
      [{ url: 'https://x.dev/a' }, { app: exe }, { path: exe }, undefined, path.resolve('/opt/run'), undefined, undefined, { path: '' }, undefined, undefined], 'target type: url, program file (quoted ok), missing or other file or folder = path, bad url or C:// a path');
    const typed = b => v({ mode: 'input', action: 'addTarget', inputName: 'n', inputBuffer: b, height: 30 });
    assert.ok(typed('https://x.dev').includes('‹ url ›') && (process.platform !== 'win32' || typed(process.execPath).includes('‹ app ›')), 'typed url or program: type row follows');
    const asks = v({ mode: 'input', action: 'addTarget', inputName: 'proj', inputBuffer: '~/p', height: 30 });
    assert.ok(asks.includes('› target     ~/p▏') && asks.includes('  name       proj') && asks.includes('↵ add'), 'no folder: asked after the name');
    assert.ok(formLines({ name: '', entry: { path: '' }, field: 0, editing: true, buffer: 'x', cursor: 1, adding: true }, 60).map(strip).some(l => l.includes('target next')), 'empty target: name note says so');
  }
  assert.deepEqual([asksMany(6, '5'), asksMany(5, '5'), asksMany(50, 'off'), setting('confirmMany', {})], [true, false, false, '5'], 'confirm many: over the limit asks, off never, 5 by default');
  assert.ok(v({ height: 30 }).includes('^o sort') && !v({ view: 'workspaces', workspaces: [], height: 30 }).includes('^o sort'), '^o sort key, not on workspaces');
  assert.ok(typing.includes('rename "s" to: s▏') && typing.includes('^u clear') && !typing.includes('^a add'), 'rename prompt prefilled, input keys shown');
  assert.equal(typing.split('\n').length, v({ height: 20 }).split('\n').length, 'typing keeps the frame height');
  const deep = v({ mode: 'input', action: 'export', inputBuffer: `C:/${'d/'.repeat(60)}leaf`, width: 60 }).split('\n').find(l => l.includes('export to'));
  assert.ok(deep.includes('file: …') && deep.endsWith('leaf▏') && deep.length <= 60, 'long input keeps its end in view');
});

test('line editing: cursor moves, inserts mid-text, word delete stops at path separators', () => {
  const ed = (st, ...keys) => keys.reduce((s, [str, key]) => editLine(s, str, key) ?? s, st);
  const s0 = { text: 'C:/foo/bar', cur: 10 };
  // Windows Node before 22.17 has the two backspace codes swapped.
  const BS = CTRL_BACKSPACE === '\b' ? '\x7f' : '\b';
  assert.deepEqual(ed(s0, [null, { name: 'left' }], [null, { name: 'left' }], ['x', { name: 'x' }]), { text: 'C:/foo/bxar', cur: 9 }, 'insert at cursor');
  assert.deepEqual(ed(s0, [null, { name: 'w', ctrl: true }]), { text: 'C:/foo/', cur: 7 }, '^w deletes one segment');
  assert.deepEqual(ed(s0, [null, { name: 'backspace', meta: true }], [null, { name: 'backspace', meta: true }]), { text: 'C:/', cur: 3 }, 'word delete repeats');
  assert.equal(ed(s0, [null, { name: 'left', ctrl: true }]).cur, 7, '^← jumps a word');
  assert.deepEqual(ed(s0, [null, { name: 'home' }], [null, { name: 'delete' }]), { text: ':/foo/bar', cur: 0 }, 'home + delete');
  assert.deepEqual(ed({ text: 'a😀', cur: 3 }, [null, { name: 'backspace', sequence: BS }]), { text: 'a', cur: 1 }, 'backspace drops a whole emoji');
  assert.deepEqual(ed(s0, [null, { name: 'backspace', sequence: CTRL_BACKSPACE }]), { text: 'C:/foo/', cur: 7 }, 'ctrl+backspace deletes a word');
  assert.equal(editLine(s0, null, { name: 'up' }), null, 'non-edit keys pass through');
  assert.equal(stripAnsi(inputLine('abc', 1, 20)), 'abc', 'mid cursor adds no column');
  assert.equal(stripAnsi(inputLine('abc', 3, 20)), 'abc▏');
  assert.ok(width(inputLine('x'.repeat(100), 50, 30)) <= 30, 'long input fits');
});

test('missing path flash, terminals keep the selector open', () => {
  assert.equal(missingFlash({ path: '/gone' }, () => false), 'path missing, ^e to fix', 'missing folder flagged');
  assert.equal(missingFlash({ path: os.tmpdir() }), null, 'existing folder opens (checked on disk)');
  assert.equal(staysOpen('cmd', 'tabs', () => true), true, 'terminal tabs keep the selector open');
  assert.equal(staysOpen('cmd', 'tabs', () => null) || staysOpen('cmd', 'windows', () => true) || staysOpen('vscode', 'tabs', () => true), false, 'no wt, windows layout or a non-terminal opener still exits');
  assert.equal(missingFlash({ path: 'x.exe', isApp: true }, () => false), null, 'apps are not folder checks');
});

test('wide chars, ~ in ^e, long names keep their frame', async () => {
  assert.deepEqual([width('ab'), width('日本'), width('a😀b'), width(chalk.red('日'))], [2, 4, 4, 2], 'CJK/emoji count two columns');
  assert.equal(truncate('日本語です', 5), '日本…\x1B[0m', 'truncate never splits a wide char');
  assert.deepEqual(clipName('日本語です', 6, [[0, 4]]), { text: '日本…', hits: [[0, 1]] }, 'wide name clipped by columns, hits in UTF-16');
  const lvl2 = chalk.level;
  chalk.level = 1;
  assert.equal(underlineHits('😀ab', [[0, 0]]), `${chalk.underline('😀')}ab`, 'a hit inside an emoji underlines it whole');
  assert.equal(underlineHits('😀ab', [[2, 2]]), `😀${chalk.underline('a')}b`, 'UTF-16 hit offsets land after the emoji');
  chalk.level = lvl2;
  assert.equal(expandHome('~/x'), `${os.homedir()}/x`, '~/ expands');
  assert.deepEqual([expandHome('~'), expandHome('~x'), expandHome('a/~')], [os.homedir(), '~x', 'a/~'], 'only a leading ~ segment expands');
  const confirm = v({ mode: 'confirm', choices: [{ name: 'q'.repeat(200), path: 'P', exists: true }], width: 60 }).split('\n').find(l => l.includes('delete'));
  assert.ok(confirm.endsWith('y / n') && width(confirm) === 60, 'confirm line clips the name to fill the width, keeps y / n');
  const Seg = Intl.Segmenter;
  let segs = 0;
  Intl.Segmenter = class extends Seg { constructor(...a) { super(...a); segs++; } };
  const freshUi = await import('../src/ui.js?lazy');
  assert.deepEqual([freshUi.width('› … ─ ▏ ↵ ● × ← ★ ⌫'), freshUi.truncate('‹ abc › ──', 6), freshUi.graphemes('a›').length, segs], [19, '‹ abc…\x1B[0m', 2, 0], 'no Segmenter at import or for UI glyphs');
  Intl.Segmenter = Seg;
  const wideOpt = strip(optionRow(['Explorer', 'x'.repeat(80)], 1, 40));
  assert.ok(wideOpt.endsWith('›') && width(wideOpt) <= 40, 'a long option label clips inside its ‹ ›');
  const ukey = await new Promise(r => { zs.once('keypress', (_, k) => r(k)); zs.write('\x15'); });
  assert.ok(ukey.ctrl && ukey.name === 'u', 'Ctrl+U arrives as a ctrl u keypress');
});

test('sort order, pins first, pin moves, recent strip and number keys', () => {
  const ord = [{ name: 'b', score: 1 }, { name: 'c', score: 5 }, { name: 'a', score: 1 }];
  assert.deepEqual([...ord].sort(byOrder('recent')).map(c => c.name), ['c', 'a', 'b'], 'most used first, ties A to Z');
  assert.deepEqual([...ord].sort(byOrder('name')).map(c => c.name), ['a', 'b', 'c'], 'A to Z ignores score');
  const pins = [...ord, { name: 'z', score: 0, pinned: true }];
  assert.deepEqual(pins.sort(byOrder('recent')).map(c => c.name), ['z', 'c', 'a', 'b'], 'pinned first regardless of score');
  assert.equal([...pins].sort(byOrder('name'))[0].name, 'z', 'pinned first in A to Z too');
  const dated = [{ name: 'a', lastUsed: 5, added: 1 }, { name: 'b', lastUsed: 9 }, { name: 'c', added: 7 }];
  assert.deepEqual([[...dated].sort(byOrder('opened')), [...dated].sort(byOrder('added'))].map(l => l.map(c => c.name).join('')), ['bac', 'cab'], 'last opened / recently added, missing dates last');
  const ordered = [{ name: 'p', pinned: true }, { name: 'q', pinned: true, pinOrder: 1 }, { name: 'r', pinned: true, pinOrder: 0 }, { name: 'a', score: 9 }];
  assert.equal([...ordered].sort(byOrder('recent')).map(c => c.name).join(''), 'rqpa', 'pin order first, unordered pins after');
  const pinList = [{ name: 'a' }, { name: 'x', isApp: true }, { name: 'b' }];
  assert.deepEqual(movePinned(pinList, 'b', -1, inView('shortcuts')), ['b', 'x', 'a'], 'move pin skips other tabs');
  assert.equal(movePinned(pinList, 'a', -1), null, 'move pin: the top one stays');
  assert.deepEqual(movePinned(pinList, 'a', 1), ['x', 'a', 'b'], 'move pin down');
  assert.deepEqual(withPinned({ path: 'x', pinned: true, pinOrder: 2 }, false), { path: 'x' }, 'unpin drops the pin order');
  const rec = withRecent([{ name: 'a', lastUsed: 1, path: 'A', exists: true }, { name: 'b', path: 'B', exists: true }, { name: 'c', lastUsed: 5, path: 'C', exists: true }, { name: 'd', lastUsed: 3, path: 'D', exists: true }, { name: 'e', lastUsed: 4, path: 'E', exists: true }]);
  assert.equal(rec.map(c => c.name + (c.recent ? '*' : '')).join(' '), 'c* e* d* a b c d e', 'recent strip: last 3 opened on top');
  assert.equal(withRecent(dated).length, 3, 'no recent strip for a short list');
  const recView = strip(renderInteractiveView({ ...viewArgs, height: 30, choices: rec, settings: { recentStrip: '3' } }));
  assert.ok(/ {4}Recent\n {2}› c/.test(recView) && /\n {4}All\n {4}a/.test(recView), 'recent strip: Recent and All headings');
  const numView = strip(renderInteractiveView({ ...viewArgs, height: 30, choices: rec, settings: { recentStrip: '3', numberKeys: 'on' } }));
  assert.ok(/ {4}Recent\n {2}› c/.test(numView) && /\n {2}2 e/.test(numView) && /\n {2}4 a/.test(numView) && !/\n {2}9 /.test(numView), 'number keys: visible rows numbered past headings, the selected keeps ›');
  assert.ok(!/\n {2}2 e/.test(recView), 'number keys off: no numbers');
  assert.ok(v({}).includes('^y copy') && !v({}).includes('move pin') && v({ choices: [{ name: 's', path: 'P', exists: true, pinned: true }] }).includes('A-↑↓ move pin'), '^y and move pin hints');
  assert.deepEqual([{ name: 'up', meta: true, sequence: '\x1b[1;3A' }, { name: 'up', meta: false, sequence: '\x1b\x1b[A' }, { name: 'up', sequence: '\x1b[A' }].map(isAlt), [true, true, false], 'Alt+arrow: modifier code or Esc prefix');
});

test('Groups by tag: pinned on top, a copy per tag in the sort order (A to Z by name), untagged last.', () => {
  const tagged = [{ name: 'a', tags: ['web', 'velora'], path: 'A', exists: true }, { name: 'b', pinned: true, tags: ['velora'], path: 'B', exists: true }, { name: 'c', path: 'C', exists: true }];
  const label = l => l.map(c => `${c.group}:${c.name}`).join(' ');
  assert.equal(label(withGroups(tagged)), 'Pinned:b #web:a #velora:a #velora:b untagged:c', 'groups: pinned on top, also in their tag; tags in list order');
  assert.equal(label(withGroups(tagged, true)), 'Pinned:b #velora:a #velora:b #web:a untagged:c', 'groups: A to Z by name');
  assert.equal(withGroups([{ name: 'c' }]).length, 1, 'groups: no tags, no headings');
  const grpView = strip(renderInteractiveView({ ...viewArgs, height: 30, choices: withRecent(tagged, 3, withGroups(tagged)) }));
  assert.ok(/ {4}Pinned {2}1\n {2}› b/.test(grpView) && / {4}#velora {2}2\n {4}a/.test(grpView) && grpView.includes('#web  1') && grpView.includes('untagged  1'), 'groups: #tag headings with counts');
  assert.deepEqual(filterChoices(tagged, '#vel').map(c => c.name), ['a', 'b'], '#tag filters by tag prefix');
  assert.deepEqual(filterChoices(tagged, '#VEL #web').map(c => c.name), ['a'], 'every #tag must match, any case');
  assert.deepEqual(filterChoices(tagged, '#velora b').map(c => c.name), ['b'], '#tag plus fuzzy words');
  assert.equal(filterChoices(tagged, '#').length, 3, 'a lone # is no tag filter');
  assert.deepEqual([filterChoices(tagged, '#vel#web'), filterChoices(tagged, 'b#vel')].map(l => l.map(c => c.name).join()), ['a', 'b'], '#tags chain without a space (Space marks)');
});

test('is: and @opener tokens, chained without a space.', () => {
  const tok = [{ name: 'p', pinned: true, opener: 'vscode', lastUsed: Date.now(), exists: true }, { name: 'm', exists: false, lastUsed: Date.now() }, { name: 'ap', isApp: true, exists: true, lastUsed: 0, added: 0 }];
  const by = q => filterChoices(tok, q).map(c => c.name).join();
  assert.equal(filterChoices([{ name: 'w', entries: [] }], 'is:stale').length, 0, 'workspaces are never stale');
  const olds = [{ name: 'd40', lastUsed: Date.now() - 40 * 86400000 }, { name: 'd100', lastUsed: Date.now() - 100 * 86400000 }];
  assert.deepEqual(['30', undefined, '90', '180'].map(staleAfter => filterChoices(olds, 'is:stale', { staleAfter }).map(c => c.name).join()), ['d40,d100', 'd100', 'd100', ''], 'is:stale follows stale after');
  assert.deepEqual([by('is:pinned'), by('IS:p'), by('is:missing'), by('is:stale'), by('is:app'), by('@vs'), by('is:nope'), by('is:')], ['p', 'p', 'm', 'ap', 'ap', 'p', '', 'p,m,ap'], 'is: and @ tokens');
  assert.deepEqual([by('apis:app'), by('is:pinned@vs'), by('is:pinned is:app')], ['ap', 'p', ''], 'tokens chain and all must match');
  const ages = [{ name: 'fresh', added: Date.now() - 86400000, expires: Date.now() + 86400000 }, { name: 'old', added: Date.now() - 8 * 86400000 }, { name: 'none' }, { name: 'w', entries: [] }];
  assert.deepEqual(['is:new', 'is:n', 'is:temp', 'is:t'].map(q => filterChoices(ages, q).map(c => c.name).join()), ['fresh', 'fresh', 'fresh', 'fresh'], 'is:new = added in 7 days, is:temp = has an expiry');
});

test('Fuzzy and searchIn settings on the filter.', () => {
  const fz = [{ name: 'website', path: '/x/api', aliases: ['ws'] }, { name: 'other', path: '/x/webkit' }];
  const names = (q, s) => filterChoices(fz, q, s).map(c => c.name).join();
  assert.equal(names('wbsite'), 'website', 'normal: a typo still matches');
  assert.equal(names('wbsite', { fuzzy: 'exact' }), '', 'exact: no typos');
  assert.equal(names('site', { fuzzy: 'exact' }), 'website', 'exact: letters in a row, anywhere');
  assert.equal(names('api'), 'website', 'all: paths are searched');
  assert.equal(names('api', { searchIn: 'names' }), '', 'names only: paths are not');
  assert.equal(names('ws', { searchIn: 'names' }), 'website', 'names only: aliases are');
  assert.deepEqual([names('wbkt'), names('wbkt', { fuzzy: 'loose' })], ['', 'other'], 'loose: more typos');
  // via: the alias that matched instead of the name.
  const via = (q, s) => filterChoices(fz, q, s)[0]?.via;
  assert.deepEqual([via('ws'), via('ws', { searchIn: 'names' }), via('ws', { fuzzy: 'exact' }), via('website'), via('webs')], ['ws', 'ws', 'ws', undefined, undefined], 'via alias only when the name did not match');
});

test('No matches: add here (Shortcuts, no tokens) and archived ones with the text.', () => {
  const arch = [{ name: 'fooold', path: '/x' }, { name: 'b', path: '/y/foo' }, { name: 'c', path: '/z' }];
  const offerKinds = (q, v, a = arch) => noMatchOffers(q, v, a, '/cwd').map(o => o.kind).join();
  assert.deepEqual([offerKinds('foo', 'shortcuts'), offerKinds('FOO', 'apps'), offerKinds('foo', 'workspaces'), offerKinds('#foo', 'shortcuts'), offerKinds('is:p', 'shortcuts'), offerKinds('nope', 'shortcuts'), offerKinds('  ', 'shortcuts')],
    ['add,archived', 'archived', '', '', '', 'add', ''], 'no-match offers per tab, tokens and archived');
  assert.deepEqual([noMatchOffers(' foo ', 'shortcuts', arch, '/cwd')[0].name, noMatchOffers('foo', 'shortcuts', arch, '/cwd')[1].text], ['foo', '2 match'], 'offer name trimmed, archived count');
  const noMatchFrame = renderInteractiveView({ query: 'foo', choices: [], selectedIndex: 0, appChoices: [], selectedAppIndex: 0, cmdCount: 1, offers: noMatchOffers('foo', 'shortcuts', arch, '/cwd'), offerIndex: 1 });
  assert.ok(noMatchFrame.includes('add "foo" here') && noMatchFrame.includes('search archived') && noMatchFrame.includes('2 match'), 'no-match offers render');
  assert.deepEqual(noMatchOffers('foo', 'shortcuts', [], ''), [{ kind: 'add', name: 'foo', label: 'add "foo"', text: 'its target next', key: 'add' }], 'no cwd target (System32): no path offered');
  assert.deepEqual([expiryText(Date.now() + 2 * 86400000 - 5000), expiryText(Date.now() - 1), expiryText(undefined), expiryText(Date.now() + 90 * 60000)], ['2d left', '', '', '2h left'], 'expiry badge text');
  assert.deepEqual(movePinned([{ name: 'a', tags: ['web'] }, { name: 'b', tags: ['vel'] }, { name: 'c', tags: ['web'] }], 'a', 1, sameGroup({ group: '#web' })), ['c', 'b', 'a'], 'groups: a pin moves past the next pin of its tag group');
});

test('max rows setting, PgUp/PgDn and Home/End', () => {
  assert.deepEqual([maxListOf('12'), maxListOf(undefined)], [12, 8], 'max rows setting');
  assert.equal(setting('maxRows', { maxRows: 'fill' }), 'auto', 'a dropped fill reads as auto');
  // Inline, Auto is 8: no separate Auto option, 8 or auto shows as the picked "8".
  const mr = { key: 'maxRows', names: { auto: 'Auto', 8: '8', 12: '12', 16: '16' } };
  assert.deepEqual(rowOptions(mr, [], { fullScreen: 'off' }).map(([, l]) => l), ['8', '12', '16'], 'inline max rows hides Auto');
  assert.deepEqual([pickedOf(mr, { fullScreen: 'off', maxRows: '8' }), pickedOf(mr, { maxRows: '8' })], ['auto', '8'], 'inline 8 shows on the 8 option');
  assert.deepEqual([maxListOf('auto'), maxListOf('auto', true), maxListOf('8', true)], [8, Infinity, 8], 'max rows auto: fill only in full screen');
  assert.deepEqual(['home', 'end', 'pageup', 'pagedown', 'pageup', 'pagedown', 'up'].map((k, x) => jumpIndex(k, x < 4 ? 5 : 0, 20, 8)), [0, 19, 0, 13, 0, 8, null], 'PgUp/PgDn page, Home/End ends');
  assert.deepEqual([jumpIndex('pagedown', 18, 20, 8), jumpIndex('end', 0, 0, 8), jumpIndex('pagedown', 0, 5, 0)], [19, null, 1], 'jump clamps, empty list, page at least 1');
  assert.deepEqual(rowOptions(mr, []).map(([, l]) => l), ['Auto', '8', '12', '16'], 'max rows: Auto first, like the other defaults');
});
