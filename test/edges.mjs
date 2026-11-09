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
import { pathToFileURL } from 'node:url';

// Temp home before anything loads store.js (it captures ~/.upex at import).
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'upex-edges-'));
process.env.HOME = process.env.USERPROFILE = home;
process.env.LOCALAPPDATA = process.env.ProgramFiles = process.env['ProgramFiles(x86)'] = home;
delete process.env.WEBSTORM_PATH;
const { resolveName, resolveTarget } = await import('../src/fuzzy.js');
const { CONFIG_FILE } = await import('../src/store.js');
assert.ok(CONFIG_FILE.startsWith(home), 'store uses the temp home');

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
// Fuzzy setting from config.json; an unreadable one falls back to normal.
fs.writeFileSync(CONFIG_FILE, JSON.stringify({ fuzzy: 'exact' }));
assert.equal(resolveName('wbe', links), null, 'exact: no typos');
assert.deepEqual(resolveName('ote', links), { name: 'notes', exact: false }, 'exact: letters in a row still resolve');
assert.deepEqual(resolveName('app', { 'myapp-old': {}, app2: {} }), { name: 'app2', exact: false }, 'exact: the earliest match wins');
fs.writeFileSync(CONFIG_FILE, '{ broken');
assert.deepEqual(resolveName('wbe', links), { name: 'web', exact: false }, 'unreadable config: normal');
fs.writeFileSync(CONFIG_FILE, '{}');

// -- launcher setup: fake child_process --
fs.mkdirSync(path.join(home, '.upex'), { recursive: true });
const configFile = path.join(home, '.upex', 'config.json');
const setConfig = (c = {}) => fs.writeFileSync(configFile, JSON.stringify(c));
setConfig();

const dir = path.join(home, 'my dir');
const file = path.join(dir, 'a.txt');
fs.mkdirSync(dir);
fs.writeFileSync(file, 'x');

