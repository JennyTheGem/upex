/**
 * edges.mjs -- Fuzzy resolution edge cases and launcher command building per platform.
 * Own process: os.platform and child_process are stubbed, home is a temp dir.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { resolveName, resolveTarget } from '../src/fuzzy.js';

// -- resolveName / resolveTarget edge cases --
const links = { web: {}, 'a/b': {}, notes: {}, 'my app': {} };
assert.deepEqual(resolveName('web', links), { name: 'web', exact: true }, 'exact');
assert.deepEqual(resolveName('WEB', links), { name: 'web', exact: false }, 'case differs -> fuzzy, not exact');
assert.deepEqual(resolveName('wbe', links), { name: 'web', exact: false }, 'typo -> fuzzy');
assert.equal(resolveName('', links), null, 'empty query matches nothing');
assert.equal(resolveName(' \t', links), null, 'blank query matches nothing');
assert.equal(resolveTarget(' /x', links), null, 'blank head matches nothing');
assert.equal(resolveName('toString', links), null, 'prototype key is not a shortcut');
assert.equal(resolveName('web', {}), null, 'no shortcuts -> null');
assert.equal(resolveTarget('', links), null, 'empty target matches nothing');
assert.equal(resolveTarget('web/x', {}), null, 'no shortcuts -> null target');
assert.deepEqual(resolveTarget('web/', links), { name: 'web', exact: true, sub: '' }, 'trailing slash, no subpath');
assert.deepEqual(resolveTarget('web//src', links), { name: 'web', exact: true, sub: 'src' }, 'repeated slashes collapse');
assert.deepEqual(resolveTarget('web/src/', links), { name: 'web', exact: true, sub: 'src/' }, 'subpath keeps its trailing slash');
assert.deepEqual(resolveTarget('my app/x', links), { name: 'my app', exact: true, sub: 'x' }, 'name with a space');
assert.deepEqual(resolveTarget('notes\\\\x', links), { name: 'notes', exact: true, sub: 'x' }, 'repeated backslashes');
assert.equal(resolveTarget('zz/src', links), null, 'unknown head -> null');
assert.equal(resolveTarget('toString/x', links), null, 'prototype head is not a shortcut');

// -- launcher setup: temp home before store.js loads, then fake child_process --
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'upex-edges-'));
process.env.HOME = process.env.USERPROFILE = home;
process.env.LOCALAPPDATA = process.env.ProgramFiles = process.env['ProgramFiles(x86)'] = home;
delete process.env.WEBSTORM_PATH;
fs.mkdirSync(path.join(home, '.upex'));
const configFile = path.join(home, '.upex', 'config.json');
const setConfig = (c = {}) => fs.writeFileSync(configFile, JSON.stringify(c));
setConfig();

const dir = path.join(home, 'my dir');
const file = path.join(dir, 'a.txt');
fs.mkdirSync(dir);
fs.writeFileSync(file, 'x');

// Commands found by `where`/`which`; everything else is recorded, nothing runs.
let installed = new Set();
let calls = [];
cp.execSync = (cmd, opts) => {
  const check = /^(?:where|which) (.+)$/.exec(cmd);
  if (check) {
    if (!installed.has(check[1])) throw new Error('not found');
    return '';
  }
  calls.push(['exec', cmd, opts]);
  return '';
};
cp.spawn = (cmd, args, opts) => (calls.push(['spawn', cmd, args, opts]), { unref() {} });
cp.spawnSync = (cmd, args, opts) => (calls.push(['spawnSync', cmd, args, opts]), {});
syncBuiltinESMExports();
// Bail before anything real could launch or touch the real ~/.upex.
const esm = await import('node:child_process');
assert.ok(['execSync', 'spawn', 'spawnSync'].every(k => esm[k] === cp[k]), 'child_process stubbed');
assert.equal(os.homedir(), home, 'home redirected');

// Fresh launcher.js per platform (it reads os.platform once at load).
const realPlatform = os.platform;
async function on(p) {
  os.platform = () => p;
  try {
    return await import(`../src/launcher.js?${p}`);
  } finally {
    os.platform = realPlatform;
  }
}

// launchApp with the given installed commands and config; returns result + recorded calls (opts dropped).
function run(L, have, config, ...args) {
  installed = new Set(have);
  setConfig(config);
  calls = [];
  const r = L.launchApp(...args);
  return { r, calls: calls.map(c => c.slice(0, -1)), opts: calls.map(c => c.at(-1)) };
}

try {
  // -- win32 --
  const W = await on('win32');
  assert.match(run(W, [], {}, 'nope', dir).r.message, /Unknown app "nope"/, 'win: unknown app');
  assert.equal(W.APP_MAP.explorer.displayName, 'Explorer', 'win: explorer name');

  let t = run(W, ['explorer'], {}, 'explorer', dir);
  assert.deepEqual(t.calls, [['spawn', 'explorer', [dir]]], 'win: explorer spawned without exit-code check');
  assert.equal(t.opts[0].detached, true, 'win: explorer detached');
  assert.deepEqual(run(W, ['explorer'], {}, 'explorer', file).calls, [['spawn', 'explorer', ['/select,', file]]], 'win: file is selected');

  t = run(W, [], {}, 'open', file);
  assert.deepEqual(t.calls, [['exec', `start "" "${file}"`]], 'win: start needs no where check');
  assert.equal(W.checkOpener('open').ok, true, 'win: doctor accepts the start builtin');

  assert.deepEqual(run(W, ['code'], {}, 'vscode', dir).calls, [['exec', `code "${dir}"`]], 'win: vscode');
  t = run(W, [], {}, 'vscode', dir);
  assert.equal(t.r.ok, false, 'win: missing command fails');
  assert.match(t.r.message, /Command "code" not found/, 'win: missing command named');
  assert.deepEqual(t.calls, [], 'win: nothing launched when missing');

  // Terminals: separate windows via start, count clamped to 1..9.
  t = run(W, ['cmd'], {}, 'cmd', dir, 3);
  assert.deepEqual(t.calls, Array(3).fill(['exec', 'start "" cmd']), 'win: 3 cmd windows');
  assert.equal(t.opts[0].cwd, dir, 'win: cmd window at the folder');
  assert.equal(run(W, ['cmd'], {}, 'cmd', dir, 20).calls.length, 9, 'win: count capped at 9');
  assert.equal(run(W, ['cmd'], {}, 'cmd', dir, 0).calls.length, 1, 'win: count 0 -> 1');
  assert.equal(run(W, ['cmd'], {}, 'cmd', dir, 'x').calls.length, 1, 'win: bad count -> 1');
  assert.equal(run(W, ['cmd'], {}, 'cmd', file).opts[0].cwd, dir, 'win: terminal at a file sits in its folder');
  assert.deepEqual(run(W, ['cmd'], {}, 'cmd', dir, 1, 'npm i && npm run dev').calls,
    [['exec', 'start "" cmd /s /k "npm i && npm run dev"']], 'win: start command kept in one quoted arg');
  t = run(W, ['cmd', 'claude'], {}, 'claude', dir, 1, '--resume');
  assert.deepEqual(t.calls, [['exec', 'start "" cmd /s /k "claude --resume"']], 'win: claude runs inside cmd');
  assert.equal(t.r.message, `Claude (--resume) --> ${dir}`, 'win: claude message');

  // Windows Terminal: one wt call for tabs/panes, one per window otherwise.
  const tabs = { terminalLayout: 'tabs' };
  t = run(W, ['cmd', 'wt'], tabs, 'cmd', dir, 2);
  assert.deepEqual(t.calls, [['spawnSync', 'wt', [W.wtCommandLine(dir, '', 2, 'tabs')]]], 'win: 2 tabs in one wt call');
  assert.equal(t.opts[0].windowsVerbatimArguments, true, 'win: wt gets its command line verbatim');
  assert.deepEqual(run(W, ['cmd', 'wt'], { terminalLayout: 'panes', paneSplit: 'vertical' }, 'cmd', dir, 2).calls,
    [['spawnSync', 'wt', [W.wtCommandLine(dir, '', 2, 'panes', 'cmd', 'vertical')]]], 'win: pane split setting reaches wt');
  t = run(W, ['cmd', 'wt'], { terminalShell: 'profile' }, 'cmd', dir, 2);
  assert.deepEqual(t.calls, Array(2).fill(['spawnSync', 'wt', [W.wtCommandLine(dir, '', 1, 'windows', 'profile')]]), 'win: profile shell, one wt per window');
  assert.deepEqual(run(W, ['cmd'], tabs, 'cmd', dir).calls, [['exec', 'start "" cmd']], 'win: tabs without wt fall back to start');
  assert.deepEqual(run(W, ['cmd'], { terminalShell: 'profile' }, 'cmd', dir).calls, [['exec', 'start "" cmd']], 'win: profile without wt -> cmd');
  t = run(W, ['cmd'], { terminalShell: 'pwsh' }, 'cmd', dir);
  assert.match(t.r.message, /Shell "pwsh" not found/, 'win: missing shell named');
  assert.deepEqual(t.calls, [], 'win: nothing launched for a missing shell');
  assert.deepEqual(run(W, ['cmd', 'pwsh'], { terminalShell: 'pwsh' }, 'cmd', dir).calls, [['exec', 'start "" pwsh']], 'win: pwsh window');
  assert.equal(W.hasWindowsTerminal(), false, 'win: wt checked on PATH');

  // WebStorm: PATH first, then config path (quoted when it has spaces).
  const ws = path.join(dir, 'webstorm64.exe');
  fs.writeFileSync(ws, '');
  t = run(W, [], { webstormPath: ws }, 'webstorm', dir);
  assert.deepEqual(t.calls, [['spawn', `"${ws}"`, [dir]]], 'win: webstorm from config path');
  assert.equal(t.opts[0].shell, true, 'win: webstorm via shell');
  assert.deepEqual(run(W, ['webstorm'], { webstormPath: ws }, 'webstorm', dir).calls, [['spawn', 'webstorm', [dir]]], 'win: PATH webstorm first');
  assert.match(run(W, [], {}, 'webstorm', dir).r.message, /WebStorm not found/, 'win: no webstorm anywhere');

  // Custom opener from config, copy, app shortcuts, URLs.
  t = run(W, ['cursor'], { apps: { Cursor: 'cursor' } }, 'cursor', dir);
  assert.deepEqual(t.calls, [['exec', `cursor "${dir}"`]], 'win: custom opener');
  assert.equal(t.r.displayName, 'Cursor', 'win: custom opener name');
  t = run(W, [], {}, 'copy', dir);
  assert.deepEqual(t.calls, [['exec', 'clip']], 'win: copy via clip');
  assert.deepEqual(t.opts[0].input, Buffer.from(dir, 'utf16le'), 'win: clip gets UTF-16LE');
  const bat = path.join(dir, 'run.bat');
  calls = [];
  W.launchExecutable(bat);
  assert.deepEqual(calls.map(c => c.slice(0, 3)), [['spawn', 'cmd.exe', ['/c', bat]]], 'win: .bat via cmd.exe');
  assert.equal(calls[0][3].cwd, dir, 'win: .bat runs in its folder');
  calls = [];
  W.launchExecutable(ws);
  assert.equal(calls[0][1], `"${ws}"`, 'win: exe with spaces quoted');
  calls = [];
  W.launchExecutable('code --new-window');
  assert.equal(calls[0][1], 'code --new-window', 'win: command line left as is');
  calls = [];
  W.launchUrl('github.com');
  assert.equal(calls[0][1], 'start "" "https://github.com"', 'win: url via start');

  // -- darwin --
  const D = await on('darwin');
  assert.equal(D.APP_MAP.explorer.displayName, 'Finder', 'mac: explorer is Finder');
  assert.equal(D.hasWindowsTerminal(), null, 'mac: no wt');
  assert.deepEqual(run(D, ['open'], {}, 'explorer', dir).calls, [['exec', `open "${dir}"`]], 'mac: folder in Finder');
  assert.deepEqual(run(D, ['open'], {}, 'explorer', file).calls, [['exec', `open -R "${file}"`]], 'mac: file revealed');
  assert.deepEqual(run(D, ['open'], {}, 'open', file).calls, [['exec', `open "${file}"`]], 'mac: default app');
  assert.deepEqual(run(D, ['open'], {}, 'webstorm', dir).calls, [['exec', `open -na "WebStorm" --args "${dir}"`]], 'mac: webstorm via open');
  t = run(D, ['open'], tabs, 'cmd', dir, 2, 'npm start');
  const script = `cd ${JSON.stringify(dir)} && npm start`;
  const osa = ['-e', 'tell application "Terminal" to do script ' + JSON.stringify(script), '-e', 'tell application "Terminal" to activate'];
  assert.deepEqual(t.calls, Array(2).fill(['spawnSync', 'osascript', osa]), 'mac: Terminal via osascript, wt settings ignored');
  t = run(D, [], {}, 'copy', dir);
  assert.deepEqual(t.calls, [['exec', 'pbcopy']], 'mac: copy via pbcopy');
  assert.equal(t.opts[0].env.LC_CTYPE, 'UTF-8', 'mac: pbcopy in UTF-8');
  calls = [];
  D.launchUrl('https://x.org');
  assert.equal(calls[0][1], 'open "https://x.org"', 'mac: url via open');

  // -- linux --
  const X = await on('linux');
  assert.equal(X.APP_MAP.explorer.displayName, 'File Manager', 'linux: explorer name');
  assert.deepEqual(run(X, ['xdg-open'], {}, 'explorer', dir).calls, [['exec', `xdg-open "${dir}"`]], 'linux: folder');
  assert.deepEqual(run(X, ['xdg-open'], {}, 'explorer', file).calls, [['exec', `xdg-open "${dir}"`]], 'linux: file opens its folder');
  assert.deepEqual(run(X, ['xdg-open'], {}, 'open', file).calls, [['exec', `xdg-open "${file}"`]], 'linux: default app');
  t = run(X, ['x-terminal-emulator'], {}, 'cmd', file, 1, 'make');
  const sh = `cd ${JSON.stringify(dir)}; make; exec "\${SHELL:-bash}"`;
  assert.deepEqual(t.calls, [['spawnSync', 'x-terminal-emulator', ['-e', 'sh', '-c', sh]]], 'linux: terminal runs the command, stays open');
  assert.match(run(X, [], {}, 'cmd', dir).r.message, /Command "x-terminal-emulator" not found/, 'linux: no terminal');
  const wayland = process.env.WAYLAND_DISPLAY;
  process.env.WAYLAND_DISPLAY = 'wayland-0';
  assert.deepEqual(run(X, ['wl-copy'], {}, 'copy', dir).calls, [['exec', 'wl-copy']], 'linux: wayland copy');
  assert.deepEqual(run(X, [], {}, 'copy', dir).calls, [['exec', 'xclip -selection clipboard']], 'linux: no wl-copy -> xclip');
  if (wayland === undefined) delete process.env.WAYLAND_DISPLAY;
  else process.env.WAYLAND_DISPLAY = wayland;
  calls = [];
  X.launchExecutable('/opt/run.bat');
  assert.deepEqual(calls.map(c => c.slice(0, 3)), [['spawn', '/opt/run.bat', []]], 'linux: .bat not via cmd.exe');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

console.log('ok - fuzzy edges + launcher win32/darwin/linux');
