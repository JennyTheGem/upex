/**
 * smoke.mjs -- Minimal asserts for the non-trivial logic: frecency + prune.
 * Run: npm test
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { unarchived, frecency, pruneBroken, mergeLinks, lastUsedName, nameError, takenError, checkAliases, aliasClashes, staleLinks, sweepExpired, diffLinks, keepUsage, withPinned } from '../src/store.js';
import { remoteWebUrl } from '../src/git.js';
import { installCmdWrapper } from '../src/commands/setup.js';
import { normalizeUrl, caretEscape, wtCommandLine, setting, shellCommand, defaultOpener, checkSettings, resetSettings, startTab } from '../src/launcher.js';
import { parseTags, parseDuration, defaultName } from '../src/commands/add.js';
import { truncate, span, width, dimParent, stripAnsi, toAscii } from '../src/ui.js';
import { applyShortcut, applyOpener, cleanEntries, startServer } from '../src/commands/web.js';
import { COMMAND_NAMES } from '../src/fast.js';
import { createProgram } from '../src/index.js';
import { readScripts, detectPm } from '../src/commands/run.js';
import { renderInteractiveView, nextView, backTo, accentOf, pathLook, inView, tidyPath, byOrder, optionRow, listRows, readMouse, hitTest, rowClick, undoError, undoneLinks, clipName, prefill, editLine, sameLinks, kindOf, retyped, setField, fieldWords, completeTag, expiryOptions, formRows, formLines, statLines, doctorLines, inputLine, missingFlash, staysOpen, expandHome, underlineHits, movePinned, sameGroup, withRecent, withGroups, filterChoices, maxListOf, isAlt, detailLines, rowOptions, pickedOf, goalSummary, goalsOf, goalText, oneLine, scriptLines, markLines, paneShown, paneToggles, paneWidthOf, withSamePath, archivedList, dotLines, lr, wrapHint } from '../src/interactive.js';
import { parseStatus, parseDiff, parseLog, gitOf, stopGit } from '../src/git.js';
import chalk from 'chalk';
import { resolveTarget, resolveName, suggestNames } from '../src/fuzzy.js';

// -- frecency: recent + used beats old + unused; unused = 0 --
const now = Date.now();
const recent = frecency({ uses: 1, lastUsed: now });
const old = frecency({ uses: 1, lastUsed: now - 30 * 86400000 });
const never = frecency({});
assert.ok(recent > old, 'recent use should outrank old use');
assert.ok(old > never, 'any use should outrank never-used');
assert.equal(never, 0, 'never-used scores 0');
assert.ok(frecency({ uses: 10, lastUsed: now - 86400000 }) > recent, 'more uses ranks higher');

// -- stats: window, ranking, per-week buckets; history read skips junk --
import { statsFrom, loadHistory } from '../src/store.js';
{
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
  fs.rmSync(hdir, { recursive: true, force: true });
}

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

// -- durations, stale selection, expiry sweep --
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
// a lone `upex --help` through a wrapper must fall through, not cd into help text
const h = spawnSync(process.execPath, [cli, '__resolve', '--help'], { encoding: 'utf-8' });
assert.equal(h.status, 1, '__resolve refuses --help');
assert.deepEqual([...COMMAND_NAMES].sort(), createProgram().commands.flatMap(c => [c.name(), ...c.aliases()]).sort(), 'fast path knows every command name');
assert.equal(h.stdout, '', 'no help text printed for the wrapper to cd into');

// Run the CLI against a throwaway home holding the given links.json content.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'upex-home-'));
const linksFile = path.join(home, '.upex', 'links.json');
fs.mkdirSync(path.dirname(linksFile), { recursive: true });
const upexIn = (...args) => spawnSync(process.execPath, [cli, ...args], {
  encoding: 'utf-8',
  env: { ...process.env, USERPROFILE: home, HOME: home },
});

// -- go with args: runs the command inside the shortcut folder --
const target = fs.mkdtempSync(path.join(os.tmpdir(), 'upex-target-'));
fs.writeFileSync(linksFile, JSON.stringify({ t: { path: target } }));
const g = upexIn('go', 't', process.platform === 'win32' ? 'cd' : 'pwd');
assert.equal(g.status, 0, 'go with args exits 0');
assert.equal(g.stdout.trim(), target, 'command runs in the shortcut folder');
assert.deepEqual(loadHistory(path.join(home, '.upex', 'history.jsonl')).map(h => [h.name, h.opener]), [['t', 'cd']], 'an open is logged with its opener');
const statsOut = upexIn('stats');
assert.equal(statsOut.status, 0, 'stats runs');
assert.match(statsOut.stdout, /cd\s+1/, 'stats shows the opener count');

// -- upex config: get/set round-trip, bad values refused without saving --
assert.equal(upexIn('config', 'get', 'terminalLayout').stdout.trim(), 'windows', 'config get prints the default');
assert.equal(upexIn('config', 'set', 'terminalLayout', 'tabs').status, 0, 'config set saves');
assert.equal(upexIn('config', 'get', 'terminalLayout').stdout.trim(), 'tabs', 'config get reads it back');
assert.equal(upexIn('config', 'set', 'defaultOpener', 'code').status, 0, 'opener alias accepted');
assert.equal(upexIn('config', 'get', 'defaultOpener').stdout.trim(), 'vscode', 'opener stored as its key');
assert.equal(upexIn('config', 'set', 'terminalLayout', 'nope').status, 1, 'bad value refused');
assert.equal(upexIn('config', 'set', 'bogus', 'x').status, 1, 'unknown setting refused');
assert.equal(upexIn('config', 'get', 'bogus').status, 1, 'unknown setting get refused');
assert.equal(upexIn('config', 'get', 'terminalLayout').stdout.trim(), 'tabs', 'refused sets saved nothing');
assert.match(upexIn('config').stdout, /terminalLayout\s+tabs · windows, tabs, panes/, 'config lists settings with options');
assert.equal(upexIn('config', 'set', 'accent', 'FF66AA').status, 0, 'hex accent without # accepted');
assert.equal(upexIn('config', 'get', 'accent').stdout.trim(), '#ff66aa', 'hex accent stored as #rrggbb');
assert.equal(upexIn('config', 'reset', 'accent').status, 0, 'config reset one');
assert.deepEqual([upexIn('config', 'get', 'accent').stdout.trim(), upexIn('config', 'get', 'terminalLayout').stdout.trim()], ['default', 'tabs'], 'reset one leaves the others');
assert.equal(upexIn('config', 'reset', 'bogus').status, 1, 'reset unknown setting refused');
assert.equal(upexIn('config', 'reset').status, 0, 'config reset all');
assert.deepEqual([upexIn('config', 'get', 'terminalLayout').stdout.trim(), upexIn('config', 'get', 'defaultOpener').stdout.trim()], ['windows', 'explorer'], 'reset all = defaults');
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

// -- subpaths: go prints a folder inside the shortcut, missing subfolder fails --
fs.mkdirSync(path.join(target, 'sub'));
assert.equal(upexIn('go', 't/sub').stdout, path.join(target, 'sub'), 'go resolves a subpath');
assert.equal(upexIn('go', 't/nope').status, 1, 'missing subpath fails');

// -- default opener: set, reject unknown, reject on URL, clear --
const stored = () => JSON.parse(fs.readFileSync(linksFile, 'utf-8'));
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

// -- doctor: healthy store passes, a corrupt one fails --
const doc = upexIn('doctor');
assert.equal(doc.status, 0, 'doctor passes on a good store');
assert.ok(doc.stdout.includes('1 shortcut'), 'doctor reports the store');
fs.rmSync(target, { recursive: true, force: true });
assert.match(upexIn('doctor').stdout, /broken shortcut: t/, 'doctor flags a broken path');

// -- store: a corrupt links.json is never overwritten, a BOM is tolerated --
const broken = '{"keep": {"path": "X"},';
fs.writeFileSync(linksFile, broken);
assert.equal(upexIn('add', 'new', home).status, 1, 'corrupt store fails the command');
assert.equal(fs.readFileSync(linksFile, 'utf-8'), broken, 'corrupt store is left untouched');
assert.equal(upexIn('doctor').status, 1, 'doctor fails on a corrupt store');
fs.writeFileSync(linksFile, '\uFEFF' + JSON.stringify({ gh: { url: 'github.com' } }));
assert.equal(upexIn('edit', 'gh', 'gitlab.com').status, 0, 'BOM-prefixed store loads');
assert.equal(JSON.parse(fs.readFileSync(linksFile, 'utf-8')).gh.url, 'gitlab.com', 'edit replaces a URL target');
assert.ok(!fs.readdirSync(path.dirname(linksFile)).some(f => f.endsWith('.tmp')), 'save leaves no temp file');

// -- prototype names are real names; a workspace with a failing entry exits 1 --
fs.writeFileSync(linksFile, JSON.stringify({}));
assert.equal(upexIn('add', 'constructor', home).status, 0, '"constructor" can be added');
assert.equal(upexIn('add', 'has space', home).status, 1, 'names with spaces rejected');
upexIn('ws', 'add', 'w', 'nope');
assert.equal(upexIn('ws', 'w').status, 1, 'failed workspace entry exits 1');
assert.equal(upexIn('ws', 'toString').status, 1, 'prototype workspace name is not found');

// -- auto-backup: 12 saves keep the newest 10, newest holds the previous file; opens don't back up --
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

// -- aliases + archive: an alias works like the name, archived ones hide until restored --
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
assert.match(upexIn('ls', '--archived').stdout, /vel/, 'ls --archived lists it');
assert.equal(upexIn('restore', 'v2').status, 0, 'restore via alias');
assert.equal(upexIn('go', 'vd').stdout, home, 'restored shortcut resolves again');

// -- temporary + stale: add --ttl stores expires, any command archives it once passed, restore clears it --
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

// -- add with no name / ".", pin, undo --
fs.writeFileSync(linksFile, '{}');
fs.rmSync(path.join(home, '.upex', 'backups'), { recursive: true, force: true });
fs.mkdirSync(path.join(home, 'my proj'));
// macOS reports the cwd as /private/var/..., so compare against the real path.
const proj = fs.realpathSync(path.join(home, 'my proj'));
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

// -- note: set (words joined), show, clear --
upexIn('add', 'n1', proj);
assert.equal(upexIn('note', 'n1', 'react', ' app').status, 0, 'note sets');
assert.equal(stored().n1.note, 'react app', 'note joins words, one line');
assert.match(upexIn('note', 'n1').stdout, /react app/, 'note shows');
upexIn('note', 'n1', '--clear');
assert.equal(stored().n1.note, undefined, 'note --clear drops it');
assert.equal(upexIn('note', 'nope', 'x').status, 1, 'note on unknown fails');

fs.rmSync(home, { recursive: true, force: true });

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

// -- resolveTarget: exact, subpath, fuzzy head, slash-named shortcut wins --
const rl = { web: {}, api: {}, 'a/b': {} };
assert.deepEqual(resolveTarget('web', rl), { name: 'web', exact: true, sub: '' }, 'exact name');
assert.deepEqual(resolveTarget('web/src/x', rl), { name: 'web', exact: true, sub: 'src/x' }, 'subpath split');
assert.deepEqual(resolveTarget('web\\src', rl), { name: 'web', exact: true, sub: 'src' }, 'backslash subpath');
assert.equal(resolveTarget('wbe/src', rl).name, 'web', 'fuzzy head keeps the subpath');
assert.deepEqual(resolveTarget('a/b', rl), { name: 'a/b', exact: true, sub: '' }, 'full name with a slash wins');
assert.deepEqual(resolveTarget('a/b/c', rl), { name: 'a/b', exact: true, sub: 'c' }, 'slash-named shortcut takes a subpath');
assert.equal(resolveTarget('zzzzzz', rl), null, 'no match -> null');

// -- aliases + archive in resolution and name checks --
const al = { velora: { aliases: ['vd'] }, vdx: {}, old: { archived: true, aliases: ['o'] } };
assert.deepEqual(resolveName('vd', al), { name: 'velora', exact: true }, 'alias resolves exactly');
assert.deepEqual(resolveTarget('vd/src', al), { name: 'velora', exact: true, sub: 'src' }, 'alias takes a subpath');
assert.equal(resolveName('old', al), null, 'archived hidden from resolve');
assert.deepEqual(resolveName('o', al, true), { name: 'old', exact: true }, 'archived-only search finds it by alias');
assert.equal(takenError(al, 'vd'), '"vd" is an alias of velora.', 'alias blocks a new name');
assert.match(takenError(al, 'old'), /archived/, 'archived name blocks with a restore hint');
assert.equal(takenError(al, 'vd', 'velora'), null, 'own alias is not taken');
assert.deepEqual(checkAliases(al, 'vdx', ['a', 'a', 'vdx']), { aliases: ['a'] }, 'dupes and own name dropped');
assert.match(checkAliases(al, 'vdx', ['vd']).error, /alias of velora/, 'alias of another rejected');
assert.deepEqual(aliasClashes({ a: { aliases: ['b'] }, b: {}, c: { aliases: ['x'] }, d: { aliases: ['x'] } }), ['b: b, a', 'x: c, d'], 'clashes found');
assert.equal(lastUsedName({ x: { lastUsed: 9, archived: true }, y: { lastUsed: 1 } }), 'y', 'last skips archived');
assert.deepEqual(aliasClashes({ x: { aliases: ['x', 'y', 'y'] } }), [], 'self alias and repeats are no clash');
const pa = { proj: { path: '/p', archived: true }, proj2: { path: '/p2' } };
assert.equal(resolveName('proj', pa), null, 'archived exact name does not fuzzy-match a neighbour');
assert.equal(resolveTarget('proj/src', pa), null, 'archived exact head does not fuzzy-match a neighbour');
assert.equal(resolveName('proj2', pa, true), null, 'restore of a live name finds nothing');
assert.deepEqual(Object.keys(pruneBroken(pa, () => false).kept), ['proj'], 'prune keeps archived shortcuts');

// -- remoteWebUrl: ssh/scp/https remotes to a web page, credentials dropped, local paths null --
assert.equal(remoteWebUrl('git@github.com:me/x.git'), 'https://github.com/me/x', 'scp-style');
assert.equal(remoteWebUrl('ssh://git@host.dev:2222/me/x.git'), 'https://host.dev/me/x', 'ssh url, port dropped');
assert.equal(remoteWebUrl('https://u:tok@github.com/me/x/'), 'https://github.com/me/x', 'credentials + slash dropped');
assert.equal(remoteWebUrl('http://git.lan:8080/a/b.git'), 'http://git.lan:8080/a/b', 'http port kept');
assert.equal(remoteWebUrl('https://github.com/me/a"b'), 'https://github.com/me/a%22b', 'quote encoded');
for (const local of [String.raw`C:\repos\x`,'C:/repos/x', '/home/me/x', '../x', 'file:///c/x']) assert.equal(remoteWebUrl(local), null, `local ${local}`);
for (const evil of ['git@h.com:me/$(id).git', 'git@h.com:me/x?`id`', 'ssh://git@e"&calc&"x.com/r', 'git@h.com:%USERNAME%/x']) assert.equal(remoteWebUrl(evil), null, `shell-unsafe ${evil}`);
assert.equal(remoteWebUrl('https://dev.azure.com/o/My%20Proj/_git/r'), 'https://dev.azure.com/o/My%20Proj/_git/r', 'percent escapes kept');
assert.equal(remoteWebUrl('git@1.2.3.4.5:me/x'), null, 'bad host: null, no throw');

// -- selector tabs: folders on Shortcuts, apps + URLs on Apps --
const tabbed = [{ name: 'f' }, { name: 'a', isApp: true }, { name: 'u', isUrl: true }];
assert.deepEqual(tabbed.filter(inView('shortcuts')).map(c => c.name), ['f'], 'shortcuts tab: folders only');
assert.deepEqual(tabbed.filter(inView('apps')).map(c => c.name), ['a', 'u'], 'apps tab: apps and URLs');

// -- normalizeUrl: bare host gets https, real scheme kept --
assert.equal(normalizeUrl('github.com'), 'https://github.com', 'bare host gets https');
assert.equal(normalizeUrl('http://x.dev'), 'http://x.dev', 'existing scheme preserved');

// -- caretEscape: cmd.exe metachars inside the user's own quotes survive the outer shell --
assert.equal(caretEscape('cd x && echo "a & b|c"'), 'cd x && echo "a ^& b^|c"', 'only user-quoted metachars escaped');
if (process.platform === 'win32') {
  // Same quote layout as `start "" cmd /s /k "<line>"`, but /c so no window opens.
  const line = 'echo "a & b" && echo two';
  const out = execSync(`cmd /s /c "${caretEscape(line)}"`, { encoding: 'utf-8' }).split(/\r?\n/).map(s => s.trim());
  assert.deepEqual(out.slice(0, 2), ['"a & b"', 'two'], 'cmd.exe runs the line as typed');
}

// -- parseTags: split/trim/drop-empty, undefined when nothing usable --
assert.deepEqual(parseTags('work, personal ,'), ['work', 'personal'], 'tags split and trimmed');
assert.equal(parseTags(''), undefined, 'empty tag string -> undefined');
assert.equal(parseTags(undefined), undefined, 'missing tag -> undefined');

// -- truncate: clips to visible width, ignores ANSI, keeps short lines as-is --
const strip = (s) => s.replace(/\x1B\[[0-9;]*m/g, '');
assert.equal(truncate('hello', 10), 'hello', 'short line untouched');
assert.equal(strip(truncate('abcdefghij', 5)).length, 5, 'clipped to exact width');
assert.equal(strip(truncate(`\x1B[1mabcdefghij\x1B[0m`, 5)).length, 5, 'ANSI codes do not count as width');
assert.ok(truncate('abcdefghij', 5).endsWith('\x1B[0m'), 'clipped line resets styling');
assert.equal(truncate('abc', 0), '', 'zero width -> empty');
// text fills the width exactly, then a styled tail follows: must not overflow by the ellipsis
assert.equal(strip(truncate(`abcde\x1B[2m fg\x1B[0m`, 5)).length, 5, 'styled tail after exact fill stays in width');
assert.equal(strip(truncate('abcdefghij', 1)), '…', 'width 1 -> ellipsis only');

// -- selector: Tab view lists workspaces, hides the opener row --
const viewArgs = { query: '', choices: [{ name: 's', path: 'P', exists: true }], selectedIndex: 0, appChoices: [{ key: 'explorer', label: 'Explorer' }], selectedAppIndex: 0, cmdCount: 1 };
const wsView = strip(renderInteractiveView({ ...viewArgs, view: 'workspaces', workspaces: [{ name: 'dev', path: 's:vscode' }] }));
assert.ok(wsView.includes('tab shortcuts') && wsView.includes('› dev') && wsView.includes('s:vscode'), 'workspace view lists workspaces');
assert.ok(!wsView.includes('Explorer'), 'no opener row in workspace view');
assert.ok(strip(renderInteractiveView(viewArgs)).includes('tab apps'), 'shortcut view is the default');
const appsView = strip(renderInteractiveView({ ...viewArgs, view: 'apps', choices: [{ name: 'g', path: 'x.dev', isUrl: true, exists: true }] }));
assert.ok(appsView.includes('tab workspaces') && appsView.includes('open in browser') && !appsView.includes('Explorer'), 'apps view: no opener row');
const setArgs = { ...viewArgs, view: 'settings', settings: { startView: 'apps', sort: 'name', terminalLayout: 'tabs', paneSplit: 'auto', terminalShell: 'pwsh', defaultOpener: 'explorer' }, settingIndex: 7, wt: false, height: 40 };
const setView = strip(renderInteractiveView(setArgs));
assert.ok(setView.includes('‹ Tabs ›') && setView.includes('‹ PowerShell 7 ›') && setView.includes('‹ Explorer ›') && setView.includes('not found'), 'settings view: all rows + missing-wt note');
assert.ok(!setView.includes('Pane split'), 'pane split hidden unless split panes');
assert.ok(strip(renderInteractiveView({ ...setArgs, settings: { ...setArgs.settings, terminalLayout: 'panes' } })).includes('Pane split'), 'pane split shown for split panes');
assert.ok(setView.includes('‹ A to Z ›'), 'sort row shows the saved sort');
assert.ok(strip(renderInteractiveView({ ...setArgs, settingIndex: 9 })).includes('no opener of their own'), 'note follows the picked row');
assert.ok(setView.indexOf('Workspaces') < setView.indexOf('Settings'), 'settings tab is last');
// archived shortcuts sit under the settings, Enter restores the picked one
assert.deepEqual(archivedList({ b: { path: '/b', archived: true }, a: { app: 'x.exe', archived: true }, c: { path: '/c' } }), [{ name: 'a', path: 'x.exe' }, { name: 'b', path: '/b' }], 'archived list: only archived, A to Z');
assert.deepEqual(unarchived({ path: '/a', archived: true, expires: 1, uses: 2 }), { path: '/a', uses: 2 }, 'restore drops archived and expires');
assert.ok(!setView.includes('Archived'), 'no archived section when none');
const arcArgs = { ...setArgs, archived: [{ name: 'old', path: '/old/dir' }], height: 80 };
const arcView = strip(renderInteractiveView({ ...arcArgs, settingIndex: 0 }));
assert.ok(arcView.includes('Archived 1') && arcView.includes('/old/dir') && arcView.includes('change (saved)'), 'archived section lists them');
// 26 setting rows (pane split hidden), so index 26 is the first archived one.
const arcSel = strip(renderInteractiveView({ ...arcArgs, settingIndex: 26 }));
assert.ok(arcSel.includes('› old') && arcSel.includes('↵ restore') && arcSel.includes('upex restore old') && arcSel.includes('^d delete') && !arcView.includes('^d delete'), 'picked archived row: restore and delete keys, note');

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

// -- fit the terminal: option rows scroll around the selection, the list fits the height --
const labels = ['Explorer', 'VS Code', 'cmd', 'Claude', 'WebStorm', 'PowerShell', 'Custom'];
assert.equal(strip(optionRow(labels, 1, 200)), 'Explorer  ‹ VS Code ›  cmd  Claude  WebStorm  PowerShell  Custom', 'wide row shows all');
const mid = strip(optionRow(labels, 4, 30));
assert.ok(mid.includes('‹ WebStorm ›') && mid.startsWith('‹…') && mid.endsWith('…›') && mid.length <= 30, 'narrow row keeps the selection, marks both edges');
assert.ok(strip(optionRow(labels, 6, 30)).endsWith('‹ Custom ›') && !strip(optionRow(labels, 0, 30)).startsWith('‹…'), 'no marker past the ends');
assert.ok(strip(optionRow(labels, -1, 30)).startsWith('Explorer'), 'unknown value anchors at the start');
assert.equal(listRows(5, 10), 5, 'all rows fit');
assert.equal(listRows(20, 10), 9, 'one row left for the scroll hint');
assert.equal(listRows(20, 1), 3, 'at least 3 rows');
const many = { ...viewArgs, choices: Array.from({ length: 30 }, (_, i) => ({ name: `p${i}`, path: 'P', exists: true })) };
for (const height of [16, 30]) assert.equal(renderInteractiveView({ ...many, height }).split('\n').length, height, `fills height ${height} exactly`);
assert.ok(renderInteractiveView({ ...many, height: 40, maxList: 8 }).includes('↓ 22 more'), 'inline cap keeps 8 rows');
const wideOpeners = { ...viewArgs, width: 40, appChoices: labels.map(label => ({ key: label, label })), selectedAppIndex: 6 };
assert.ok(strip(renderInteractiveView(wideOpeners)).split('\n').some(l => l.includes('open with') && l.includes('‹ Custom ›') && l.length <= 40), 'opener row keeps the selection in width');
assert.equal(setting('fullScreen', {}), 'on', 'full screen on by default');
assert.equal(setting('fullScreen', { fullScreen: 'off' }), 'off', 'full screen can be turned off');
assert.ok(strip(renderInteractiveView({ ...setArgs, settings: { ...setArgs.settings, fullScreen: 'off' } })).includes('Full screen     On  ‹ Off ›'), 'full screen row');
// key hints: full = rows that wrap, short = one row cut to the width, off = none; the list takes the freed rows
const withHints = (keyHints, extra = {}) => strip(renderInteractiveView({ ...many, height: 30, settings: { keyHints }, ...extra })).split('\n');
for (const k of ['full', 'short', 'off']) assert.equal(withHints(k).length, 30, `hints ${k}: fills the height`);
const [full, short1, off] = ['full', 'short', 'off'].map(k => withHints(k));
// glyphs ascii: one column per swapped glyph, hint keys spelled out
assert.equal(toAscii('‹ a › ▏▎─│┬┴…↑↓←→●★×'), '< a > ||-|++.^v<>**x', 'ascii glyphs');
const asc = withHints('full', { settings: { glyphs: 'ascii' } }).join('\n');
assert.ok(asc.includes('enter open') && asc.includes('up/down move') && !full.join('\n').includes('enter open'), 'ascii hint keys');
assert.ok(full.some(l => l.includes('tab apps')) && full.some(l => l.includes('^a add')), 'full: both rows');
assert.ok(!short1.some(l => l.includes('tab apps')) && short1.at(-1).includes('^a add') && short1.at(-1).includes('←→ opener'), 'short: one row, no learned keys');
assert.ok(!off.some(l => l.includes('^a add') || l.includes('↵ open')) && off.at(-1).includes('open with'), 'off: no hints, opener row kept');
assert.ok(off.filter(l => /^  [ ›] p\d/.test(l)).length > full.filter(l => /^  [ ›] p\d/.test(l)).length, 'off: more list rows');
const cut = withHints('short', { width: 40 }).at(-1);
assert.ok(cut.length <= 40 && cut.includes('↵ open') && !cut.includes('^u'), 'short row cut to the width');
assert.ok(withHints('off', { view: 'apps' }).at(-1).includes('↓'), 'off in apps: no footer rule, list runs to the bottom');
assert.ok(/^ {2}─+$/.test(withHints('off', { view: 'apps', webUrl: 'http://h/?t=x' }).at(-2)), 'off: web link right under the rule');
assert.ok(withHints('off', { view: 'settings' }).some(l => l.includes('change (saved)')), 'settings keeps its keys');
assert.equal(withHints('short', { mode: 'input', action: 'rename' }).at(-1).trim().startsWith('↵ save'), true, 'short: typing shows input keys');
// full rows wrap instead of cutting; ^s and ^g sit last behind a |; the row count ignores the selection
assert.deepEqual(wrapHint([['a', 'one'], ['b', 'two'], '|', ['c', 'three']], 14).map(strip), ['  a one  b two', '  c three'], 'wrapHint wraps, a | starting a row goes');
assert.deepEqual(wrapHint([['a', 'one'], '|', false], 40).map(strip), ['  a one'], 'trailing | dropped');
{
  const nar = withHints('full', { width: 50 });
  const rule = nar.findLastIndex(l => /^ *─+$/.test(l));
  const keys = nar.slice(rule + 1).join(' ');
  assert.ok(nar.slice(rule).every(l => l.length <= 50) && keys.includes('^y copy') && keys.includes('^u web ui') && keys.includes('|  ^s scripts'), 'narrow full: keys wrap, nothing cut, | before ^s');
  // Rows under the last rule (full screen, so S-→ details shows): the same with the pinned row (A-↑↓ move pin, ^p unpin) or the other one selected, marks, a filter, a confirm or typing.
  const footOf = (extra) => {
    const l = withHints('full', { full: true, choices: [{ name: 'a', path: 'P', exists: true, pinned: true }, { name: 'b', path: 'Q', exists: true }], ...extra });
    return l.length - l.findLastIndex(x => /^ *─+$/.test(x));
  };
  const states = [{ selectedIndex: 1 }, { marks: new Set(['a']) }, { query: 'a' }, { mode: 'confirm', action: 'archive' }, { mode: 'input', action: 'rename' }];
  assert.ok([60, 99].every(width => states.every(s => footOf({ width, ...s }) === footOf({ width }))), 'key rows keep their count when the selection, marks, filter or mode change');
  const apps = { view: 'apps', width: 89, choices: [{ name: 'x', path: 'x.exe', isApp: true, exists: true }, { name: 'u', path: 'http://x', isUrl: true, exists: true }] };
  assert.equal(footOf(apps), footOf({ ...apps, selectedIndex: 1 }), 'apps: launch app and open in browser rows count the same');
  assert.ok(withHints('short').at(-1).trim().startsWith('^k keys'), 'short: ^k first');
  const help = withHints('short', { keysHelp: true }).join('\n');
  assert.ok(help.includes('Move') && help.includes('tab apps') && help.includes('^x archive') && help.includes('any key closes') && !help.includes('p0 '), '^k overlay lists every key over the list');
  assert.ok(withHints('full', { view: 'workspaces', workspaces: [{ name: 'w', entries: [] }] }).join(' ').includes('^d delete'), 'workspaces keep ^d delete');
}
// row details + pinned section
{
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
}

// -- mouse: SGR reports through real readline never leak into keys; the hit map follows scroll and option windows --
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
const fed = await feed('a\x1b[<0;12;5M\x1b[<0;1', '2;5mb', '\x1b[<64;3;9M\x1b[<65;3;9M\x1b[<2;1;1m', '\x1b[<0;1x', '\x1b[M !!c');
assert.equal(fed.keys, 'abxc', 'only real keys pass: split, broken and X10 reports are swallowed');
assert.deepEqual(fed.events.map(e => [e.x, e.y, e.wheel, e.click]), [[12, 5, 0, false], [12, 5, 0, true], [3, 9, -1, false], [3, 9, 1, false], [1, 1, 0, false]], 'press, left release = click, wheel up/down, right release');
const escFed = await feed('\x1b', '\x1b[<65;3;9M', 'x');
assert.ok(escFed.keys === 'x' && escFed.events.length === 1, 'esc right before a report: the report is not typed');
assert.deepEqual([rowClick({}, 5, 0, true), rowClick({}, 5, 0, false), rowClick({ y: 5, at: 0 }, 5, 300, false), rowClick({ y: 5, at: 0, opened: true }, 5, 300, true), rowClick({ y: 5, at: 0, opened: true }, 5, 900, true), rowClick({ y: 4, at: 0, opened: true }, 5, 300, true)],
  ['open', 'select', 'open', 'skip', 'open', 'open'], 'click selected opens, double-click opens once');
const rowsOf = a => strip(renderInteractiveView(a)).split('\n');
const twoLine = { ...viewArgs, height: 20, flash: 'Command "claude" not found.\nInstall it.' };
const noFlash = rowsOf({ ...twoLine, flash: '' });
const flashed = rowsOf(twoLine);
const ruleAt = noFlash.findLastIndex(l => l.trim().startsWith('─'));
assert.ok(flashed.length === noFlash.length && flashed.every((l, i) => i === ruleAt || l === noFlash[i]), 'flash moves no row');
assert.ok(flashed[ruleAt].endsWith(' Command "claude" not found. Install it. ──'), 'multi-line flash: one line, right end of the bottom rule');
const bare = { ...viewArgs, view: 'apps', settings: { keyHints: 'off' } };
assert.ok(rowsOf({ ...bare, flash: 'x' }).at(-1).endsWith(' x ') && rowsOf({ ...bare, flash: 'x' }).length === rowsOf(bare).length + 1, 'no footer: flash gets its own bottom row');
const at = (args, x, y) => { const targets = []; renderInteractiveView({ ...args, targets }); return hitTest(targets, x, y); };
const tabArgs = { ...viewArgs, counts: { shortcuts: 1, apps: 2, workspaces: 0 } };
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
assert.deepEqual([at(setArgs, setLines[sortLine - 1].indexOf('Most used') + 1, sortLine)].map(t => [t.setting, t.option]), [[1, 0]], 'click a settings option');
assert.equal(at(setArgs, 5, sortLine)?.option, undefined, 'click a settings label just picks the row');

// -- appearance: paths, compact density, accent, the appearance rows --
assert.deepEqual([pathLook({ text: 'a/b' }, 'hidden').text, pathLook({ text: 'u', style: 'url' }, 'hidden').text, pathLook({ text: 'a', style: 'plain' }, 'hidden').text], ['', '', 'a'], 'hidden blanks paths and urls, not plain rows');
assert.equal(pathLook({ text: 'a/b', style: 'path' }, 'full').style, 'plain', 'full = undimmed');
assert.ok(!strip(renderInteractiveView({ ...viewArgs, settings: { paths: 'hidden' } })).split('\n').find(l => l.startsWith('  › s ')).includes('P'), 'hidden paths in the selector');
const roomy = rowsOf({ ...many, height: 20 });
const tight = rowsOf({ ...many, height: 20, settings: { density: 'compact' } });
assert.ok(tight.length === 20 && tight.filter(l => / p\d+ /.test(l)).length > roomy.filter(l => / p\d+ /.test(l)).length, 'compact fits more rows in the same height');
assert.equal(at({ ...tabArgs, settings: { density: 'compact' } }, rowsOf({ ...tabArgs, settings: { density: 'compact' } })[0].indexOf('Apps') + 1, 1)?.tab, 'apps', 'compact header still clickable');
assert.ok(renderInteractiveView({ ...setArgs, settings: { ...setArgs.settings, accent: 'blue' } }).includes(chalk.blueBright('‹ A to Z ›')), 'accent colors the picked option');
const tall = strip(renderInteractiveView({ ...setArgs, height: 40, settings: { ...setArgs.settings, theme: 'light' } }));
assert.ok(tall.includes('Web theme       System  Dark  ‹ Light ›'), 'web theme row');
assert.ok(['General', 'Search', 'Terminals', 'Opening', 'Appearance'].every(s => tall.includes(`\n  ${s}\n`)), 'settings grouped in sections');
const short = rowsOf({ ...setArgs, height: 14, settingIndex: 21 });
assert.ok(short.length <= 14 && short.some(l => l.startsWith('  › Web theme')) && short.at(-1).includes('setting'), 'short terminal scrolls settings, keeps the footer');
assert.equal(at({ ...setArgs, height: 14, settingIndex: 20 }, 3, short.findIndex(l => l.startsWith('  › Web theme')) + 1)?.setting, 20, 'scrolled settings stay clickable');
const arcShort = { ...setArgs, archived: [{ name: 'old', path: '/old/dir' }], height: 14, settingIndex: 26 };
assert.equal(at(arcShort, 3, rowsOf(arcShort).findIndex(l => l.startsWith('  › old')) + 1)?.setting, 26, 'last archived row scrolls into view, stays clickable');
assert.equal(checkSettings({ accent: 'red' }).error, 'accent must be one of: default, green, blue, purple, orange, or a hex color like #ff66aa.', 'bad accent refused');
assert.deepEqual([checkSettings({ accent: '#FF66aa' }).next.accent, checkSettings({ accent: 'ff66aa' }).next.accent, checkSettings({ sort: '#ff66aa' }).error?.slice(0, 4)], ['#ff66aa', '#ff66aa', 'sort'], 'hex only for accent, normalized');
assert.deepEqual([setting('accent', { accent: '#ff66aa' }), setting('accent', { accent: '#ff66a' }), setting('accent', { accent: '"><x' })], ['#ff66aa', 'default', 'default'], 'stored hex read back, junk falls back');
assert.equal(accentOf('#ff66aa')('x'), chalk.hex('#ff66aa')('x'), 'hex accent via chalk.hex (it downsamples by color level)');
const hexSet = strip(renderInteractiveView({ ...setArgs, height: 40, settings: { ...setArgs.settings, accent: '#ff66aa' } }));
assert.ok(hexSet.includes('‹ #ff66aa ›'), 'hex accent shows as its own picked option');
assert.deepEqual(resetSettings({ sort: 'name', accent: 'blue', apps: { x: 'y' }, workspaces: {} }, ['sort']), { accent: 'blue', apps: { x: 'y' }, workspaces: {} }, 'reset one setting');
assert.deepEqual(resetSettings({ sort: 'name', defaultOpener: 'vscode', accent: '#ff66aa', apps: { x: 'y' } }), { apps: { x: 'y' } }, 'reset all keeps openers and workspaces');
assert.deepEqual([startTab({ startView: 'last', lastView: 'apps' }), startTab({ startView: 'last' }), startTab({ startView: 'last', lastView: 'last' }), startTab({ startView: 'workspaces', lastView: 'apps' })], ['apps', 'shortcuts', 'shortcuts', 'workspaces'], 'start view last');

// -- esc clears a filter first, success flash is green, ^z undo hint and restore checks --
const v = (a) => strip(renderInteractiveView({ ...viewArgs, ...a }));
assert.ok(v({}).includes('esc quit') && v({ query: 's' }).includes('esc clear') && v({ query: 's', mode: 'input', action: 'add' }).includes('esc cancel'), 'esc hint says what esc does');
assert.ok(v({ view: 'workspaces', query: 'd' }).includes('esc clear'), 'workspaces too');
assert.ok(v({}).includes('^u web ui') && v({ view: 'workspaces' }).includes('^u web ui'), '^u hint');

// -- edit form (^e): types, field parsing, rows, render in the list and in the pane --
{
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
  assert.deepEqual(formRows({ entry: { url: 'x' } }), ['name', 'target', 'type', 'tags', 'aliases', 'note', 'expires'], 'no opener row for a url');
  assert.deepEqual(formRows({ ws: true, entry: [{ shortcut: 'a' }, { shortcut: 'b' }] }), ['name', 0, 1], 'workspace rows: name, then entries');
  const entry = { path: home, tags: ['work'], note: 'hi there', opener: 'explorer' };
  const fl = formLines({ name: 'web', entry, field: 4, editing: false }, 60, [{ key: 'explorer', label: 'Explorer' }]).map(strip);
  assert.ok(fl[0].startsWith('web') && fl[0].endsWith('folder') && fl.some(l => l.startsWith('› tags') && l.includes('#work')) && fl.some(l => l.includes('‹ Explorer ›')), 'form rows');
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
}
// -- settings: openers and maintenance rows above Archived, stats and doctor lines --
{
  const extras = [{ section: 'Openers', kind: 'opener', name: 'zed', text: 'zed' }, { section: 'Maintenance', kind: 'stats', name: 'Stats', text: 'web 3' }];
  const ex = (i, more = {}) => strip(renderInteractiveView({ ...setArgs, extras, archived: [{ name: 'old', path: '/o' }], height: 80, settingIndex: i, ...more }));
  const e0 = ex(26);
  assert.ok(e0.indexOf('Openers') < e0.indexOf('Maintenance') && e0.indexOf('Maintenance') < e0.indexOf('Archived 1'), 'extra sections in order');
  assert.ok(e0.includes('› zed') && e0.includes('↵ edit command') && e0.includes('^d remove'), 'opener row keys');
  assert.ok(ex(27, { expanded: { kind: 'stats', lines: ['web  3'] } }).includes('↵ hide') && ex(27, { expanded: { kind: 'stats', lines: ['web  3'] } }).includes('      web  3'), 'stats lines under its row');
  assert.ok(ex(28).includes('› old') && ex(28).includes('↵ restore'), 'archived index after the extras');
  assert.ok(strip(renderInteractiveView({ ...setArgs, mode: 'confirm', ask: 'remove opener "zed"?' })).includes('? remove opener "zed"?  y / n'), 'settings confirm question');
  const day = 86400000;
  const sl = statLines({ code: { displayName: 'VS Code' } }, [{ name: 'web', opener: 'code', ts: 10 * day }, { name: 'web', ts: 11 * day }, { name: 'api', ts: 11 * day }], 12 * day).map(strip);
  assert.ok(sl[0].startsWith('web') && sl[0].endsWith('2') && sl.some(l => l.includes('VS Code 1')), 'stats lines');
  assert.deepEqual(strip(statLines({}, [], 0)[0]), 'No opens in the last 30 days.', 'no stats');
  assert.ok(strip(doctorLines([['warn', 'paths', '1 broken']])[0]).startsWith('warn  paths'), 'doctor line');
}

// -- script picker: ^s hint, the picker rows, package.json reading --
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
assert.ok(renderInteractiveView({ ...viewArgs, flash: { text: 'added "x"', ok: true } }).includes(chalk.green(' added "x" ')), 'success flash is green');
assert.ok(renderInteractiveView({ ...viewArgs, flash: 'path not found' }).includes(chalk.yellow(' path not found ')), 'plain flash stays yellow');
chalk.level = lvl;
const gone = { name: 'old', entry: { path: 'P', aliases: ['o'] } };
assert.equal(undoError(gone, { other: { path: 'Q' } }, {}), null, 'free name restores');
assert.match(undoError(gone, { old: { path: 'Q' } }, {}), /already exists/, 'refused when the name was reused');
assert.match(undoError(gone, { x: { path: 'Q', aliases: ['old'] } }, {}), /alias of x/, 'refused when the name became an alias');
assert.match(undoError(gone, { x: { path: 'Q', aliases: ['o'] } }, {}), /alias of x/, 'refused when its alias was taken');
assert.equal(undoError({ name: 'dev', entry: [], ws: true }, { dev: {} }, {}), null, 'workspace names are their own namespace');
assert.match(undoError({ name: 'dev', entry: [], ws: true }, {}, { dev: [] }), /already exists/, 'workspace refused when reused');
assert.equal(undoError([{ name: 'a', entry: { path: 'P' }, archived: true }], { a: { path: 'P', archived: true } }, {}), null, 'an archived one restores');
assert.match(undoError({ name: 'a', entry: { path: 'P' }, archived: true }, { a: { path: 'P' } }, {}), /no longer archived/, 'archive undo refused once restored');
assert.deepEqual(undoneLinks([{ name: 'a', entry: { path: 'P' }, archived: true }], { a: { path: 'P', tags: ['t'], archived: true }, b: { path: 'B' } }), { a: { path: 'P', tags: ['t'] }, b: { path: 'B' } }, 'archive undo drops only the flag, edits since stay');
assert.deepEqual(undoneLinks([{ name: 'a', entry: { path: 'P' } }], { b: { path: 'B' } }), { a: { path: 'P' }, b: { path: 'B' } }, 'delete undo puts the entry back');
const two = [{ name: 'a', entry: { path: 'A' } }, { name: 'b', entry: { path: 'B' } }];
assert.equal(undoError(two, { c: { path: 'C' } }, {}), null, 'a deleted list restores when all names are free');
assert.match(undoError(two, { b: { path: 'Q' } }, {}), /already exists/, 'a list is refused when any name was taken');

// -- views setting: Tab cycle, header, start tab fallback --
assert.deepEqual([nextView('shortcuts'), nextView('apps', 'no-workspaces'), nextView('shortcuts', 'no-apps'), nextView('shortcuts', 'shortcuts'), nextView('settings', 'shortcuts')],
  ['apps', 'shortcuts', 'workspaces', 'shortcuts', 'shortcuts'], 'Tab cycles the shown tabs');
assert.deepEqual([backTo('apps', 'all'), backTo('apps', 'no-apps'), backTo('workspaces', 'shortcuts')], ['apps', 'shortcuts', 'shortcuts'], 'Shift+Tab back to a hidden tab goes to Shortcuts');
assert.deepEqual([startTab({ startView: 'apps', views: 'no-apps' }), startTab({ startView: 'last', lastView: 'workspaces', views: 'shortcuts' }), startTab({ startView: 'workspaces', views: 'no-apps' })],
  ['shortcuts', 'shortcuts', 'workspaces'], 'a hidden start tab falls back to Shortcuts');
const onlyS = strip(renderInteractiveView({ ...viewArgs, settings: { views: 'shortcuts' } }));
assert.ok(!onlyS.includes('Apps') && !onlyS.includes('Workspaces') && !onlyS.includes('tab '), 'only Shortcuts: no other tabs, no tab hint');
const noWs = strip(renderInteractiveView({ ...viewArgs, view: 'apps', choices: [], settings: { views: 'no-workspaces' } }));
assert.ok(!noWs.includes('Workspaces') && noWs.includes('tab shortcuts'), 'hidden Workspaces: header and tab hint skip it');

// -- marks: pointer column, count, hints, confirm --
const markArgs = { ...viewArgs, selectedIndex: 1, choices: [{ name: 's', path: 'P', exists: true }, { name: 't', path: 'Q', exists: true }], marks: new Set(['s']) };
const marked = strip(renderInteractiveView(markArgs)).split('\n');
assert.ok(marked.some(l => l.startsWith('  ● s ')) && marked.some(l => l.startsWith('  › t ')), 'marked row shows ●, the highlight keeps ›');
assert.equal(marked.find(l => l.startsWith('  ● s ')).indexOf('P'), marked.find(l => l.startsWith('  › t ')).indexOf('Q'), 'the mark keeps the row layout');
assert.ok(marked.join('\n').includes('● 1 marked') && marked.join('\n').includes('↵ open 1 marked') && marked.join('\n').includes('^x archive 1 marked') && marked.join('\n').includes('esc unmark'), 'marked count and hints');
assert.ok(strip(renderInteractiveView(viewArgs)).includes('space mark'), 'space mark hint');
assert.ok(strip(renderInteractiveView({ ...markArgs, mode: 'confirm', action: 'archiveMarked', marks: new Set(['s', 't']) })).includes('? archive 2 marked?  y / n'), 'confirm names the marked count');
assert.ok(strip(renderInteractiveView({ ...markArgs, mode: 'confirm', action: 'archive', marks: new Set(['s', 't']) })).includes('? archive "t"?  y / n'), 'archive confirm names the one row, not the marks');

// -- removeLinks: one save, so one upex undo brings all of them back --
{
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
}
// -- selector on fake streams: S-Tab, ↑ (wraps to the last archived), Enter restores; a double-click restores once, keeps its flash --
{
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
}
const zs = new PassThrough();
readline.emitKeypressEvents(zs);
const zkey = await new Promise(r => { zs.once('keypress', (_, k) => r(k)); zs.write('\x1a'); });
assert.ok(zkey.ctrl && zkey.name === 'z', 'Ctrl+Z arrives as a ctrl z keypress');

// -- no dead ends: long names clip, prompts start prefilled, a missing path keeps the selector open --
assert.deepEqual(clipName('abcdefghij', 5, [[0, 1], [3, 6], [8, 9]]), { text: 'abcd…', hits: [[0, 1], [3, 3]] }, 'clip keeps hits inside the cut');
assert.deepEqual(clipName('abc', 5, [[0, 2]]), { text: 'abc', hits: [[0, 2]] }, 'short name untouched');
const longName = strip(renderInteractiveView({ ...viewArgs, selectedIndex: 1, choices: [{ name: 'n'.repeat(40), path: 'P1', exists: true }, { name: 'short', path: 'P2', exists: true }] })).split('\n');
const p1 = longName.find(l => l.includes('P1'));
assert.ok(p1.includes(`${'n'.repeat(23)}…  P1`) && p1.indexOf('P1') === longName.find(l => l.includes('P2')).indexOf('P2'), 'long name clipped, path column aligned');
assert.deepEqual([prefill('rename', { name: 'n', path: 'C:/x' }), prefill('add', { name: 'n' })], ['n', ''], 'rename prefill, add starts empty');
const typing = v({ mode: 'input', action: 'rename', inputBuffer: 's', height: 20 });
assert.ok(typing.includes('rename "s" to: s▏') && typing.includes('^u clear') && !typing.includes('^a add'), 'rename prompt prefilled, input keys shown');
assert.equal(typing.split('\n').length, v({ height: 20 }).split('\n').length, 'typing keeps the frame height');
const deep = v({ mode: 'input', action: 'export', inputBuffer: `C:/${'d/'.repeat(60)}leaf`, width: 60 }).split('\n').find(l => l.includes('export to'));
assert.ok(deep.includes('file: …') && deep.endsWith('leaf▏') && deep.length <= 60, 'long input keeps its end in view');
// -- line editing: cursor moves, inserts mid-text, word delete stops at path separators --
{
  const ed = (st, ...keys) => keys.reduce((s, [str, key]) => editLine(s, str, key) ?? s, st);
  const s0 = { text: 'C:/foo/bar', cur: 10 };
  assert.deepEqual(ed(s0, [null, { name: 'left' }], [null, { name: 'left' }], ['x', { name: 'x' }]), { text: 'C:/foo/bxar', cur: 9 }, 'insert at cursor');
  assert.deepEqual(ed(s0, [null, { name: 'w', ctrl: true }]), { text: 'C:/foo/', cur: 7 }, '^w deletes one segment');
  assert.deepEqual(ed(s0, [null, { name: 'backspace', meta: true }], [null, { name: 'backspace', meta: true }]), { text: 'C:/', cur: 3 }, 'word delete repeats');
  assert.equal(ed(s0, [null, { name: 'left', ctrl: true }]).cur, 7, '^← jumps a word');
  assert.deepEqual(ed(s0, [null, { name: 'home' }], [null, { name: 'delete' }]), { text: ':/foo/bar', cur: 0 }, 'home + delete');
  assert.deepEqual(ed({ text: 'a😀', cur: 3 }, [null, { name: 'backspace', sequence: '\x7f' }]), { text: 'a', cur: 1 }, 'backspace drops a whole emoji');
  assert.deepEqual(ed(s0, [null, { name: 'backspace', sequence: '\b' }]), { text: 'C:/foo/', cur: 7 }, 'ctrl+backspace (0x08) deletes a word');
  assert.equal(editLine(s0, null, { name: 'up' }), null, 'non-edit keys pass through');
  assert.equal(stripAnsi(inputLine('abc', 1, 20)), 'abc', 'mid cursor adds no column');
  assert.equal(stripAnsi(inputLine('abc', 3, 20)), 'abc▏');
  assert.ok(width(inputLine('x'.repeat(100), 50, 30)) <= 30, 'long input fits');
}
assert.equal(missingFlash({ path: '/gone' }, () => false), 'path missing, ^e to fix', 'missing folder flagged');
assert.equal(missingFlash({ path: os.tmpdir() }), null, 'existing folder opens (checked on disk)');
assert.equal(staysOpen('cmd', 'tabs', () => true), true, 'terminal tabs keep the selector open');
assert.equal(staysOpen('cmd', 'tabs', () => null) || staysOpen('cmd', 'windows', () => true) || staysOpen('vscode', 'tabs', () => true), false, 'no wt, windows layout or a non-terminal opener still exits');
assert.equal(missingFlash({ path: 'x.exe', isApp: true }, () => false), null, 'apps are not folder checks');

// -- wide chars, ~ in ^e, long names keep their frame --
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
assert.deepEqual([freshUi.width('› … ─ ▏ ↵ ● × ←'), freshUi.truncate('‹ abc › ──', 6), freshUi.graphemes('a›').length, segs], [15, '‹ abc…\x1B[0m', 2, 0], 'no Segmenter at import or for UI glyphs');
Intl.Segmenter = Seg;
const wideOpt = strip(optionRow(['Explorer', 'x'.repeat(80)], 1, 40));
assert.ok(wideOpt.endsWith('›') && width(wideOpt) <= 40, 'a long option label clips inside its ‹ ›');
const ukey = await new Promise(r => { zs.once('keypress', (_, k) => r(k)); zs.write('\x15'); });
assert.ok(ukey.ctrl && ukey.name === 'u', 'Ctrl+U arrives as a ctrl u keypress');

// -- applyShortcut: add, rename in place, clashes, path checks --
const yes = () => true;
const base = { a: { path: path.resolve('/A') }, b: { url: 'x.dev', tags: ['t'] } };
assert.ok(applyShortcut(base, undefined, { kind: 'url', name: 'c', target: 'y.dev' }, yes).links.c.url === 'y.dev', 'add url');
assert.match(applyShortcut(base, undefined, { kind: 'url', name: 'a', target: 'y' }, yes).error, /exists/, 'add clash rejected');
const { added: _cmdAdded, ...cmdAdd } = applyShortcut(base, undefined, { kind: 'cmd', name: 'dev', target: 'npm run dev' }, yes).links.dev;
assert.deepEqual(cmdAdd, { app: 'npm run dev', terminal: true }, 'add cmd stores a terminal app');
assert.deepEqual(applyShortcut({ dev: cmdAdd }, 'dev', { name: 'dev', target: 'npm test' }, yes).links.dev, { app: 'npm test', terminal: true }, 'edit cmd keeps terminal');
assert.match(applyShortcut(base, undefined, { kind: 'folder', name: 'd', target: '/nope' }, () => false).error, /does not exist/, 'missing folder rejected');
assert.match(applyShortcut(base, undefined, { kind: 'url', name: 'a b', target: 'y' }, yes).error, /spaces/, 'spaces rejected');
const ren = applyShortcut(base, 'a', { name: 'z', target: '/A', tags: 'p, q' }, () => false).links;
assert.deepEqual(Object.keys(ren), ['z', 'b'], 'rename keeps position, unchanged dead path allowed');
assert.deepEqual(ren.z.tags, ['p', 'q'], 'tags parsed on edit');
assert.equal(applyShortcut(base, 'b', { name: 'b', target: 'x.dev', tags: '' }, yes).links.b.tags, undefined, 'empty tags dropped');
assert.match(applyShortcut(base, 'a', { name: 'b', target: '/A' }, yes).error, /exists/, 'rename clash rejected');
assert.ok(applyShortcut({ 'Led start': { url: 'x' } }, 'Led start', { name: 'Led start', target: 'y' }, yes).links, 'CLI name with spaces stays editable');

// -- opener via the web form: set, clear, folder only, known only --
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

// -- names: one rule for CLI, selector and web --
assert.equal(nameError('dev'), null, 'plain name ok');
assert.ok(nameError('') && nameError('a b') && nameError('__proto__'), 'empty, spaced and __proto__ rejected');
assert.deepEqual(suggestNames('webap', ['webapp', 'notes']), ['webapp'], 'close name suggested');

// -- cleanEntries: shape workspace entries, reject bad ones --
assert.deepEqual(cleanEntries([{ shortcut: ' s ', app: '', count: '2', start: ' claude ' }]), [{ shortcut: 's', count: 2, start: 'claude' }], 'entry cleaned');
assert.equal(cleanEntries([{ shortcut: '' }]), null, 'empty shortcut rejected');
assert.equal(cleanEntries([{ shortcut: 's', count: 0 }]), null, 'count 0 rejected');
assert.equal(cleanEntries('x'), null, 'non-array rejected');
assert.equal(cleanEntries([null]), null, 'null entry rejected, not thrown');

// -- applyOpener: add, change command, clashes --
assert.deepEqual(applyOpener({}, { name: ' cursor ', command: ' cursor ' }, true).apps, { cursor: 'cursor' }, 'opener added, trimmed');
assert.match(applyOpener({ Cursor: 'c' }, { name: 'cursor', command: 'x' }, true).error, /exists/, 'case-only clash rejected');
assert.match(applyOpener({}, { name: 'a b', command: 'x' }, true).error, /spaces/, 'spaced opener name rejected');
assert.match(applyOpener({}, { name: '__PROTO__', command: 'x' }, true).error, /reserved/, 'opener lowercasing to __proto__ rejected');
assert.match(applyOpener({}, { name: 'sub', command: ' ' }, true).error, /required/, 'empty command rejected');
assert.deepEqual(applyOpener({ sub: 'subl', z: 'z' }, { name: 'sub', command: 'subl -n' }).apps, { sub: 'subl -n', z: 'z' }, 'command changed in place');
assert.match(applyOpener({}, { name: 'nope', command: 'x' }).error, /No custom opener/, 'edit of unknown opener rejected');

// -- wt: N shells in one wt call; trailing backslash, user `;` and quotes survive wt's parser --
assert.equal(wtCommandLine('C:\\a b\\', '', 2, 'tabs'), String.raw`-w 0 new-tab -d "C:\a b\\" cmd ; new-tab -d "C:\a b\\" cmd`, 'tabs, quoted dir');
assert.equal(wtCommandLine(String.raw`C:\x`, 'a; b', 2, 'panes'), String.raw`-w 0 new-tab -d C:\x cmd /s /k "a\; b" ; split-pane -d C:\x cmd /s /k "a\; b"`, 'panes, escaped ;');
assert.equal(wtCommandLine(String.raw`C:\x`, String.raw`code "C:\a b\" && x`, 1, 'tabs'), String.raw`-w 0 new-tab -d C:\x cmd /s /k "code \"C:\a b\\\" && x"`, 'start cmd is one arg, inner quotes escaped');
assert.equal(wtCommandLine(String.raw`C:\x`, 'claude', 1, 'tabs'), String.raw`-w 0 new-tab -d C:\x cmd /s /k claude`, 'plain start cmd unquoted');
assert.equal(wtCommandLine(String.raw`C:\x`, '', 2, 'panes', 'cmd', 'vertical'), String.raw`-w 0 new-tab -d C:\x cmd ; split-pane -V -d C:\x cmd`, 'pane split direction');
assert.equal(wtCommandLine(String.raw`C:\x`, '', 1, 'windows', 'profile'), String.raw`-w new new-tab -d C:\x`, 'default profile: no command, own window');
assert.equal(wtCommandLine(String.raw`C:\x`, 'claude', 1, 'tabs', 'profile'), String.raw`-w 0 new-tab -d C:\x cmd /s /k claude`, 'default profile + start command runs in cmd');
const ps = shellCommand('pwsh', 'echo "a; b" & x', s => s);
assert.equal(Buffer.from(ps.split(' ').pop(), 'base64').toString('utf16le'), 'echo "a; b" & x', 'powershell start command round-trips');
assert.ok(ps.startsWith('pwsh -NoExit -EncodedCommand ') && !/[\s;"]/.test(ps.split(' ').pop()), 'encoded command has nothing to quote');
assert.equal(shellCommand('powershell', '', s => s), 'powershell', 'plain powershell');
assert.equal(setting('terminalLayout', { terminalLayout: 'bogus' }), 'windows', 'unknown layout falls back to windows');
assert.equal(setting('terminalShell', {}), 'cmd', 'shell defaults to cmd');
assert.equal(setting('startView', { startView: 'nope' }), 'shortcuts', 'start view defaults to shortcuts');
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
const recView = strip(renderInteractiveView({ ...viewArgs, height: 30, choices: rec, settings: { recentStrip: 'on' } }));
assert.ok(/ {4}Recent\n {2}› c/.test(recView) && /\n {4}All\n {4}a/.test(recView), 'recent strip: Recent and All headings');
// Groups by tag: pinned on top, a copy per tag in the sort order (A to Z by name), untagged last.
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
// Fuzzy and searchIn settings on the filter.
const fz = [{ name: 'website', path: '/x/api', aliases: ['ws'] }, { name: 'other', path: '/x/webkit' }];
const names = (q, s) => filterChoices(fz, q, s).map(c => c.name).join();
assert.equal(names('wbsite'), 'website', 'normal: a typo still matches');
assert.equal(names('wbsite', { fuzzy: 'exact' }), '', 'exact: no typos');
assert.equal(names('site', { fuzzy: 'exact' }), 'website', 'exact: letters in a row, anywhere');
assert.equal(names('api'), 'website', 'all: paths are searched');
assert.equal(names('api', { searchIn: 'names' }), '', 'names only: paths are not');
assert.equal(names('ws', { searchIn: 'names' }), 'website', 'names only: aliases are');
assert.deepEqual([names('wbkt'), names('wbkt', { fuzzy: 'loose' })], ['', 'other'], 'loose: more typos');
assert.deepEqual(movePinned([{ name: 'a', tags: ['web'] }, { name: 'b', tags: ['vel'] }, { name: 'c', tags: ['web'] }], 'a', 1, sameGroup({ group: '#web' })), ['c', 'b', 'a'], 'groups: a pin moves past the next pin of its tag group');
assert.deepEqual([maxListOf('12'), maxListOf(undefined)], [12, 8], 'max rows setting');
assert.equal(setting('maxRows', { maxRows: 'fill' }), 'auto', 'a dropped fill reads as auto');
// Inline, Auto is 8: no separate Auto option, 8 or auto shows as the picked "8".
const mr = { key: 'maxRows', names: { auto: 'Auto', 8: '8', 12: '12', 16: '16' } };
assert.deepEqual(rowOptions(mr, [], { fullScreen: 'off' }).map(([, l]) => l), ['8', '12', '16'], 'inline max rows hides Auto');
assert.deepEqual([pickedOf(mr, { fullScreen: 'off', maxRows: '8' }), pickedOf(mr, { maxRows: '8' })], ['auto', '8'], 'inline 8 shows on the 8 option');
assert.deepEqual([maxListOf('auto'), maxListOf('auto', true), maxListOf('8', true)], [8, Infinity, 8], 'max rows auto: fill only in full screen');
// Full screen: footer on the last row; wide enough: detail pane beside the list.
const fullV = renderInteractiveView({ ...viewArgs, full: true, height: 30, maxList: 8 }).split('\n');
assert.ok(fullV.length === 30 && strip(fullV.slice(-3).join(' ')).includes('^x archive'), 'full screen pins the footer to the bottom');
const det = { name: 'web', path: 'E:/code/web', exists: true, pinned: true, tags: ['node'], uses: 3, lastUsed: Date.now() - 7200000, opener: 'explorer', aliases: [] };
const paneV = strip(renderInteractiveView({ ...viewArgs, choices: [det], full: true, width: 150, height: 30 })).split('\n');
assert.ok(paneV.some(l => l.includes('┬')) && paneV.some(l => l.includes('┴')) && paneV.every(l => l.length <= 150), 'pane joins the rules and stays in width');
assert.ok(paneV.some(l => /│ ★ web +3 opens · 2h ago · Explorer$/.test(l)), 'pane shows the selected details');
assert.ok(!paneV.some(l => l.includes('aliases')) && !strip(renderInteractiveView({ ...viewArgs, choices: [det], width: 150 })).includes('│'), 'no empty rows, no pane inline');
// Narrow: Shift+Right opens the pane (or Narrow screens Always), never under 60 or inline.
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
// Same path: other folder shortcuts on it (trailing slash ignored), shown as a pane row.
{
  const sp = withSamePath([{ name: 'a', path: 'X/y', isDir: true }, { name: 'b', path: 'X/y/', isDir: true }, { name: 'c', path: 'X/z', isDir: true }, { name: 'u', path: 'X/y', isUrl: true }]);
  assert.deepEqual(sp.map(c => c.same), [['b'], ['a'], [], undefined], 'withSamePath');
  assert.ok(strip(detailLines({ ...det, same: ['b'] }, 60).join('|')).includes('same path as b') && !strip(detailLines(det, 60).join('|')).includes('same path'), 'same path row');
}
// Note: wrapped at spaces, 3 lines at most, the last clipped.
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
// Open goals: planned/partial count, by phase then file order; the pane shows up to the setting's count.
const gs = goalSummary({ items: [{ id: 'a', title: 'A', phase: 'later', status: 'planned' }, { id: 'b', title: 'B', phase: 'maybe', status: 'partial' },
  { id: 'c', title: 'C', phase: 'now', status: 'done' }, { id: 'd', title: 'D', phase: 'next', status: 'planned' }, { id: 'e', title: 'E', phase: 'odd', status: 'planned' }, { id: 'f', title: 'F', phase: 'later', status: 'planned' }, { id: 'g', status: 'dropped' }] });
assert.deepEqual([gs.open, gs.done, gs.total, gs.next.map(g => g.id)], [5, 1, 6, ['d', 'a', 'f', 'b', 'e']], 'goalSummary counts open, done, total without dropped, next by phase');
assert.deepEqual([goalText({ id: 'i', title: 'T', body: 'B' }), goalText({ id: 'i', title: 'T' })], ['i: T\nB', 'i: T'], 'goalText: id: title, body below');
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
// Git status: parsed from porcelain v2, shown when the setting is on, web line clickable.
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
// gitOf: one lookup at a time, a fresh cache is not looked up again, stopGit drops a running one.
{
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
}
// ^s with the pane: scripts there, the shortcut list stays; a pane row click picks that script.
{
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
}
// Full screen without the pane: the opener row is still clickable after the footer moves down.
const fullA = { ...viewArgs, full: true, height: 30 };
assert.equal(at(fullA, 15, strip(renderInteractiveView(fullA)).split('\n').findIndex(l => l.includes('open with')) + 1)?.opener, 0, 'full screen: opener row hit follows the pinned footer');
// width is the terminal minus its last column: 140 columns get the pane.
assert.deepEqual([139, 138].map(width => renderInteractiveView({ ...fullA, width }).includes('┬')), [true, false], 'pane from 140 columns');
assert.deepEqual(rowOptions(mr, []).map(([, l]) => l), ['Auto', '8', '12', '16'], 'max rows: Auto first, like the other defaults');
assert.ok(v({}).includes('^y copy') && !v({}).includes('move pin') && v({ choices: [{ name: 's', path: 'P', exists: true, pinned: true }] }).includes('A-↑↓ move pin'), '^y and move pin hints');
assert.deepEqual([{ name: 'up', meta: true, sequence: '\x1b[1;3A' }, { name: 'up', meta: false, sequence: '\x1b\x1b[A' }, { name: 'up', sequence: '\x1b[A' }].map(isAlt), [true, true, false], 'Alt+arrow: modifier code or Esc prefix');
assert.deepEqual(diffLinks({ a: { path: 'A' }, b: { path: 'B' } }, { b: { path: 'X' }, c: { path: 'C' } }), { added: ['c'], removed: ['a'], changed: ['b'] }, 'diffLinks');
assert.deepEqual(keepUsage({ a: { path: 'A', uses: 1 }, b: { path: 'B' } }, { a: { path: 'Z', uses: 3, lastUsed: 9 } }), { a: { path: 'A', uses: 3, lastUsed: 9 }, b: { path: 'B' } }, 'keepUsage takes current stats');
// Prune ^z (selector): only while nothing but usage changed since the prune.
{
  const after = { a: { path: 'A' }, b: { app: 'x' } };
  const since = now => sameLinks(keepUsage(after, now), now);
  assert.deepEqual([since({ a: { path: 'A', uses: 2, lastUsed: 5 }, b: { app: 'x' } }), since({ a: { path: 'A', pinned: true }, b: { app: 'x' } }), since({ a: { path: 'A' } })],
    [true, false, false], 'prune undo: an open since is fine, an edit or delete is not');
}
assert.equal(defaultName('/x/My Cool  App/'), 'My-Cool-App', 'defaultName: basename, spaces to dashes');
assert.equal(defaultOpener({ defaultOpener: 'Code' }), 'vscode', 'default opener alias normalized');
assert.equal(defaultOpener({ defaultOpener: 'nope' }), 'explorer', 'unknown default opener falls back to explorer');
assert.equal(defaultOpener({ defaultOpener: 'copy' }), 'explorer', 'copy is no default opener');

// -- startServer for the selector: onReady gets the link instead of printing it --
{
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
}

// -- upex ui: token + host guard, add via API writes the store --
const webHome = fs.mkdtempSync(path.join(os.tmpdir(), 'upex-web-'));
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
  assert.deepEqual(st2.settings, { startView: 'apps', sort: 'name', terminalLayout: 'panes', paneSplit: 'horizontal', terminalShell: 'powershell', fullScreen: 'on', theme: 'system', accent: 'default', density: 'comfortable', paths: 'dim', keyHints: 'full', maxRows: 'auto', recentStrip: 'off', views: 'all', enter: 'quit', fuzzy: 'normal', searchIn: 'all', flash: '3', rowDetails: 'both', pinned: 'top', groups: 'off', narrowPane: 'toggle', paneWidth: 'normal', goals: 'off', git: 'off', glyphs: 'unicode', defaultOpener: 'vscode' }, 'state reports settings');
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
} finally {
  // Already exited (e.g. crashed on start): waiting for 'exit' again would never settle.
  if (srv.exitCode === null && srv.signalCode === null) {
    srv.kill();
    await new Promise((r) => srv.once('exit', r));
  }
  fs.rmSync(webHome, { recursive: true, force: true });
}

// -- help: grouped, wraps to any width, lists every visible command --
import { helpLines } from '../src/commands/help.js';
import { wrap } from '../src/ui.js';
assert.deepEqual(wrap([['aa bb cc'], ['\ndd']], 5).map(stripAnsi), ['aa bb', 'cc', 'dd'], 'wrap fills lines, \n breaks');
assert.equal(width(wrap([['abcdefgh']], 4)[0]), 4, 'a too long word is clipped');
assert.deepEqual(wrap([['a\u00a0b c']], 3), ['a b', 'c'], 'nbsp keeps words together, printed as a space');
const lvl3 = chalk.level;
chalk.level = 1;
for (const total of [20, 40, 80, 120]) {
  const text = helpLines(createProgram(), total);
  assert.ok(text.every(l => width(l) <= total), `help fits ${total} columns`);
  const plain = text.map(stripAnsi).join('\n');
  for (const c of createProgram().commands.filter(c => !c._hidden)) assert.match(plain, new RegExp(`^ {4}${c.name()}\\b`, 'm'), `help lists ${c.name()} at ${total}`);
}
chalk.level = lvl3;

console.log('ok - frecency + prune + cmd wrapper + resolve guard + go args + safe store + edit url + merge + lastUsed + url + tags + truncate + web ui + subpaths + opener + doctor + apps tab + names + ws rename + cmd quoting + wt layout + settings + shells + default opener + auto-backup + aliases + archive + remote url + add cwd + pins + undo + fast cd + custom openers + help');