// Installed commands are empty executables in a temp bin dir, the only PATH entry. Launches are recorded, nothing runs.
// A new dir each time: Windows caches PATH listings per PATH value.
let bins = 0;
const install = (have) => {
  const bin = path.join(home, `bin${bins++}`);
  fs.mkdirSync(bin);
  for (const c of have) fs.writeFileSync(path.join(bin, c), '', { mode: 0o755 });
  process.env.PATH = bin;
};
for (const k of ['TERMINAL', 'XDG_CURRENT_DESKTOP', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'ZDOTDIR']) delete process.env[k];
let calls = [];
cp.execSync = (cmd, opts) => (calls.push(['exec', cmd, opts]), '');
const child = { unref() {}, on() { return this; } };
cp.spawn = (cmd, args, opts) => (calls.push(['spawn', cmd, args, opts]), child);
// sigint: Ctrl+C listeners while the last child ran.
let sigint = 0;
cp.spawnSync = (cmd, args, opts) => (sigint = process.listenerCount('SIGINT'), calls.push(['spawnSync', cmd, args, opts]), {});
// readClipboard: answers with `pasted`.
let pasted = [null, ''];
cp.execFile = (cmd, args, opts, cb) => (calls.push(['execFile', cmd, args, opts]), cb(...pasted), child);
syncBuiltinESMExports();
// Bail before anything real could launch or touch the real ~/.upex.
const esm = await import('node:child_process');
assert.ok(['execSync', 'spawn', 'spawnSync', 'execFile'].every(k => esm[k] === cp[k]), 'child_process stubbed');
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
  install(have);
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
  assert.equal(run(W, ['Code.CMD'], {}, 'vscode', dir).r.ok, true, 'win: PATHEXT match, any case');
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
  assert.deepEqual(t.calls, [['spawn', `"${ws}"`, [`"${dir}"`]]], 'win: webstorm from config path, folder quoted');
  assert.equal(t.opts[0].shell, true, 'win: webstorm via shell');
  assert.deepEqual(run(W, ['webstorm'], { webstormPath: ws }, 'webstorm', dir).calls, [['spawn', 'webstorm', [`"${dir}"`]]], 'win: PATH webstorm first');
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
  t = run(X, ['xdg-open'], {}, 'explorer', dir);
  assert.deepEqual(t.calls, [['spawn', 'xdg-open', [dir]]], 'linux: folder via xdg-open, no shell');
  assert.equal(t.opts[0].detached, true, 'linux: xdg-open detached');
  t = run(X, ['xdg-open'], {}, 'explorer', file);
  assert.equal(t.calls[0][1], 'dbus-send', 'linux: file selected over D-Bus first');
  assert.ok(t.calls[0][2].includes(`array:string:${pathToFileURL(file).href}`), 'linux: D-Bus gets the file URL');
  assert.deepEqual(t.calls[1], ['spawn', 'xdg-open', [dir]], 'linux: no file manager answers -> its folder');
  assert.deepEqual(run(X, ['xdg-open'], {}, 'open', file).calls, [['spawn', 'xdg-open', [file]]], 'linux: default app');
  assert.equal(run(X, [], {}, 'explorer', dir).r.ok, false, 'linux: no xdg-open fails');

  // Terminals: picked from what is installed, opened detached as separate windows.
  const win = { terminalLayout: 'windows' };
  t = run(X, ['xterm'], win, 'cmd', file, 2, 'make');
  const sh = `cd ${X.shQuote(dir)}; trap : INT; make; exec "\${SHELL:-bash}"`;
  assert.deepEqual(t.calls, Array(2).fill(['spawn', 'xterm', ['-e', 'sh', '-c', sh]]), 'linux: xterm runs the command, stays open');
  assert.equal(t.opts[0].cwd, dir, 'linux: terminal starts in the folder');
  assert.equal(X.shQuote("it's"), `'it'\\''s'`, 'linux: single quotes escaped');
  assert.equal(run(X, ['xterm', 'gnome-terminal'], win, 'cmd', dir).calls[0][1], 'gnome-terminal', 'linux: gnome-terminal before xterm');
  assert.deepEqual(run(X, ['gnome-terminal'], win, 'cmd', dir).calls[0][2].slice(0, 2), ['--', 'sh'], 'linux: gnome-terminal takes --');
  process.env.XDG_CURRENT_DESKTOP = 'KDE';
  assert.equal(run(X, ['gnome-terminal', 'konsole'], win, 'cmd', dir).calls[0][1], 'konsole', 'linux: the desktop terminal first');
  delete process.env.XDG_CURRENT_DESKTOP;
  process.env.TERMINAL = 'kitty';
  assert.deepEqual(run(X, ['konsole', 'kitty'], win, 'cmd', dir).calls[0].slice(1, 3), ['kitty', ['sh', '-c', `cd ${X.shQuote(dir)}; exec "\${SHELL:-bash}"`]], 'linux: $TERMINAL wins');
  delete process.env.TERMINAL;
  assert.match(run(X, [], win, 'cmd', dir).r.message, /No terminal found/, 'linux: no terminal');
  assert.match(run(X, [], {}, 'cmd', dir, 2).r.message, /No terminal found/, 'linux: here with 2 needs windows, none found');
  assert.match(run(X, ['claude'], win, 'claude', dir).r.message, /No terminal found/, 'linux: claude needs a terminal');
  t = run(X, ['xterm', 'claude'], win, 'claude', dir, 1, '--resume');
  assert.deepEqual(t.calls[0].slice(1, 2), ['xterm'], 'linux: claude in the terminal');
  assert.ok(t.calls[0][2].at(-1).includes('claude --resume;'), 'linux: claude runs there');

  // Opener row: only what is installed (a 'here' terminal needs no terminal app).
  install(['xdg-open']);
  setConfig({});
  assert.deepEqual(X.getInteractiveAppChoices().map(c => c.key), ['explorer', 'cmd'], 'linux: missing apps hidden');
  install(['xdg-open', 'code', 'claude']);
  setConfig({ apps: { Zed: 'zed' } });
  assert.deepEqual(X.getInteractiveAppChoices().map(c => c.key), ['explorer', 'vscode', 'cmd', 'claude', 'zed'], 'linux: installed apps and custom openers shown');
  setConfig(win);
  assert.deepEqual(X.getInteractiveAppChoices().map(c => c.key), ['explorer', 'vscode'], 'linux: windows layout without a terminal hides terminal openers');
  assert.equal(W.getInteractiveAppChoices().some(c => c.key === 'webstorm'), false, 'win: missing WebStorm hidden too');

  // WebStorm: Toolbox script, then Toolbox 2 apps dir; detached, no shell.
  const toolbox = path.join(home, '.local', 'share', 'JetBrains', 'Toolbox');
  const tb2 = path.join(toolbox, 'apps', 'webstorm', 'bin', 'webstorm.sh');
  fs.mkdirSync(path.dirname(tb2), { recursive: true });
  fs.writeFileSync(tb2, '');
  t = run(X, [], {}, 'webstorm', dir);
  assert.deepEqual(t.calls, [['spawn', tb2, [dir]]], 'linux: webstorm from Toolbox 2');
  assert.equal(t.opts[0].detached && !t.opts[0].shell, true, 'linux: webstorm detached, no shell');
  const tbScript = path.join(toolbox, 'scripts', 'webstorm');
  fs.mkdirSync(path.dirname(tbScript), { recursive: true });
  fs.writeFileSync(tbScript, '');
  assert.equal(run(X, [], {}, 'webstorm', dir).calls[0][1], tbScript, 'linux: Toolbox script first');
  assert.equal(run(X, ['webstorm'], {}, 'webstorm', dir).calls[0][1], 'webstorm', 'linux: PATH webstorm before Toolbox');
  fs.rmSync(path.join(home, '.local'), { recursive: true });
  assert.match(run(X, [], {}, 'webstorm', dir).r.message, /WebStorm not found/, 'linux: no webstorm anywhere');

  // Layout 'here': the shell runs in this terminal, only for a TTY caller that allows it.
  const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  try {
    install([]);
    setConfig({});
    let h = X.launchApp('cmd', file, 1, 'make', { here: true });
    assert.equal(h.ok && typeof h.inPlace, 'function', 'linux: here returns a deferred shell');
    calls = [];
    h.inPlace();
    assert.deepEqual(calls.map(c => c.slice(0, 3)), [['spawnSync', 'sh', ['-c', 'trap : INT; make; exec "${SHELL:-sh}"']]], 'linux: here runs the command, then the shell (Ctrl+C stops only the command)');
    assert.deepEqual([sigint, process.listenerCount('SIGINT')], [1, 0], 'here: upex survives Ctrl+C while the shell runs, guard removed after');
    assert.equal(calls[0][3].cwd, dir, 'linux: here at the folder');
    assert.equal(calls[0][3].stdio, 'inherit', 'linux: here owns this terminal');
    assert.equal(X.launchApp('cmd', dir, 1, '', {}).ok, false, 'linux: batch callers get windows, here not allowed');
    install(['cmd']);
    h = W.launchApp('cmd', dir, 1, 'a && b', { here: true });
    calls = [];
    h.inPlace();
    assert.deepEqual(calls.map(c => c.slice(0, 3)), [['spawnSync', 'cmd', ['/s /k "a && b"']]], 'win: here runs cmd /k in place');
    assert.equal(calls[0][3].windowsVerbatimArguments, true, 'win: here command line verbatim');
    assert.equal(W.launchApp('cmd', dir, 2, '', { here: true }).inPlace, undefined, 'win: two terminals get windows');
  } finally {
    if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
    else delete process.stdin.isTTY;
  }

  const wayland = process.env.WAYLAND_DISPLAY;
  process.env.WAYLAND_DISPLAY = 'wayland-0';
  assert.deepEqual(run(X, ['wl-copy'], {}, 'copy', dir).calls, [['exec', 'wl-copy']], 'linux: wayland copy');
  assert.deepEqual(run(X, ['xclip'], {}, 'copy', dir).calls, [['exec', 'xclip -selection clipboard']], 'linux: no wl-copy -> xclip');
  delete process.env.WAYLAND_DISPLAY;
  assert.deepEqual(run(X, ['wl-copy', 'xsel'], {}, 'copy', dir).calls, [['exec', 'xsel --clipboard --input']], 'linux: X11 skips wl-copy, xsel works');
  assert.match(run(X, [], {}, 'copy', dir).r.message, /no clipboard tool/, 'linux: no clipboard tool named');

  // Paste: the platform's tool, '' when it fails or none is installed.
  const paste = async (L, have, answer = [null, 'x']) => {
    install(have);
    calls = [];
    pasted = answer;
    return [await L.readClipboard(), ...calls.map(c => c[1])];
  };
  assert.deepEqual(await paste(W, []), ['x', 'powershell.exe'], 'win: paste via powershell');
  assert.deepEqual(await paste(W, [], [new Error('timeout'), '']), ['', 'powershell.exe'], 'paste failure: empty');
  assert.deepEqual(await paste(D, []), ['x', 'pbpaste'], 'mac: paste via pbpaste');
  process.env.WAYLAND_DISPLAY = 'wayland-0';
  assert.deepEqual(await paste(X, ['wl-paste', 'xclip']), ['x', 'wl-paste'], 'linux: wayland paste');
  assert.deepEqual(await paste(X, ['xclip']), ['x', 'xclip'], 'linux: no wl-paste -> xclip');
  delete process.env.WAYLAND_DISPLAY;
  assert.deepEqual(await paste(X, ['wl-paste', 'xsel']), ['x', 'xsel'], 'linux: X11 skips wl-paste, xsel works');
  assert.deepEqual(await paste(X, []), [''], 'linux: no paste tool, empty');
  if (wayland !== undefined) process.env.WAYLAND_DISPLAY = wayland;

  // Shell setup: one upex block, replaced in place; a hand-added function is left alone.
  const { withBlock, installShell, rcFile } = await import('../src/commands/setup.js');
  const once = withBlock('alias x=y\n');
  assert.ok(once.startsWith('alias x=y\n\n# >>> upex') && once.includes('__resolve'), 'setup: block appended');
  assert.equal(withBlock(once.replace('__resolve', '__old')), once, 'setup: block replaced, not doubled');
  assert.equal(withBlock(`${once}export A=1\n`), `${once}export A=1\n`, 'setup: text after the block kept');
  assert.equal(installShell('zsh', home).file, path.join(home, '.zshrc'), 'setup: zsh -> ~/.zshrc');
  assert.equal(installShell('zsh', home).kept, undefined, 'setup: rerun updates its own block');
  fs.writeFileSync(path.join(home, '.bashrc'), 'upex() { command upex __resolve "$1"; }\n');
  assert.equal(installShell('bash', home).kept, true, 'setup: hand-added function kept');
  assert.ok(fs.readFileSync(installShell('fish', home).file, 'utf-8').startsWith('function upex'), 'setup: fish function file');
  assert.equal(rcFile('fish', home), path.join(home, '.config', 'fish', 'functions', 'upex.fish'), 'setup: fish autoload path');
  calls = [];
  X.launchExecutable('/opt/run.bat');
  assert.deepEqual(calls.map(c => c.slice(0, 3)), [['spawn', '/opt/run.bat', []]], 'linux: .bat not via cmd.exe');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

console.log('ok - fuzzy edges + launcher win32/darwin/linux');
